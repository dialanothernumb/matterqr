(() => {
  const backupStatus = document.getElementById('backup-status');
  const backupConnectLink = document.getElementById('backup-connect-link');
  const backupNowBtn = document.getElementById('backup-now-btn');

  const scanBtn = document.getElementById('scan-btn');
  const manualBtn = document.getElementById('manual-btn');
  const cameraWrap = document.getElementById('camera-wrap');
  const video = document.getElementById('camera');
  const canvas = document.getElementById('camera-canvas');
  const cancelScanBtn = document.getElementById('cancel-scan-btn');
  const torchBtn = document.getElementById('torch-btn');
  const zoomInBtn = document.getElementById('zoom-in-btn');
  const zoomOutBtn = document.getElementById('zoom-out-btn');

  const formSection = document.getElementById('form-section');
  const formTitle = document.getElementById('form-title');
  const autosaveStatus = document.getElementById('autosave-status');
  const qrField = document.getElementById('qr-field');
  const fQr = document.getElementById('f-qr');
  const fCode = document.getElementById('f-code');
  const fName = document.getElementById('f-name');
  const fNameSelect = document.getElementById('f-name-select');
  const fNameBack = document.getElementById('f-name-back');
  const fDetails = document.getElementById('f-details');
  const fDetailsSelect = document.getElementById('f-details-select');
  const fDetailsBack = document.getElementById('f-details-back');
  const fRoom = document.getElementById('f-room');
  const fRoomSelect = document.getElementById('f-room-select');
  const fRoomBack = document.getElementById('f-room-back');
  const fNotes = document.getElementById('f-notes');
  const pairingsList = document.getElementById('pairings-list');
  const addPairingBtn = document.getElementById('add-pairing-btn');
  const systemOptions = document.getElementById('system-options');
  const fPhoto = document.getElementById('f-photo');
  const fPhotoPreview = document.getElementById('f-photo-preview');
  const fPhotoRemove = document.getElementById('f-photo-remove');
  const saveBtn = document.getElementById('save-btn');
  const cancelFormBtn = document.getElementById('cancel-form-btn');
  const deleteBtn = document.getElementById('delete-btn');

  const qrModal = document.getElementById('qr-modal');
  const qrModalTitle = document.getElementById('qr-modal-title');
  const qrModalImg = document.getElementById('qr-modal-img');
  const qrModalClose = document.getElementById('qr-modal-close');

  const themeButtons = document.querySelectorAll('[data-theme-mode]');
  const deviceList = document.getElementById('device-list');
  const emptyState = document.getElementById('empty-state');
  const countBadge = document.getElementById('count-badge');
  const filterInput = document.getElementById('filter-input');
  const printRoomSelect = document.getElementById('print-room-select');
  const printBtn = document.getElementById('print-btn');
  const printArea = document.getElementById('print-area');

  let stream = null;
  let scanRAF = null;
  let torchTrack = null;
  let torchOn = false;
  let zoomTrack = null;
  let zoomCaps = null; // { min, max, step }
  let zoomValue = null;
  let editingId = null;
  let isNewEntry = false; // true while the open form is for a device not yet persisted at open time
  let manualCodeAutosaveTimer = null;
  let pendingPhotoDataUrl = null; // set when a new photo was chosen; null = keep/no photo
  let photoRemoved = false;
  let allDevices = [];
  let deviceDetailOptions = []; // built-ins ∪ used values, from GET /api/device-details

  const ADD_NEW = '__add_new__';

  // ---------- Backup ----------

  async function refreshBackupStatus() {
    try {
      const res = await fetch('/api/backup/status');
      const { configured, connected } = await res.json();
      document.getElementById('backup-section').classList.toggle('hidden', configured === false);
      backupStatus.textContent = connected
        ? 'Connected — backs up automatically whenever a device is added.'
        : 'Not connected.';
      backupConnectLink.classList.toggle('hidden', connected);
      backupNowBtn.classList.toggle('hidden', !connected);
    } catch (err) {
      backupStatus.textContent = 'Could not check backup status.';
    }
  }

  backupNowBtn.addEventListener('click', async () => {
    backupNowBtn.disabled = true;
    backupNowBtn.textContent = 'Backing up…';
    try {
      const res = await fetch('/api/backup/run', { method: 'POST' });
      const result = await res.json();
      if (!res.ok) throw new Error(result.error || res.statusText);
      backupStatus.textContent = `Backed up just now (${new Date().toLocaleTimeString()}).`;
    } catch (err) {
      alert('Backup failed: ' + err.message);
    } finally {
      backupNowBtn.disabled = false;
      backupNowBtn.textContent = 'Backup now';
    }
  });

  function handleOAuthRedirect() {
    const params = new URLSearchParams(window.location.search);
    const gdrive = params.get('gdrive');
    if (!gdrive) return;
    if (gdrive === 'connected') alert('Google Drive connected — backups will now run automatically.');
    if (gdrive === 'error') alert('Could not connect Google Drive. Check the server logs.');
    params.delete('gdrive');
    const rest = params.toString();
    window.history.replaceState({}, '', window.location.pathname + (rest ? `?${rest}` : ''));
  }

  handleOAuthRedirect();
  refreshBackupStatus();

  // ---------- Scanning ----------

  // Crop fraction must roughly match the .reticle CSS box (72%) so the
  // decode region lines up with what the user sees framed on screen.
  const RETICLE_FRACTION = 0.72;
  const JSQR_MAX_DECODE_SIZE = 1000; // cap so getImageData/jsQR stays fast on high-res streams

  async function detectorSupportsQr() {
    if (!('BarcodeDetector' in window)) return false;
    try {
      const formats = await BarcodeDetector.getSupportedFormats();
      return formats.includes('qr_code');
    } catch (err) {
      return false;
    }
  }

  async function setupTrackTuning(track) {
    try {
      await track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] });
    } catch (err) {
      // Not all browsers/cameras support explicit focus-mode constraints — fine, default focus applies.
    }
    const caps = track.getCapabilities ? track.getCapabilities() : {};
    if (caps.torch) {
      torchTrack = track;
      torchOn = false;
      torchBtn.textContent = '🔦 Torch';
      torchBtn.classList.remove('hidden');
    } else {
      torchTrack = null;
      torchBtn.classList.add('hidden');
    }

    // Zoom: mainly useful on phones (notably iOS Safari, which has no
    // BarcodeDetector) where the lens can't focus as close as the Apple
    // Home / IKEA apps manage — zooming in fills the reticle with more of
    // the dense Matter QR pattern without needing to get physically closer
    // than the lens's minimum focus distance.
    if (caps.zoom && caps.zoom.max > caps.zoom.min) {
      zoomTrack = track;
      zoomCaps = {
        min: caps.zoom.min,
        max: caps.zoom.max,
        step: caps.zoom.step || (caps.zoom.max - caps.zoom.min) / 10,
      };
      zoomValue = track.getSettings ? (track.getSettings().zoom || zoomCaps.min) : zoomCaps.min;
      zoomInBtn.classList.remove('hidden');
      zoomOutBtn.classList.remove('hidden');
    } else {
      zoomTrack = null;
      zoomCaps = null;
      zoomInBtn.classList.add('hidden');
      zoomOutBtn.classList.add('hidden');
    }
  }

  async function adjustZoom(delta) {
    if (!zoomTrack || !zoomCaps) return;
    const next = Math.min(zoomCaps.max, Math.max(zoomCaps.min, zoomValue + delta));
    try {
      await zoomTrack.applyConstraints({ advanced: [{ zoom: next }] });
      zoomValue = next;
    } catch (err) {
      // Ignore — zoom just won't visibly change.
    }
  }

  torchBtn.addEventListener('click', async () => {
    if (!torchTrack) return;
    const next = !torchOn;
    try {
      await torchTrack.applyConstraints({ advanced: [{ torch: next }] });
      torchOn = next;
      torchBtn.textContent = torchOn ? '🔦 Torch on' : '🔦 Torch';
    } catch (err) {
      // Ignore — torch toggle just won't visibly change.
    }
  });

  zoomInBtn.addEventListener('click', () => adjustZoom(zoomCaps ? zoomCaps.step * 2 : 0));
  zoomOutBtn.addEventListener('click', () => adjustZoom(zoomCaps ? -zoomCaps.step * 2 : 0));

  async function startScan() {
    fQr.value = '';
    cameraWrap.classList.remove('hidden');
    scanBtn.classList.add('hidden');
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 1920 },
          height: { ideal: 1080 },
        },
        audio: false,
      });
      video.srcObject = stream;
      await video.play();

      const [track] = stream.getVideoTracks();
      await setupTrackTuning(track);

      if (await detectorSupportsQr()) {
        scanWithBarcodeDetector();
      } else {
        scanWithJsQR();
      }
    } catch (err) {
      alert('Could not access camera: ' + err.message);
      stopScan();
    }
  }

  // Native OS-level decoder (what the platform's own camera/Home apps use) —
  // far faster and more reliable than a JS decoder when available.
  function scanWithBarcodeDetector() {
    const detector = new BarcodeDetector({ formats: ['qr_code'] });
    let consecutiveErrors = 0;
    const loop = async () => {
      if (!stream) return;
      try {
        const codes = await detector.detect(video);
        consecutiveErrors = 0;
        if (codes && codes.length) {
          onScanned(codes[0].rawValue);
          return;
        }
      } catch (err) {
        consecutiveErrors += 1;
        if (consecutiveErrors > 5) {
          // Detector claimed support but isn't actually working — fall back.
          scanWithJsQR();
          return;
        }
      }
      scanRAF = requestAnimationFrame(loop);
    };
    scanRAF = requestAnimationFrame(loop);
  }

  // Fallback JS decoder: crop to the centered reticle square (matches what's
  // visually framed) and downscale before decoding, so each attempt stays
  // fast even on a high-resolution camera stream; alternates a normal and
  // color-inverted pass across frames to also catch light-on-dark labels.
  function scanWithJsQR() {
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    let invertNext = false;
    const tick = () => {
      if (!stream) return;
      if (video.readyState === video.HAVE_ENOUGH_DATA) {
        const vw = video.videoWidth;
        const vh = video.videoHeight;
        const cropSize = Math.floor(Math.min(vw, vh) * RETICLE_FRACTION);
        const sx = Math.floor((vw - cropSize) / 2);
        const sy = Math.floor((vh - cropSize) / 2);
        const outSize = Math.min(cropSize, JSQR_MAX_DECODE_SIZE);
        canvas.width = outSize;
        canvas.height = outSize;
        ctx.drawImage(video, sx, sy, cropSize, cropSize, 0, 0, outSize, outSize);
        const imageData = ctx.getImageData(0, 0, outSize, outSize);
        invertNext = !invertNext;
        const code = jsQR(imageData.data, imageData.width, imageData.height, {
          inversionAttempts: invertNext ? 'onlyInvert' : 'dontInvert',
        });
        if (code && code.data) {
          onScanned(code.data);
          return;
        }
      }
      scanRAF = requestAnimationFrame(tick);
    };
    scanRAF = requestAnimationFrame(tick);
  }

  function stopScan() {
    if (scanRAF) cancelAnimationFrame(scanRAF);
    scanRAF = null;
    if (stream) {
      stream.getTracks().forEach((t) => t.stop());
      stream = null;
    }
    torchTrack = null;
    torchOn = false;
    torchBtn.classList.add('hidden');
    zoomTrack = null;
    zoomCaps = null;
    zoomValue = null;
    zoomInBtn.classList.add('hidden');
    zoomOutBtn.classList.add('hidden');
    cameraWrap.classList.add('hidden');
    scanBtn.classList.remove('hidden');
  }

  async function onScanned(text) {
    if (navigator.vibrate) navigator.vibrate(80);
    stopScan();
    const existing = allDevices.find((d) => d.qrContent === text);
    if (existing) {
      alert(
        `This QR code is already saved as "${existing.deviceName}"`
        + `${existing.room ? ` (${existing.room})` : ''} — opening that entry`
        + ' instead of creating a duplicate.',
      );
      openForm(existing);
      return;
    }
    openForm({ qrContent: text });
    await autosaveDraft();
  }

  scanBtn.addEventListener('click', startScan);
  cancelScanBtn.addEventListener('click', stopScan);
  manualBtn.addEventListener('click', () => openForm({}, { manual: true }));

  // ---------- Theme ----------

  function syncThemeButtons() {
    const mode = window.matterqrTheme ? window.matterqrTheme.get() : 'auto';
    themeButtons.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.themeMode === mode)));
  }
  themeButtons.forEach((b) => b.addEventListener('click', () => {
    if (window.matterqrTheme) window.matterqrTheme.set(b.dataset.themeMode);
    syncThemeButtons();
  }));
  syncThemeButtons();

  // ---------- Paired with ----------

  const BUILTIN_SYSTEMS = [
    'Apple Home', 'Google Home', 'Amazon Alexa', 'SmartThings', 'Home Assistant',
    'IKEA Home smart', 'Aqara Home', 'Philips Hue', 'Homey', 'Hubitat',
  ];

  function systemNames() {
    const used = allDevices.flatMap((d) => (d.pairings || []).map((p) => p.system));
    return [...new Set([...BUILTIN_SYSTEMS, ...used].filter(Boolean))].sort();
  }

  function todayIso() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  function addPairingRow(p) {
    const row = document.createElement('div');
    row.className = 'pairing-entry';
    row.innerHTML = `
      <input class="p-system" type="text" list="system-options" placeholder="System, e.g. Apple Home" aria-label="System">
      <input class="p-date" type="date" aria-label="Date added">
      <input class="p-code" type="text" placeholder="Code (optional)" aria-label="Code">
      <input class="p-notes" type="text" placeholder="Notes (optional)" aria-label="Notes">
      <button type="button" class="btn ghost small p-remove">Remove</button>
    `;
    row.querySelector('.p-system').value = p.system || '';
    row.querySelector('.p-date').value = p.date || '';
    row.querySelector('.p-code').value = p.code || '';
    row.querySelector('.p-notes').value = p.notes || '';
    row.querySelector('.p-remove').addEventListener('click', () => row.remove());
    pairingsList.appendChild(row);
    return row;
  }

  function setPairings(pairings) {
    systemOptions.innerHTML = systemNames().map((n) => `<option value="${escapeHtml(n)}"></option>`).join('');
    pairingsList.innerHTML = '';
    (pairings || []).forEach(addPairingRow);
  }

  function readPairings() {
    return [...pairingsList.querySelectorAll('.pairing-entry')].map((row) => ({
      system: row.querySelector('.p-system').value.trim(),
      date: row.querySelector('.p-date').value,
      code: row.querySelector('.p-code').value.trim(),
      notes: row.querySelector('.p-notes').value.trim(),
    })).filter((p) => p.system);
  }

  addPairingBtn.addEventListener('click', () => {
    addPairingRow({ date: todayIso() }).querySelector('.p-system').focus();
  });

  // ---------- Form ----------

  // Strict dropdown + "add new" pattern shared by Device name/details/Room:
  // defaults to picking an exact existing value (to keep naming consistent
  // across devices), with an explicit escape hatch to type something new.
  function setupDropdownField(select, input, backBtn, getOptions) {
    function showSelect(value) {
      select.classList.remove('hidden');
      input.classList.add('hidden');
      backBtn.classList.add('hidden');
      select.value = value || '';
    }
    function showInput(value) {
      select.classList.add('hidden');
      input.classList.remove('hidden');
      backBtn.classList.remove('hidden');
      input.value = value || '';
    }

    select.addEventListener('change', () => {
      if (select.value === ADD_NEW) {
        showInput('');
        input.focus();
      } else {
        input.value = select.value;
      }
    });

    backBtn.addEventListener('click', () => {
      showSelect('');
      input.value = '';
    });

    return {
      // Rebuilds the option list from current data and puts the field into
      // whichever mode fits currentValue (select if it's a known option,
      // free-type if it's a value not in the list, blank select otherwise).
      refresh(currentValue) {
        const options = getOptions();
        select.innerHTML = '<option value="">— Select —</option>'
          + options.map((o) => `<option value="${escapeHtml(o)}">${escapeHtml(o)}</option>`).join('')
          + `<option value="${ADD_NEW}">＋ Add new…</option>`;
        if (currentValue && options.includes(currentValue)) {
          showSelect(currentValue);
        } else if (currentValue) {
          showInput(currentValue);
        } else {
          showSelect('');
        }
      },
    };
  }

  const nameField = setupDropdownField(
    fNameSelect, fName, fNameBack,
    () => [...new Set(allDevices.map((d) => d.deviceName).filter(Boolean))].sort(),
  );
  const roomField = setupDropdownField(
    fRoomSelect, fRoom, fRoomBack,
    () => [...new Set(allDevices.map((d) => d.room).filter(Boolean))].sort(),
  );
  const detailsField = setupDropdownField(
    fDetailsSelect, fDetails, fDetailsBack,
    () => deviceDetailOptions,
  );

  function buildPayload() {
    const payload = {
      qrContent: fQr.value.trim(),
      manualPairingCode: fCode.value.trim(),
      deviceName: fName.value.trim(),
      deviceDetails: fDetails.value.trim(),
      room: fRoom.value.trim(),
      notes: fNotes.value.trim(),
      pairings: readPairings(),
    };
    if (pendingPhotoDataUrl) payload.photoDataUrl = pendingPhotoDataUrl;
    if (photoRemoved) payload.removePhoto = true;
    return payload;
  }

  // Persists a scan/manual-code capture immediately, so a stray tap away
  // from the form can never lose it — only called for a brand-new entry
  // (isNewEntry), never for edits to an already-saved device. Safe to call
  // repeatedly: the first call POSTs and remembers the new id, later calls
  // just PUT to the same row.
  async function autosaveDraft() {
    if (!isNewEntry) return;
    const payload = buildPayload();
    if (!payload.qrContent && !payload.manualPairingCode) return;
    try {
      const res = await fetch(editingId ? `/api/devices/${editingId}` : '/api/devices', {
        method: editingId ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) return;
      const saved = await res.json();
      editingId = saved.id;
      deleteBtn.classList.remove('hidden');
      autosaveStatus.classList.remove('hidden');
      await loadDevices();
    } catch (err) {
      // Best-effort — the explicit Save button still works as a fallback.
    }
  }

  function resetForm() {
    editingId = null;
    isNewEntry = false;
    clearTimeout(manualCodeAutosaveTimer);
    lastWarnedManualCode = null;
    pendingPhotoDataUrl = null;
    photoRemoved = false;
    fQr.value = '';
    fCode.value = '';
    nameField.refresh('');
    detailsField.refresh('');
    roomField.refresh('');
    fNotes.value = '';
    setPairings([]);
    fPhoto.value = '';
    fPhotoPreview.classList.add('hidden');
    fPhotoPreview.src = '';
    fPhotoRemove.classList.add('hidden');
    deleteBtn.classList.add('hidden');
    autosaveStatus.classList.add('hidden');
  }

  function openForm(device, opts) {
    resetForm();
    isNewEntry = !device.id;
    const manual = (opts && opts.manual) || (!device.qrContent && !device.id);
    if (device.id) {
      editingId = device.id;
      formTitle.textContent = 'Edit device';
      deleteBtn.classList.remove('hidden');
    } else {
      formTitle.textContent = manual ? 'New device (manual entry)' : 'New device';
    }
    qrField.classList.toggle('hidden', !device.qrContent);
    fQr.value = device.qrContent || '';
    fCode.value = device.manualPairingCode || '';
    nameField.refresh(device.deviceName || '');
    detailsField.refresh(device.deviceDetails || '');
    roomField.refresh(device.room || '');
    fNotes.value = device.notes || '';
    setPairings(device.pairings);
    if (device.photoUrl) {
      fPhotoPreview.src = device.photoUrl;
      fPhotoPreview.classList.remove('hidden');
      fPhotoRemove.classList.remove('hidden');
    }
    formSection.classList.remove('hidden');
    formSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
    if (manual) {
      fCode.focus();
    } else {
      (fNameSelect.classList.contains('hidden') ? fName : fNameSelect).focus();
    }
  }

  function closeForm() {
    formSection.classList.add('hidden');
    resetForm();
  }

  cancelFormBtn.addEventListener('click', closeForm);

  // Advisory only (unlike the scan path, this fires while the user is still
  // actively typing, so it warns rather than redirecting them away mid-entry).
  let lastWarnedManualCode = null;
  function warnIfDuplicateManualCode(code) {
    if (!code || code === lastWarnedManualCode) return;
    const dup = allDevices.find((d) => d.manualPairingCode === code && d.id !== editingId);
    if (dup) {
      lastWarnedManualCode = code;
      alert(
        `Heads up: pairing code "${code}" is already saved as "${dup.deviceName}"`
        + `${dup.room ? ` (${dup.room})` : ''}.`,
      );
    }
  }

  // Autosave the manual pairing code as soon as it's typed in, without
  // waiting for the explicit Save button — same rationale as the scan path.
  fCode.addEventListener('input', () => {
    if (!isNewEntry) return;
    clearTimeout(manualCodeAutosaveTimer);
    manualCodeAutosaveTimer = setTimeout(() => {
      const code = fCode.value.trim();
      if (!code) return;
      warnIfDuplicateManualCode(code);
      autosaveDraft();
    }, 800);
  });
  fCode.addEventListener('blur', () => {
    if (!isNewEntry) return;
    clearTimeout(manualCodeAutosaveTimer);
    const code = fCode.value.trim();
    if (!code) return;
    warnIfDuplicateManualCode(code);
    autosaveDraft();
  });

  deleteBtn.addEventListener('click', async () => {
    if (!editingId) return;
    if (!confirm(`Delete "${fName.value.trim() || 'this device'}"? This can't be undone.`)) return;
    deleteBtn.disabled = true;
    try {
      const res = await fetch(`/api/devices/${editingId}`, { method: 'DELETE' });
      if (!res.ok && res.status !== 204) throw new Error('Delete failed');
      closeForm();
      await loadDevices();
    } catch (err) {
      alert('Delete failed: ' + err.message);
    } finally {
      deleteBtn.disabled = false;
    }
  });

  fPhoto.addEventListener('change', () => {
    const file = fPhoto.files && fPhoto.files[0];
    if (!file) return;
    downscaleImage(file, 800, 0.7).then((dataUrl) => {
      pendingPhotoDataUrl = dataUrl;
      photoRemoved = false;
      fPhotoPreview.src = dataUrl;
      fPhotoPreview.classList.remove('hidden');
      fPhotoRemove.classList.remove('hidden');
    });
  });

  fPhotoRemove.addEventListener('click', () => {
    pendingPhotoDataUrl = null;
    photoRemoved = true;
    fPhoto.value = '';
    fPhotoPreview.classList.add('hidden');
    fPhotoPreview.src = '';
    fPhotoRemove.classList.add('hidden');
  });

  function downscaleImage(file, maxDim, quality) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const reader = new FileReader();
      reader.onload = () => { img.src = reader.result; };
      reader.onerror = reject;
      img.onload = () => {
        let { width, height } = img;
        if (width > height && width > maxDim) {
          height = Math.round((height * maxDim) / width);
          width = maxDim;
        } else if (height > maxDim) {
          width = Math.round((width * maxDim) / height);
          height = maxDim;
        }
        const c = document.createElement('canvas');
        c.width = width;
        c.height = height;
        c.getContext('2d').drawImage(img, 0, 0, width, height);
        resolve(c.toDataURL('image/jpeg', quality));
      };
      img.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  saveBtn.addEventListener('click', async () => {
    const payload = buildPayload();
    if (!payload.qrContent && !payload.manualPairingCode) {
      alert('Scan a QR code or enter a manual pairing code first.');
      return;
    }

    saveBtn.disabled = true;
    try {
      const res = await fetch(editingId ? `/api/devices/${editingId}` : '/api/devices', {
        method: editingId ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error((await res.json()).error || res.statusText);
      closeForm();
      await loadDevices();
    } catch (err) {
      alert('Save failed: ' + err.message);
    } finally {
      saveBtn.disabled = false;
    }
  });

  // ---------- List ----------

  function escapeHtml(s) {
    return (s || '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function renderList() {
    const q = filterInput.value.trim().toLowerCase();
    const filtered = allDevices.filter((d) => {
      if (!q) return true;
      const systems = (d.pairings || []).map((p) => p.system);
      return [d.deviceName, d.room, d.notes, ...systems].some((f) => (f || '').toLowerCase().includes(q));
    });

    countBadge.textContent = allDevices.length;
    emptyState.classList.toggle('hidden', allDevices.length > 0);
    deviceList.innerHTML = '';

    filtered.forEach((d) => {
      const row = document.createElement('div');
      row.className = 'device-row';
      row.innerHTML = `
        ${d.photoUrl
          ? `<img class="thumb" src="${d.photoUrl}" alt="">`
          : `<div class="thumb placeholder">📦</div>`}
        <div class="info">
          <div class="name">${escapeHtml(d.deviceName)}</div>
          ${d.deviceDetails ? `<div class="details">${escapeHtml(d.deviceDetails)}</div>` : ''}
          ${d.room ? `<div class="room">${escapeHtml(d.room)}</div>` : ''}
          ${d.notes ? `<div class="notes">${escapeHtml(d.notes)}</div>` : ''}
          ${d.manualPairingCode ? `<div class="code">Code: ${escapeHtml(d.manualPairingCode)}</div>` : ''}
          ${(d.pairings || []).length ? `<div class="systems">${d.pairings.map((p) => `<span class="system-chip">${escapeHtml(p.system)}</span>`).join('')}</div>` : ''}
          ${d.qrContent ? `<div class="qr">${escapeHtml(d.qrContent)}</div>` : ''}
        </div>
        <div class="row-actions">
          ${d.qrContent ? '<button class="btn ghost small" data-action="qr">Show QR</button>' : ''}
          <button class="btn ghost small" data-action="edit">Edit</button>
        </div>
      `;
      const qrBtn = row.querySelector('[data-action="qr"]');
      if (qrBtn) qrBtn.addEventListener('click', () => showQr(d));
      row.querySelector('[data-action="edit"]').addEventListener('click', () => openForm(d));
      deviceList.appendChild(row);
    });

    const rooms = [...new Set(allDevices.map((d) => d.room).filter(Boolean))].sort();

    const prevPrintRoom = printRoomSelect.value;
    printRoomSelect.innerHTML = '<option value="">Print: all rooms</option>'
      + rooms.map((r) => `<option value="${escapeHtml(r)}">Print: ${escapeHtml(r)}</option>`).join('');
    if (rooms.includes(prevPrintRoom)) printRoomSelect.value = prevPrintRoom;
  }

  async function loadDevices() {
    const [devicesRes, detailsRes] = await Promise.all([
      fetch('/api/devices'),
      fetch('/api/device-details'),
    ]);
    allDevices = await devicesRes.json();
    deviceDetailOptions = detailsRes.ok ? await detailsRes.json() : [];
    renderList();
  }

  // Each device prints as one row: its QR code (regenerated server-side, so
  // it's scannable for re-pairing) or, if it has no QR, its manual setup
  // digits — beside its name/details/notes, with enough clearance around
  // each code that a phone camera can target just one without a neighbor
  // bleeding into frame.
  function buildPrintHtml(room) {
    const devices = allDevices.filter((d) => !room || d.room === room);
    const groups = new Map();
    devices.forEach((d) => {
      const key = d.room || '(No room)';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(d);
    });
    const roomNames = [...groups.keys()].sort();
    const title = room ? `Matter devices — ${room}` : 'Matter devices — full listing';

    let html = `<h1>${escapeHtml(title)}</h1><p class="printed-at">Printed ${escapeHtml(new Date().toLocaleString())}</p>`;
    roomNames.forEach((roomName) => {
      const items = groups.get(roomName)
        .slice()
        .sort((a, b) => a.deviceName.localeCompare(b.deviceName))
        .map((d) => {
          let codeHtml;
          if (d.qrContent) {
            codeHtml = `<img src="/api/devices/${d.id}/qr.png" alt="QR code for ${escapeHtml(d.deviceName)}">`;
          } else if (d.manualPairingCode) {
            codeHtml = `
              <div class="print-manual">
                <span class="print-manual-label">Setup code</span>
                <span class="print-manual-digits">${escapeHtml(d.manualPairingCode)}</span>
              </div>
            `;
          } else {
            codeHtml = '<div class="print-manual print-manual-empty">No code</div>';
          }
          return `
            <div class="print-item">
              <div class="print-code">${codeHtml}</div>
              <div class="print-info">
                <div class="print-name">${escapeHtml(d.deviceName)}</div>
                ${d.deviceDetails ? `<div class="print-details">${escapeHtml(d.deviceDetails)}</div>` : ''}
                ${d.notes ? `<div class="print-notes">${escapeHtml(d.notes)}</div>` : ''}
                ${(d.pairings || []).length ? `<div class="print-notes">Paired with: ${d.pairings.map((p) => escapeHtml(p.code ? `${p.system} (${p.code})` : p.system)).join(', ')}</div>` : ''}
              </div>
            </div>
          `;
        }).join('');
      html += `<section class="print-room"><h2>${escapeHtml(roomName)}</h2>${items}</section>`;
    });
    return html;
  }

  printBtn.addEventListener('click', () => {
    printArea.innerHTML = buildPrintHtml(printRoomSelect.value);
    window.print();
  });

  function showQr(d) {
    qrModalTitle.textContent = d.deviceName;
    qrModalImg.src = `/api/devices/${d.id}/qr.png`;
    qrModal.classList.remove('hidden');
  }

  qrModalClose.addEventListener('click', () => qrModal.classList.add('hidden'));
  qrModal.addEventListener('click', (e) => {
    if (e.target === qrModal) qrModal.classList.add('hidden');
  });

  filterInput.addEventListener('input', renderList);

  loadDevices();
})();
