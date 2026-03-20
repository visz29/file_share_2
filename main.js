import QRCode from 'qrcode';
import jsQR from 'jsqr';

const CHUNK = 64 * 1024;
let pc = null, dc = null, role = 'offer';
let sendQueue = [];
let recvMeta = null, recvBufs = [], recvBytes = 0;

// ── Compress / decompress SDP ─────────────────────────────────────────────────
async function compress(str) {
  const bytes = new TextEncoder().encode(str);
  const cs = new CompressionStream('gzip');
  const w = cs.writable.getWriter();
  w.write(bytes); w.close();
  const buf = await new Response(cs.readable).arrayBuffer();
  return btoa(String.fromCharCode(...new Uint8Array(buf)));
}
async function decompress(b64) {
  const bin = atob(b64);
  const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
  const ds = new DecompressionStream('gzip');
  const w = ds.writable.getWriter();
  w.write(bytes); w.close();
  const buf = await new Response(ds.readable).arrayBuffer();
  return new TextDecoder().decode(buf);
}

// ── Split compressed string into N equal chunks ───────────────────────────────
function splitChunks(str, n) {
  const size = Math.ceil(str.length / n);
  return Array.from({ length: n }, (_, i) => str.slice(i * size, (i + 1) * size));
}

// QR payload format: "rtcs:<partIndex>/<total>:<data>"
const QR_PREFIX = 'rtcs:';
function encodeQRPart(index, total, data) {
  return `${QR_PREFIX}${index}/${total}:${data}`;
}
function decodeQRPart(raw) {
  if (!raw.startsWith(QR_PREFIX)) return null;
  const body = raw.slice(QR_PREFIX.length);
  const slash = body.indexOf('/');
  const colon = body.indexOf(':');
  if (slash < 0 || colon < 0) return null;
  return {
    index: parseInt(body.slice(0, slash)),
    total: parseInt(body.slice(slash + 1, colon)),
    data:  body.slice(colon + 1),
  };
}

// ── Render dual QR codes ──────────────────────────────────────────────────────
async function showDualQR(containerId, compressed) {
  const parts = splitChunks(compressed, 2);
  const container = document.getElementById(containerId);
  container.innerHTML = '';
  container.classList.remove('hidden');

  for (let i = 0; i < parts.length; i++) {
    const payload = encodeQRPart(i, parts.length, parts[i]);
    const wrap = document.createElement('div');
    wrap.className = 'qr-block';
    wrap.innerHTML = `<div class="qr-num">QR ${i + 1} of ${parts.length}</div>`;
    const canvas = document.createElement('canvas');
    wrap.appendChild(canvas);
    const byteLen = Math.round(payload.length * 0.75);
    wrap.innerHTML += `<div class="qr-sub">${payload.length} chars · ${byteLen}B</div>`;
    container.appendChild(wrap);
    // Re-append canvas after innerHTML wipe
    wrap.insertBefore(canvas, wrap.querySelector('.qr-sub'));
    await QRCode.toCanvas(canvas, payload, {
      errorCorrectionLevel: 'M',
      width: 220,
      margin: 2,
      color: { dark: '#e0e0ee', light: '#0d0d14' }
    });
  }
}

// ── UI helpers ────────────────────────────────────────────────────────────────
function log(msg, cls = '') {
  const el = document.getElementById('log');
  el.innerHTML += `<div class="${cls}">${escHtml(msg)}</div>`;
  el.scrollTop = el.scrollHeight;
}
function setStatus(state) {
  document.getElementById('connDot').className = 'dot ' + state;
  document.getElementById('connLabel').textContent = state;
}
function showSections(on) {
  document.getElementById('section-send').classList.toggle('hidden', !on);
  document.getElementById('section-recv').classList.toggle('hidden', !on);
}
window.copyText = (id) => {
  navigator.clipboard.writeText(document.getElementById(id).value)
    .then(() => log('copied ✓', 'ok'));
};
window.setRole = (r) => {
  role = r;
  ['tabOffer','tabAnswer'].forEach(id =>
    document.getElementById(id).classList.toggle('active', id === 'tab' + (r === 'offer' ? 'Offer' : 'Answer'))
  );
  document.getElementById('offerFlow').classList.toggle('hidden', r !== 'offer');
  document.getElementById('answerFlow').classList.toggle('hidden', r !== 'answer');
};

// ── QR Scanner (multi-part aware) ─────────────────────────────────────────────
let scanActive = false, scanStream = null;
let scanTarget = null;           // 'offer' | 'answer'
let collectedParts = {};         // { index: data }
let expectedTotal = null;

function resetScan() {
  collectedParts = {};
  expectedTotal = null;
}

function scanProgress() {
  const got = Object.keys(collectedParts).length;
  const total = expectedTotal || '?';
  return { got, total };
}

window.startScan = async (target) => {
  scanTarget = target;
  resetScan();
  updateScanUI();

  const modal = document.getElementById('scanModal');
  modal.classList.remove('hidden');
  const video = document.getElementById('scanVideo');

  setScanStatus('Starting camera…', 'info');

  try {
    scanStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } }
    });
    video.srcObject = scanStream;
    await video.play();
    scanActive = true;
    setScanStatus('Point at QR 1 of 2…', 'info');
    requestAnimationFrame(scanFrame);
  } catch (e) {
    setScanStatus('❌ Camera error: ' + e.message, 'err');
  }
};

async function scanFrame() {
  if (!scanActive) return;
  const video = document.getElementById('scanVideo');
  if (video.readyState < video.HAVE_ENOUGH_DATA) {
    requestAnimationFrame(scanFrame); return;
  }
  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  canvas.getContext('2d').drawImage(video, 0, 0);
  const img = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);

  let code = null;
  try {
    code = jsQR(img.data, img.width, img.height, { inversionAttempts: 'attemptBoth' });
  } catch(e) {
    setScanStatus('❌ Scan decode error: ' + e.message, 'err');
    requestAnimationFrame(scanFrame);
    return;
  }

  if (code) {
    const part = decodeQRPart(code.data);

    if (!part) {
      setScanStatus('⚠️ Not an rtcshare QR — try again', 'warn');
      await sleep(1200);
      setScanStatus('Scanning… point at the QR code', 'info');
      requestAnimationFrame(scanFrame);
      return;
    }

    // Validate total consistency
    if (expectedTotal !== null && part.total !== expectedTotal) {
      setScanStatus('⚠️ QR mismatch — wrong session? Restart scan', 'warn');
      await sleep(1500);
      requestAnimationFrame(scanFrame);
      return;
    }

    expectedTotal = part.total;

    if (collectedParts[part.index] !== undefined) {
      // Already have this part — guide to next
      const { got, total } = scanProgress();
      const missing = getMissing();
      setScanStatus(`Already have QR ${part.index + 1} — scan QR ${missing[0] + 1}`, 'warn');
      await sleep(900);
      requestAnimationFrame(scanFrame);
      return;
    }

    // Accept this part
    collectedParts[part.index] = part.data;
    updateScanUI();

    const { got, total } = scanProgress();

    if (got < total) {
      const missing = getMissing();
      setScanStatus(`✓ Got QR ${part.index + 1} — now scan QR ${missing[0] + 1}`, 'ok');
      requestAnimationFrame(scanFrame);
      return;
    }

    // All parts collected
    setScanStatus('✓ All QRs scanned — assembling…', 'ok');
    stopScan();

    try {
      const assembled = Array.from({ length: total }, (_, i) => collectedParts[i]).join('');
      const sdpJson = await decompress(assembled);

      // Validate it's real SDP JSON
      const parsed = JSON.parse(sdpJson);
      if (!parsed.type || !parsed.sdp) throw new Error('Invalid SDP structure');

      if (scanTarget === 'offer') {
        document.getElementById('offerInput').value = sdpJson;
        log('scanned offer (2 QRs) ✓', 'ok');
      } else {
        document.getElementById('answerInput').value = sdpJson;
        log('scanned answer (2 QRs) ✓', 'ok');
      }
      await sleep(600);
      closeScan();
    } catch (e) {
      setScanStatus('❌ Decode failed: ' + e.message + ' — restart scan', 'err');
      resetScan();
      updateScanUI();
      scanActive = true;
      requestAnimationFrame(scanFrame);
    }
    return;
  }

  requestAnimationFrame(scanFrame);
}

function getMissing() {
  const total = expectedTotal || 2;
  return Array.from({ length: total }, (_, i) => i).filter(i => collectedParts[i] === undefined);
}

function updateScanUI() {
  const total = expectedTotal || 2;
  const indicators = document.getElementById('scanIndicators');
  indicators.innerHTML = '';
  for (let i = 0; i < total; i++) {
    const dot = document.createElement('div');
    dot.className = 'scan-dot ' + (collectedParts[i] !== undefined ? 'got' : 'waiting');
    dot.textContent = `QR ${i + 1}`;
    indicators.appendChild(dot);
  }
}

function setScanStatus(msg, cls = '') {
  const el = document.getElementById('scanStatus');
  el.textContent = msg;
  el.className = 'scan-status ' + cls;
}

function stopScan() {
  scanActive = false;
  if (scanStream) { scanStream.getTracks().forEach(t => t.stop()); scanStream = null; }
}
window.closeScan = () => {
  stopScan(); resetScan();
  document.getElementById('scanModal').classList.add('hidden');
  document.getElementById('scanVideo').srcObject = null;
  document.getElementById('scanIndicators').innerHTML = '';
};

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── WebRTC core ───────────────────────────────────────────────────────────────
function makePeer() {
  pc = new RTCPeerConnection({ iceServers: [] });
  pc.onicecandidate = () => {};
  pc.onicegatheringstatechange = async () => {
    if (pc.iceGatheringState !== 'complete') return;
    const sdpJson = JSON.stringify(pc.localDescription);
    let compressed;
    try {
      compressed = await compress(sdpJson);
    } catch(e) {
      log('compress error: ' + e.message, 'err'); return;
    }
    log(`SDP compressed: ${sdpJson.length} → ${compressed.length} chars`, 'info');
    if (role === 'offer') {
      document.getElementById('offerSDP').value = sdpJson;
      document.getElementById('offerOut').classList.remove('hidden');
      await showDualQR('offerQRContainer', compressed);
      log('offer QRs ready — scan QR 1 then QR 2 on receiver', 'info');
    } else {
      document.getElementById('answerSDP').value = sdpJson;
      document.getElementById('answerOut').classList.remove('hidden');
      await showDualQR('answerQRContainer', compressed);
      log('answer QRs ready — scan QR 1 then QR 2 on sender', 'info');
    }
  };
  pc.onconnectionstatechange = () => {
    log('connection: ' + pc.connectionState);
    if (pc.connectionState === 'connected') {
      setStatus('connected'); showSections(true);
      log('peer connected ✓', 'ok');
    }
    if (['failed','disconnected','closed'].includes(pc.connectionState)) setStatus('idle');
  };
  pc.ondatachannel = e => setupChannel(e.channel);
}

function setupChannel(ch) {
  dc = ch;
  dc.binaryType = 'arraybuffer';
  dc.onopen = () => log('data channel open ✓', 'ok');
  dc.onmessage = onMessage;
  dc.onerror = e => log('dc error: ' + e.message, 'err');
}

window.createOffer = async () => {
  setStatus('connecting'); makePeer();
  setupChannel(pc.createDataChannel('files'));
  try {
    await pc.setLocalDescription(await pc.createOffer());
    log('gathering ICE…');
  } catch(e) { log('offer error: ' + e.message, 'err'); }
};

window.createAnswer = async () => {
  const raw = document.getElementById('offerInput').value.trim();
  if (!raw) { log('scan or paste offer first', 'err'); return; }
  setStatus('connecting'); makePeer();
  try {
    await pc.setRemoteDescription(JSON.parse(raw));
    await pc.setLocalDescription(await pc.createAnswer());
    log('gathering ICE…');
  } catch(e) { log('answer error: ' + e.message, 'err'); setStatus('idle'); }
};

window.applyAnswer = async () => {
  const raw = document.getElementById('answerInput').value.trim();
  if (!raw) { log('scan or paste answer first', 'err'); return; }
  try {
    await pc.setRemoteDescription(JSON.parse(raw));
    log('applying answer…', 'info');
  } catch(e) { log('apply answer error: ' + e.message, 'err'); }
};

// ── File sending ──────────────────────────────────────────────────────────────
window.addFiles = (files) => {
  for (const f of files) {
    const id = crypto.randomUUID();
    sendQueue.push({ file: f, id });
    const el = document.createElement('div');
    el.className = 'file-item'; el.id = 'fi-' + id;
    el.innerHTML = `
      <div class="file-icon">${fileIcon(f.name)}</div>
      <div class="file-info">
        <div class="file-name">${escHtml(f.name)}</div>
        <div class="file-size">${fmtSize(f.size)}</div>
        <div class="file-progress"><div class="file-progress-bar" id="pb-${id}"></div></div>
      </div>
      <div class="file-status waiting" id="fs-${id}">queued</div>
      <button class="btn-rm" onclick="removeFile('${id}')">×</button>`;
    document.getElementById('fileList').appendChild(el);
  }
  document.getElementById('btnSend').disabled = sendQueue.length === 0;
};
window.clearFiles = () => {
  sendQueue = [];
  document.getElementById('fileList').innerHTML = '';
  document.getElementById('btnSend').disabled = true;
};
window.removeFile = (id) => {
  sendQueue = sendQueue.filter(x => x.id !== id);
  document.getElementById('fi-' + id)?.remove();
  document.getElementById('btnSend').disabled = sendQueue.length === 0;
};
window.sendFiles = async () => {
  if (!dc || dc.readyState !== 'open') { log('not connected', 'err'); return; }
  document.getElementById('btnSend').disabled = true;
  for (const { file, id } of sendQueue) await sendFile(file, id);
  log('all files sent ✓', 'ok');
};
async function sendFile(file, id) {
  const sEl = document.getElementById('fs-' + id);
  const bEl = document.getElementById('pb-' + id);
  sEl.className = 'file-status sending'; sEl.textContent = 'sending';
  dc.send(JSON.stringify({ type: 'meta', name: file.name, size: file.size, mime: file.type }));
  const buf = await file.arrayBuffer();
  let offset = 0;
  while (offset < buf.byteLength) {
    while (dc.bufferedAmount > 1024 * 1024) await sleep(20);
    const end = Math.min(offset + CHUNK, buf.byteLength);
    dc.send(buf.slice(offset, end));
    offset = end;
    const pct = Math.round(offset / buf.byteLength * 100);
    bEl.style.width = pct + '%'; sEl.textContent = pct + '%';
  }
  dc.send(JSON.stringify({ type: 'done' }));
  sEl.className = 'file-status done'; sEl.textContent = '✓ sent';
  log(`sent: ${file.name}`, 'ok');
}

// ── File receiving ────────────────────────────────────────────────────────────
function onMessage(e) {
  if (typeof e.data === 'string') {
    const msg = JSON.parse(e.data);
    if (msg.type === 'meta') { recvMeta = msg; recvBufs = []; recvBytes = 0; log(`receiving: ${msg.name}`, 'info'); }
    else if (msg.type === 'done') finalizeRecv();
  } else { recvBufs.push(e.data); recvBytes += e.data.byteLength; }
}
function finalizeRecv() {
  if (!recvMeta) return;
  const blob = new Blob(recvBufs, { type: recvMeta.mime || 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const list = document.getElementById('recvList');
  if (list.querySelector('.tip')) list.innerHTML = '';
  const el = document.createElement('div');
  el.className = 'recv-item';
  el.innerHTML = `
    <div class="file-icon">${fileIcon(recvMeta.name)}</div>
    <div class="recv-info">
      <div class="recv-name">${escHtml(recvMeta.name)}</div>
      <div class="recv-size">${fmtSize(recvMeta.size)}</div>
    </div>
    <a href="${url}" download="${escHtml(recvMeta.name)}" class="btn btn-primary" style="text-decoration:none">save</a>`;
  list.appendChild(el);
  log(`received: ${recvMeta.name} ✓`, 'ok');
  recvMeta = null; recvBufs = []; recvBytes = 0;
}

// ── Drag & Drop ───────────────────────────────────────────────────────────────
const dz = document.getElementById('dropZone');
dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('drag-over'); });
dz.addEventListener('dragleave', () => dz.classList.remove('drag-over'));
dz.addEventListener('drop', e => { e.preventDefault(); dz.classList.remove('drag-over'); addFiles(e.dataTransfer.files); });

// ── Helpers ───────────────────────────────────────────────────────────────────
function fmtSize(b) {
  if (b < 1024) return b + ' B';
  if (b < 1048576) return (b/1024).toFixed(1) + ' KB';
  if (b < 1073741824) return (b/1048576).toFixed(1) + ' MB';
  return (b/1073741824).toFixed(2) + ' GB';
}
function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function fileIcon(name) {
  const ext = (name.split('.').pop()||'').toLowerCase();
  const m = {jpg:'🖼️',jpeg:'🖼️',png:'🖼️',gif:'🖼️',webp:'🖼️',svg:'🖼️',mp4:'🎬',mov:'🎬',mkv:'🎬',webm:'🎬',mp3:'🎵',wav:'🎵',flac:'🎵',pdf:'📄',doc:'📝',docx:'📝',txt:'📝',md:'📝',zip:'📦',rar:'📦','7z':'📦',js:'💻',ts:'💻',py:'💻',html:'💻',json:'💻'};
  return m[ext] || '📎';
}
