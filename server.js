const express = require('express');
const Database = require('better-sqlite3');
const QRCode = require('qrcode');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const gdrive = require('./gdrive');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PHOTOS_DIR = path.join(DATA_DIR, 'photos');
const PORT = process.env.PORT || 3000;

fs.mkdirSync(PHOTOS_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'matterqr.db'));
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS devices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    qr_content TEXT NOT NULL,
    device_name TEXT NOT NULL,
    device_details TEXT,
    room TEXT,
    notes TEXT,
    photo_filename TEXT,
    manual_pairing_code TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT
  );
`);
// Migrations for DBs created before these columns existed.
const existingCols = db.prepare('PRAGMA table_info(devices)').all().map((c) => c.name);
if (!existingCols.includes('manual_pairing_code')) {
  db.exec('ALTER TABLE devices ADD COLUMN manual_pairing_code TEXT');
}
if (!existingCols.includes('device_details')) {
  db.exec('ALTER TABLE devices ADD COLUMN device_details TEXT');
}
if (!existingCols.includes('pairings')) {
  db.exec('ALTER TABLE devices ADD COLUMN pairings TEXT');
}

// Smart-home systems a device has been added to (Matter multi-admin, or a
// bridge). Stored as a JSON array on the device row:
// [{ system, code, date, notes }] — all strings, all but system optional.
const MAX_PAIRINGS = 20;
const MAX_PAIRING_FIELD = 200;

function cleanPairings(input) {
  if (!Array.isArray(input)) return [];
  return input
    .filter((p) => p && typeof p === 'object')
    .map((p) => {
      const field = (v) => (typeof v === 'string' ? v.trim().slice(0, MAX_PAIRING_FIELD) : '');
      return { system: field(p.system), code: field(p.code), date: field(p.date), notes: field(p.notes) };
    })
    .filter((p) => p.system)
    .slice(0, MAX_PAIRINGS);
}

function parsePairings(text) {
  if (!text) return [];
  try {
    return cleanPairings(JSON.parse(text));
  } catch (err) {
    return [];
  }
}

// Built-in device details options, always offered in the dropdown even
// before any device has used them. Anything a user types that isn't in
// this list is retained too, once at least one saved device uses it —
// see GET /api/device-details below.
const BUILTIN_DEVICE_DETAILS = [
  'KAJPLATS E27 470lm clr',
  'KAJPLATS E27 470lm opq',
  'BILRESA 2 btn remote',
  'BILRESA scroll remote',
  'SONOFF mini switch',
];

const app = express();
app.use(express.json({ limit: '8mb' }));

app.get('/healthz', (req, res) => res.status(200).send('ok'));

function rowToDevice(row) {
  return {
    id: row.id,
    qrContent: row.qr_content,
    deviceName: row.device_name,
    deviceDetails: row.device_details,
    room: row.room,
    notes: row.notes,
    manualPairingCode: row.manual_pairing_code,
    pairings: parsePairings(row.pairings),
    photoUrl: row.photo_filename ? `/photos/${row.photo_filename}` : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// Accepts a data: URL (e.g. "data:image/jpeg;base64,...."), writes it to disk,
// and returns the generated filename. Returns null if no photo was given.
function savePhoto(dataUrl) {
  if (!dataUrl) return null;
  const match = /^data:image\/(png|jpe?g|webp);base64,(.+)$/.exec(dataUrl);
  if (!match) return null;
  const ext = match[1] === 'jpg' ? 'jpeg' : match[1];
  const filename = `${crypto.randomUUID()}.${ext}`;
  fs.writeFileSync(path.join(PHOTOS_DIR, filename), Buffer.from(match[2], 'base64'));
  return filename;
}

function deletePhoto(filename) {
  if (!filename) return;
  const p = path.join(PHOTOS_DIR, filename);
  fs.rm(p, { force: true }, () => {});
}

app.get('/api/devices', (req, res) => {
  const rows = db.prepare('SELECT * FROM devices ORDER BY created_at DESC').all();
  res.json(rows.map(rowToDevice));
});

// Device details dropdown options: built-ins unioned with whatever's
// actually been used, so anything a user types gets retained going forward.
app.get('/api/device-details', (req, res) => {
  const used = db.prepare(`
    SELECT DISTINCT device_details FROM devices
    WHERE device_details IS NOT NULL AND device_details != ''
  `).all().map((r) => r.device_details);
  const options = [...new Set([...BUILTIN_DEVICE_DETAILS, ...used])].sort();
  res.json(options);
});

app.post('/api/devices', (req, res) => {
  const { qrContent, deviceName, deviceDetails, room, notes, manualPairingCode, photoDataUrl, pairings } = req.body || {};
  if (!qrContent && !manualPairingCode) {
    return res.status(400).json({ error: 'either qrContent or manualPairingCode is required' });
  }
  const photoFilename = savePhoto(photoDataUrl);
  const info = db.prepare(`
    INSERT INTO devices (qr_content, device_name, device_details, room, notes, manual_pairing_code, photo_filename, pairings)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(qrContent || '', deviceName || 'Unnamed device', deviceDetails || null, room || null, notes || null, manualPairingCode || null, photoFilename, JSON.stringify(cleanPairings(pairings)));
  const row = db.prepare('SELECT * FROM devices WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json(rowToDevice(row));
  gdrive.runBackup(db, DATA_DIR).catch((err) => console.error('Drive backup failed:', err.message));
});

app.put('/api/devices/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM devices WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'not found' });

  const { qrContent, deviceName, deviceDetails, room, notes, manualPairingCode, photoDataUrl, removePhoto, pairings } = req.body || {};
  if (!qrContent && !manualPairingCode) {
    return res.status(400).json({ error: 'either qrContent or manualPairingCode is required' });
  }

  let photoFilename = existing.photo_filename;
  if (photoDataUrl) {
    deletePhoto(existing.photo_filename);
    photoFilename = savePhoto(photoDataUrl);
  } else if (removePhoto) {
    deletePhoto(existing.photo_filename);
    photoFilename = null;
  }

  // A client that doesn't send pairings (e.g. an older cached page) keeps
  // whatever is already stored rather than wiping it.
  const pairingsJson = pairings === undefined ? existing.pairings : JSON.stringify(cleanPairings(pairings));

  db.prepare(`
    UPDATE devices
    SET qr_content = ?, device_name = ?, device_details = ?, room = ?, notes = ?, manual_pairing_code = ?, photo_filename = ?,
        pairings = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id = ?
  `).run(qrContent || '', deviceName || 'Unnamed device', deviceDetails || null, room || null, notes || null, manualPairingCode || null, photoFilename, pairingsJson, req.params.id);

  const row = db.prepare('SELECT * FROM devices WHERE id = ?').get(req.params.id);
  res.json(rowToDevice(row));
});

app.delete('/api/devices/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM devices WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'not found' });
  deletePhoto(existing.photo_filename);
  db.prepare('DELETE FROM devices WHERE id = ?').run(req.params.id);
  res.status(204).end();
});

app.get('/api/devices/:id/qr.png', async (req, res) => {
  const row = db.prepare('SELECT qr_content FROM devices WHERE id = ?').get(req.params.id);
  if (!row || !row.qr_content) return res.status(404).end();
  try {
    const buf = await QRCode.toBuffer(row.qr_content, { type: 'png', width: 320, margin: 2 });
    res.type('png').send(buf);
  } catch (err) {
    res.status(500).json({ error: 'Could not render QR code' });
  }
});

app.get('/api/backup/status', (req, res) => {
  const configured = gdrive.isConfigured();
  res.json({ configured, connected: configured && gdrive.isDriveConnected(DATA_DIR) });
});

app.post('/api/backup/run', async (req, res) => {
  try {
    const result = await gdrive.runBackup(db, DATA_DIR);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/oauth/google/start', (req, res) => {
  try {
    res.redirect(gdrive.getAuthUrl());
  } catch (err) {
    res.status(500).send(`Google OAuth is not configured: ${err.message}`);
  }
});

app.get('/oauth/google/callback', async (req, res) => {
  try {
    if (!req.query.code) throw new Error('missing code');
    await gdrive.handleOAuthCallback(DATA_DIR, req.query.code);
    res.redirect('/?gdrive=connected');
  } catch (err) {
    console.error('Google OAuth callback failed:', err.message);
    res.redirect('/?gdrive=error');
  }
});

app.use('/photos', express.static(PHOTOS_DIR, { maxAge: '30d' }));
app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
  console.log(`matterqr listening on :${PORT}, data dir ${DATA_DIR}`);
});
