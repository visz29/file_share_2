// ─── RTC Share — WebRTC file transfer with QR signaling ─────────────────────
import QRCode from 'qrcode';
import jsQR from 'jsqr';

const CHUNK = 64 * 1024;

let pc = null, dc = null, role = 'offer';
let sendQueue = [];
let recvMeta = null, recvBufs = [], recvBytes = 0;

// ── Compression helpers (SDP shrink for QR) ───────────────────────────────────
async function compress(str) {
  const bytes = new TextEncoder().encode(str);
  const cs = new CompressionStream('gzip');
  const writer = cs.writable.getWriter();
  writer.write(bytes); writer.close();
  const buf = await new Response(cs.readable).arrayBuffer();
  return btoa(String.fromCharCode(...new Uint8Array(buf)));
}

async function decompress(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length).map((_, i) => bin.charCodeAt(i));
  const ds = new DecompressionStream('gzip');
  const writer = ds.writable.getWriter();
  writer.write(bytes); writer.close();
  const buf = await new Response(ds.readable).arrayBuffer();
  return new TextDecoder().decode(buf);
}

// ── UI helpers ────────────────────────────────────────────────────────────────
function log(msg, cls = '') {
  const el = document.getElementById('log');
  el.innerHTML += `<div class="${cls}">${msg}</div>`;
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
  const el = document.getElementById(id);
  navigator.clipboard.writeText(el.value).then(() => log('copied ✓', 'ok'));
};

window.setRole = (r) => {
  role = r;
  document.getElementById('tabOffer').classList.toggle('active', r === 'offer');
  document.getElementById('tabAnswer').classList.toggle('active', r === 'answer');
  document.getElementById('offerFlow').classList.toggle('hidden', r !== 'offer');
  document.getElementById('answerFlow').classList.toggle('hidden', r !== 'answer');
};

// ── QR Code display ───────────────────────────────────────────────────────────
async function showQR(canvasId, data) {
  const canvas = document.getElementById(canvasId);
  canvas.classList.remove('hidden');
  await QRCode.toCanvas(canvas, data, {
    errorCorrectionLevel: 'L',
    width: 240,
    margin: 2,
    color: { dark: '#e0e0ee', light: '#0d0d14' }
  });
}

// ── QR Scanner ───────────────────────────────────────────────────────────────
let scanActive = false;
let scanStream = null;
let scanTarget = null; // 'offer' | 'answer'

window.startScan = async (target) => {
  scanTarget = target;
  const modal = document.getElementById('scanModal');
  modal.classList.remove('hidden');
  const video = document.getElementById('scanVideo');
  const status = document.getElementById('scanStatus');

  try {
    scanStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment' }
    });
    video.srcObject = scanStream;
    await video.play();
    scanActive = true;
    status.textContent = 'scanning…';
    requestAnimationFrame(scanFrame);
  } catch (e) {
    status.textContent = 'camera error: ' + e.message;
  }
};

async function scanFrame() {
  if (!scanActive) return;
  const video = document.getElementById('scanVideo');
  if (video.readyState !== video.HAVE_ENOUGH_DATA) {
    requestAnimationFrame(scanFrame); return;
  }
  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  canvas.getContext('2d').drawImage(video, 0, 0);
  const img = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
  const code = jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' });

  if (code) {
    stopScan();
    document.getElementById('scanStatus').textContent = 'got it ✓';
    try {
      const sdpJson = await decompress(code.data);
      if (scanTarget === 'offer') {
        document.getElementById('offerInput').value = sdpJson;
        log('scanned offer QR ✓', 'ok');
      } else {
        document.getElementById('answerInput').value = sdpJson;
        log('scanned answer QR ✓', 'ok');
      }
      closeScan();
    } catch(e) {
      document.getElementById('scanStatus').textContent = 'decode error';
    }
    return;
  }
  requestAnimationFrame(scanFrame);
}

function stopScan() {
  scanActive = false;
  if (scanStream) { scanStream.getTracks().forEach(t => t.stop()); scanStream = null; }
}

window.closeScan = () => {
  stopScan();
  document.getElementById('scanModal').classList.add('hidden');
  document.getElementById('scanVideo').srcObject = null;
};

// ── WebRTC core ───────────────────────────────────────────────────────────────
function makePeer() {
  pc = new RTCPeerConnection({ iceServers: [] });
  pc.onicecandidate = () => {};
  pc.onicegatheringstatechange = async () => {
    if (pc.iceGatheringState !== 'complete') return;
    const sdpJson = JSON.stringify(pc.localDescription);
    const compressed = await compress(sdpJson);

    if (role === 'offer') {
      document.getElementById('offerSDP').value = sdpJson;
      document.getElementById('offerOut').classList.remove('hidden');
      await showQR('offerQR', compressed);
      log('offer QR ready — scan on receiver', 'info');
    } else {
      document.getElementById('answerSDP').value = sdpJson;
      document.getElementById('answerOut').classList.remove('hidden');
      await showQR('answerQR', compressed);
      log('answer QR ready — scan on sender', 'info');
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
  pc.ondatachannel = (e) => setupChannel(e.channel);
  return pc;
}

function setupChannel(ch) {
  dc = ch;
  dc.binaryType = 'arraybuffer';
  dc.onopen = () => log('data channel open ✓', 'ok');
  dc.onmessage = onMessage;
  dc.onerror = (e) => log('dc error: ' + e.message, 'err');
}

window.createOffer = async () => {
  setStatus('connecting'); makePeer();
  setupChannel(pc.createDataChannel('files'));
  await pc.setLocalDescription(await pc.createOffer());
  log('gathering ICE…');
};

window.createAnswer = async () => {
  const raw = document.getElementById('offerInput').value.trim();
  if (!raw) { log('paste or scan offer first', 'err'); return; }
  setStatus('connecting'); makePeer();
  await pc.setRemoteDescription(JSON.parse(raw));
  await pc.setLocalDescription(await pc.createAnswer());
  log('gathering ICE…');
};

window.applyAnswer = async () => {
  const raw = document.getElementById('answerInput').value.trim();
  if (!raw) { log('paste or scan answer first', 'err'); return; }
  await pc.setRemoteDescription(JSON.parse(raw));
  log('applying answer…', 'info');
};

// ── File sending ──────────────────────────────────────────────────────────────
window.addFiles = (files) => {
  for (const f of files) {
    const id = crypto.randomUUID();
    sendQueue.push({ file: f, id });
    renderSendItem(f, id);
  }
  document.getElementById('btnSend').disabled = sendQueue.length === 0;
};
window.clearFiles = () => {
  sendQueue = [];
  document.getElementById('fileList').innerHTML = '';
  document.getElementById('btnSend').disabled = true;
};
function renderSendItem(file, id) {
  const el = document.createElement('div');
  el.className = 'file-item'; el.id = 'fi-' + id;
  el.innerHTML = `
    <div class="file-icon">${fileIcon(file.name)}</div>
    <div class="file-info">
      <div class="file-name">${escHtml(file.name)}</div>
      <div class="file-size">${fmtSize(file.size)}</div>
      <div class="file-progress"><div class="file-progress-bar" id="pb-${id}"></div></div>
    </div>
    <div class="file-status waiting" id="fs-${id}">queued</div>
    <button class="btn-rm" onclick="removeFile('${id}')">×</button>`;
  document.getElementById('fileList').appendChild(el);
}
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
  const statusEl = document.getElementById('fs-' + id);
  const barEl = document.getElementById('pb-' + id);
  statusEl.className = 'file-status sending'; statusEl.textContent = 'sending';
  dc.send(JSON.stringify({ type: 'meta', name: file.name, size: file.size, mime: file.type }));
  const buf = await file.arrayBuffer();
  let offset = 0;
  while (offset < buf.byteLength) {
    while (dc.bufferedAmount > 1024 * 1024) await new Promise(r => setTimeout(r, 20));
    const end = Math.min(offset + CHUNK, buf.byteLength);
    dc.send(buf.slice(offset, end));
    offset = end;
    const pct = Math.round(offset / buf.byteLength * 100);
    barEl.style.width = pct + '%'; statusEl.textContent = pct + '%';
  }
  dc.send(JSON.stringify({ type: 'done' }));
  statusEl.className = 'file-status done'; statusEl.textContent = '✓ sent';
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
const dropZone = document.getElementById('dropZone');
dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
dropZone.addEventListener('drop', e => { e.preventDefault(); dropZone.classList.remove('drag-over'); addFiles(e.dataTransfer.files); });

// ── Helpers ───────────────────────────────────────────────────────────────────
function fmtSize(b) {
  if (b < 1024) return b + ' B';
  if (b < 1024**2) return (b/1024).toFixed(1) + ' KB';
  if (b < 1024**3) return (b/1024**2).toFixed(1) + ' MB';
  return (b/1024**3).toFixed(2) + ' GB';
}
function escHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function fileIcon(name) {
  const ext = name.split('.').pop().toLowerCase();
  const m = { jpg:'🖼️',jpeg:'🖼️',png:'🖼️',gif:'🖼️',webp:'🖼️',svg:'🖼️',mp4:'🎬',mov:'🎬',mkv:'🎬',webm:'🎬',mp3:'🎵',wav:'🎵',flac:'🎵',pdf:'📄',doc:'📝',docx:'📝',txt:'📝',md:'📝',zip:'📦',rar:'📦','7z':'📦',js:'💻',ts:'💻',py:'💻',html:'💻',json:'💻' };
  return m[ext] || '📎';
}
