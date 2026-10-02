const fs = require('fs');
const path = require('path');
const archiver = require('archiver');
const { google } = require('googleapis');

const BACKUP_FOLDER_NAME = 'MatterQR Backups';
const MAX_BACKUPS_TO_KEEP = 20;

function tokenPath(dataDir) {
  return path.join(dataDir, 'gdrive_token.json');
}

function isDriveConnected(dataDir) {
  return fs.existsSync(tokenPath(dataDir));
}

function loadTokens(dataDir) {
  return JSON.parse(fs.readFileSync(tokenPath(dataDir), 'utf8'));
}

function saveTokens(dataDir, tokens) {
  fs.writeFileSync(tokenPath(dataDir), JSON.stringify(tokens), { mode: 0o600 });
}

// The client secret can come from GOOGLE_CLIENT_SECRET directly, or from a
// file named by GOOGLE_CLIENT_SECRET_FILE (e.g. a Docker secret).
function readClientSecret() {
  if (process.env.GOOGLE_CLIENT_SECRET) return process.env.GOOGLE_CLIENT_SECRET.trim();
  const file = process.env.GOOGLE_CLIENT_SECRET_FILE;
  if (file && fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim();
  return '';
}

// Drive backup is optional: it's only offered when all three settings exist.
function isConfigured() {
  return Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_OAUTH_REDIRECT_URI && readClientSecret());
}

function getOAuthClient() {
  if (!isConfigured()) {
    throw new Error('Google OAuth is not configured (set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET or GOOGLE_CLIENT_SECRET_FILE, and GOOGLE_OAUTH_REDIRECT_URI)');
  }
  return new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, readClientSecret(), process.env.GOOGLE_OAUTH_REDIRECT_URI);
}

function getAuthUrl() {
  const client = getOAuthClient();
  return client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent', // force a refresh_token even if this Google account has authorized before
    scope: ['https://www.googleapis.com/auth/drive.file'],
  });
}

async function handleOAuthCallback(dataDir, code) {
  const client = getOAuthClient();
  const { tokens } = await client.getToken(code);
  saveTokens(dataDir, tokens);
}

async function getAuthedClient(dataDir) {
  const client = getOAuthClient();
  client.setCredentials(loadTokens(dataDir));
  // googleapis silently refreshes the access token using the refresh_token;
  // persist whatever it hands back so the refresh_token itself is never lost.
  client.on('tokens', (tokens) => {
    const existing = loadTokens(dataDir);
    saveTokens(dataDir, { ...existing, ...tokens });
  });
  return client;
}

async function findOrCreateBackupFolder(drive) {
  const res = await drive.files.list({
    q: `name='${BACKUP_FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    fields: 'files(id,name)',
    spaces: 'drive',
  });
  if (res.data.files && res.data.files.length) return res.data.files[0].id;
  const folder = await drive.files.create({
    requestBody: { name: BACKUP_FOLDER_NAME, mimeType: 'application/vnd.google-apps.folder' },
    fields: 'id',
  });
  return folder.data.id;
}

function buildBackupArchive(dataDir) {
  return new Promise((resolve, reject) => {
    const zipPath = path.join(dataDir, `.backup-${Date.now()}.zip`);
    const output = fs.createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 9 } });
    output.on('close', () => resolve(zipPath));
    archive.on('error', reject);
    archive.pipe(output);
    const dbPath = path.join(dataDir, 'matterqr.db');
    if (fs.existsSync(dbPath)) archive.file(dbPath, { name: 'matterqr.db' });
    const photosDir = path.join(dataDir, 'photos');
    if (fs.existsSync(photosDir)) archive.directory(photosDir, 'photos');
    archive.finalize();
  });
}

async function pruneOldBackups(drive, folderId) {
  const res = await drive.files.list({
    q: `'${folderId}' in parents and trashed=false`,
    fields: 'files(id,name,createdTime)',
    orderBy: 'createdTime desc',
    pageSize: 100,
  });
  const files = res.data.files || [];
  const toDelete = files.slice(MAX_BACKUPS_TO_KEEP);
  await Promise.all(toDelete.map((f) => drive.files.delete({ fileId: f.id }).catch(() => {})));
}

let backupInFlight = null;

// De-duped: if a backup is already running (e.g. several devices scanned in
// quick succession each triggering one), later callers just await the same
// in-flight run instead of piling up parallel uploads.
function runBackup(db, dataDir) {
  if (!isConfigured()) return Promise.resolve({ skipped: true, reason: 'not_configured' });
  if (!isDriveConnected(dataDir)) return Promise.resolve({ skipped: true, reason: 'not_connected' });
  if (backupInFlight) return backupInFlight;

  backupInFlight = (async () => {
    db.pragma('wal_checkpoint(TRUNCATE)'); // fold the WAL in so the copied .db file is self-contained
    const zipPath = await buildBackupArchive(dataDir);
    try {
      const client = await getAuthedClient(dataDir);
      const drive = google.drive({ version: 'v3', auth: client });
      const folderId = await findOrCreateBackupFolder(drive);
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      await drive.files.create({
        requestBody: { name: `matterqr-backup-${stamp}.zip`, parents: [folderId] },
        media: { mimeType: 'application/zip', body: fs.createReadStream(zipPath) },
      });
      await pruneOldBackups(drive, folderId);
      return { ok: true };
    } finally {
      fs.rm(zipPath, { force: true }, () => {});
    }
  })();

  backupInFlight.finally(() => { backupInFlight = null; });
  return backupInFlight;
}

module.exports = { isConfigured, isDriveConnected, getAuthUrl, handleOAuthCallback, runBackup };
