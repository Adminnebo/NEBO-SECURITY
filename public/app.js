'use strict';

const $ = id => document.getElementById(id);
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const state = { file: null, sourceURL: null, urls: [], worker: null, nextId: 1,
  pending: null, busy: false, activeMode: 'sender', recording: null,
  preparingMicrophone: false, receivedArt: null, receivedToken: null, target: null, taskSerial: 0 };
const el = (tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; };
const formatBytes = bytes => bytes < 1024 ? `${bytes} B` : bytes < 1048576 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1048576).toFixed(2)} MB`;
const formatNumber = value => Number(value).toLocaleString('es-DO');
let toastTimer;
let resolveWorkerReady, rejectWorkerReady;
window.ASTRA_READY = new Promise((resolve, reject) => { resolveWorkerReady = resolve; rejectWorkerReady = reject; });
window.ASTRA_READY.catch(() => {});

function toast(message) { $('toast').textContent = message; $('toast').classList.remove('hidden'); clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').classList.add('hidden'), 5000); }
function errorFor(mode, message = '') { const node = $(mode + 'Error'); node.textContent = message; node.classList.toggle('hidden', !message); }
function objectURL(blob) { const url = URL.createObjectURL(blob); state.urls.push(url); return url; }
function setMode(mode) {
  state.activeMode = mode; const receiving = mode === 'receiver';
  $('senderTab').classList.toggle('active', !receiving); $('senderTab').setAttribute('aria-pressed', String(!receiving));
  $('receiverTab').classList.toggle('active', receiving); $('receiverTab').setAttribute('aria-pressed', String(receiving));
  $('senderPanel').classList.toggle('hidden', receiving); $('receiverPanel').classList.toggle('hidden', !receiving);
  const url = new URL(location.href); if (receiving) url.searchParams.set('modo', 'recibir'); else url.searchParams.delete('modo'); history.replaceState({}, '', url);
}
function updateButtons() {
  $('encodeButton').disabled = state.busy || !state.file || Boolean(state.recording) || state.preparingMicrophone;
  $('decodeButton').disabled = state.busy || !state.receivedArt || !state.receivedToken;
  for (const id of ['sourceFile', 'receivedArt', 'receivedToken', 'recordButton', 'demoButton', 'textButton', 'useText']) $(id).disabled = state.busy || Boolean(state.recording) || state.preparingMicrophone;
  $('recordButton').disabled = state.busy || Boolean(state.recording) || state.preparingMicrophone;
}
function progress(mode, percent, message) {
  $(mode + 'Stage').textContent = message || (mode === 'sender' ? 'Creando tu envío…' : 'Reconstruyendo…');
  const value = Math.max(0, Math.min(100, Number(percent) || 0));
  $(mode + 'ProgressBar').value = value; $(mode + 'Percent').textContent = `${Math.round(value)}%`;
}
function beginTask(mode) {
  const serial = ++state.taskSerial;
  state.busy = true; errorFor(mode); $(mode + 'Empty').classList.add('hidden'); $(mode + 'Result').classList.add('hidden'); $(mode + 'Progress').classList.remove('hidden');
  $(mode + 'ProgressText').textContent = mode === 'sender' ? 'El procesamiento ocurre en tu navegador.' : 'Comprobando la obra y su clave.';
  progress(mode, 0, mode === 'sender' ? 'Preparando el archivo…' : 'Leyendo la obra y su clave…'); updateButtons(); return serial;
}
function endTask(mode, failed = false) {
  state.busy = false; $(mode + 'Progress').classList.add('hidden');
  if (failed) $(mode + 'Empty').classList.remove('hidden'); updateButtons();
}
function startWorker() {
  try {
    const worker = new Worker(new URL('./codec-worker.js', location.href), { type: 'module' }); state.worker = worker;
    worker.onmessage = event => {
      const data = event.data || {};
      if (data.type === 'ready') { document.body.dataset.workerReady = 'true'; resolveWorkerReady(true); return; }
      const job = state.pending; if (!job || String(data.id) !== String(job.id)) return;
      if (data.type === 'progress') { progress(job.mode, data.percent ?? data.progress, data.message); return; }
      if (data.type === 'result') { state.pending = null; job.resolve(data); }
      else if (data.type === 'error') { state.pending = null; job.reject(new Error(data.message || data.error || 'No se pudo completar la operación.')); }
    };
    worker.onerror = event => {
      const message = event.message || 'No se pudo cargar el motor de conversión. Recarga la página y vuelve a intentarlo.';
      if (state.pending) { const job = state.pending; state.pending = null; job.reject(new Error(message)); }
      rejectWorkerReady(new Error(message));
      $('compatibility').textContent = 'No se pudo cargar el motor de conversión. Recarga la página cuando tengas conexión.'; $('compatibility').classList.remove('hidden');
    };
  } catch (error) {
    rejectWorkerReady(error); $('compatibility').textContent = 'Abre esta página mediante HTTPS en un navegador actualizado para usar la conversión local.'; $('compatibility').classList.remove('hidden');
  }
}
function runWorker(action, data, mode) {
  if (!state.worker) startWorker();
  if (!state.worker) return Promise.reject(new Error('El motor de conversión no está disponible.'));
  return new Promise((resolve, reject) => {
    const id = state.nextId++; state.pending = { id, resolve, reject, mode };
    const transfer = []; for (const key of ['file', 'artwork', 'token']) if (data[key] instanceof ArrayBuffer) transfer.push(data[key]);
    if (data.preview?.data instanceof ArrayBuffer) transfer.push(data.preview.data);
    // The cached target remains reusable; do not transfer/detach its buffer.
    state.worker.postMessage({ id, action, ...data }, transfer);
  });
}
function cancelTask() {
  if (!state.busy) return;
  state.taskSerial++;
  const mode = state.pending?.mode || state.activeMode;
  if (state.pending) { state.pending.reject(new Error('Operación cancelada. Puedes volver a intentarlo.')); state.pending = null; }
  state.worker?.terminate(); state.worker = null; startWorker(); endTask(mode, true); toast('Operación cancelada.');
}
function clearFile() {
  if (state.busy || state.recording) return;
  if (state.sourceURL) URL.revokeObjectURL(state.sourceURL); state.sourceURL = null; state.file = null;
  $('sourceFile').value = ''; $('selectedFile').replaceChildren(); $('selectedFile').classList.add('hidden'); updateButtons();
}
function selectFile(file) {
  if (!file || state.busy || state.recording) return false;
  if (!file.size) { errorFor('sender', 'El archivo está vacío. Selecciona uno que contenga información.'); return false; }
  if (file.size > MAX_FILE_BYTES) { errorFor('sender', 'Selecciona un archivo de hasta 20 MB.'); return false; }
  clearFile(); errorFor('sender'); state.file = file; state.sourceURL = URL.createObjectURL(file);
  const selection = $('selectedFile');
  if (file.type.startsWith('image/')) { const image = el('img'); image.src = state.sourceURL; image.alt = 'Vista del archivo seleccionado'; selection.append(image); }
  else selection.append(el('span', 'file-type', file.type.startsWith('audio/') ? 'VOZ' : /pdf/i.test(file.type) || /\.pdf$/i.test(file.name) ? 'PDF' : 'TXT'));
  const info = el('div', 'file-info'); info.append(el('strong', '', file.name), el('small', '', `${formatBytes(file.size)} · Original completo`));
  if (file.type.startsWith('audio/')) { const audio = el('audio'); audio.controls = true; audio.src = state.sourceURL; info.append(audio); }
  selection.append(info); const remove = el('button', 'remove-file', '×'); remove.type = 'button'; remove.setAttribute('aria-label', 'Quitar archivo seleccionado'); remove.addEventListener('click', clearFile); selection.append(remove); selection.classList.remove('hidden');
  $('senderResult').classList.add('hidden'); $('senderEmpty').classList.remove('hidden');
  updateButtons(); return true;
}
function scaledDimensions(width, height, maxPixels = 900000) { const scale = Math.min(1, Math.sqrt(maxPixels / (width * height))); return [Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale))]; }
function rgbaFromCanvas(canvas) { return { width: canvas.width, height: canvas.height, channels: 4, data: canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, canvas.width, canvas.height).data.buffer }; }
async function loadTarget() {
  if (state.target) return state.target;
  const response = await fetch(new URL('./assets/mountain.png', location.href)); if (!response.ok) throw new Error('No se pudo cargar la referencia del paisaje. Recarga la página con conexión.');
  const bitmap = await createImageBitmap(await response.blob()); const [width, height] = scaledDimensions(bitmap.width, bitmap.height, 1000000);
  const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height; canvas.getContext('2d').drawImage(bitmap, 0, 0, width, height); bitmap.close(); state.target = rgbaFromCanvas(canvas); return state.target;
}
async function imagePreview(file) {
  const bitmap = await createImageBitmap(file); const [width, height] = scaledDimensions(bitmap.width, bitmap.height);
  const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height; const context = canvas.getContext('2d'); context.fillStyle = '#ffffff'; context.fillRect(0, 0, width, height); context.drawImage(bitmap, 0, 0, width, height); bitmap.close(); return rgbaFromCanvas(canvas);
}
async function pdfPreview(bytes) {
  const pdfjs = await import('./vendor/pdf.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdf.worker.mjs', location.href).href;
  const loadingTask = pdfjs.getDocument({ data: bytes.slice(0),
    standardFontDataUrl: new URL('./vendor/standard_fonts/', location.href).href,
    cMapUrl: new URL('./vendor/cmaps/', location.href).href, cMapPacked: true,
    wasmUrl: new URL('./vendor/wasm/', location.href).href, isEvalSupported: false });
  const document = await loadingTask.promise;
  try {
    const page = await document.getPage(1); const raw = page.getViewport({ scale: 1 });
    const scale = Math.min(2.5, Math.sqrt(900000 / (raw.width * raw.height)));
    const viewport = page.getViewport({ scale }); const canvas = window.document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
    const context = canvas.getContext('2d'); context.fillStyle = 'white'; context.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: context, canvas, viewport }).promise; return rgbaFromCanvas(canvas);
  } finally { await loadingTask.destroy(); }
}
async function textPreview(file) {
  const text = await file.text(); const canvas = document.createElement('canvas'); canvas.width = 768; canvas.height = 994;
  const context = canvas.getContext('2d'); context.fillStyle = '#ffffff'; context.fillRect(0, 0, 768, 994);
  context.fillStyle = '#10293a'; context.fillRect(0, 0, 768, 101); context.fillStyle = 'white'; context.font = 'bold 30px Arial'; context.fillText('ASTRA', 51, 60);
  context.font = '12px Arial'; context.fillStyle = '#bbd3dc'; context.fillText('MENSAJE ORIGINAL', 485, 58);
  context.font = '17px Arial'; context.fillStyle = '#2b424f'; let y = 155;
  for (const paragraph of text.slice(0, 14000).split('\n')) {
    let line = ''; for (const word of paragraph.split(/\s+/)) {
      const candidate = line ? `${line} ${word}` : word;
      if (context.measureText(candidate).width > 661 && line) { context.fillText(line, 52, y); y += 27; line = word; if (y > 914) break; } else line = candidate;
    }
    if (y > 914) break; if (line) context.fillText(line, 52, y); y += 34;
  }
  context.fillStyle = '#237f83'; context.fillRect(51, 946, 56, 3); context.fillStyle = '#90a3ad'; context.font = '11px Arial'; context.fillText('Vista previa del mensaje. El archivo UTF-8 completo se conserva.', 123, 952);
  return rgbaFromCanvas(canvas);
}
async function preparePreview(file, bytes) {
  if (file.type.startsWith('image/')) return imagePreview(file);
  if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) return pdfPreview(bytes);
  if (file.type.startsWith('text/') || /\.txt$/i.test(file.name)) return textPreview(file);
  return undefined;
}
function downloadName(name) { return name.replace(/\.[^.]+$/, '').replace(/[^\p{L}\p{N}._-]+/gu, '-').slice(0, 80) || 'archivo'; }
async function encode() {
  if (!state.file || state.busy || state.recording) return;
  const file = state.file; const serial = beginTask('sender');
  try {
    const bytes = await file.arrayBuffer(); progress('sender', 3, 'Preparando una vista del original…');
    let preview;
    try { preview = await preparePreview(file, bytes); } catch (error) {
      // A preview is optional: preserve and encode the complete original bytes.
      $('senderProgressText').textContent = 'La vista previa no está disponible. Conservaremos el archivo original completo.';
    }
    if (state.taskSerial !== serial) return;
    const target = await loadTarget(); if (state.taskSerial !== serial) return;
    const result = await runWorker('encode', { file: bytes, name: file.name, mime: file.type || 'application/octet-stream', preview, target }, 'sender');
    if (result.exact_file_recovery !== true) throw new Error('La conversión no confirmó la recuperación exacta del archivo. No se mostrará como verificada.');
    const art = new Blob([result.artwork], { type: 'image/png' }); const token = new Blob([result.token], { type: 'application/json' });
    const artURL = objectURL(art); const tokenURL = objectURL(token); const base = downloadName(file.name);
    $('artworkImage').src = artURL; $('artworkView').href = artURL;
    $('downloadArt').href = artURL; $('downloadArt').download = `${base}-ASTRA-obra.png`;
    $('downloadToken').href = tokenURL; $('downloadToken').download = `${base}-ASTRA-clave.json`;
    $('senderStats').replaceChildren(el('span', '', `${result.width} × ${result.height}`), el('span', '', `Clave: ${formatBytes(result.token_bytes ?? token.size)}`), el('span', '', `${formatNumber(result.pixel_count)} píxeles`));
    $('senderHash').textContent = `SHA-256 del archivo original: ${result.source_sha256}`;
    $('senderResult').classList.remove('hidden'); endTask('sender');
    if (window.innerWidth < 710) $('senderResult').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (error) { if (state.taskSerial === serial) { errorFor('sender', error.message || String(error)); endTask('sender', true); } }
}
function setReceived(kind, file) {
  if (!file || state.busy) return;
  const artwork = kind === 'art'; if (file.size > (artwork ? 180 : 80) * 1048576) { errorFor('receiver', 'Este archivo supera el tamaño admitido para la reconstrucción en el navegador.'); return; }
  state[artwork ? 'receivedArt' : 'receivedToken'] = file;
  $(artwork ? 'receivedArtName' : 'receivedTokenName').textContent = `${file.name} · ${formatBytes(file.size)}`;
  $(artwork ? 'artDrop' : 'tokenDrop').classList.add('selected'); $(artwork ? 'artDrop' : 'tokenDrop').querySelector('.file-plus').textContent = '✓'; errorFor('receiver'); updateButtons();
}
async function decode() {
  if (state.busy || !state.receivedArt || !state.receivedToken) return;
  const serial = beginTask('receiver');
  try {
    const [artwork, token] = await Promise.all([state.receivedArt.arrayBuffer(), state.receivedToken.arrayBuffer()]);
    if (state.taskSerial !== serial) return;
    const result = await runWorker('decode', { artwork, token }, 'receiver');
    if (result.exact_file_recovery !== true) throw new Error('La clave y la obra no confirmaron una recuperación exacta.');
    const file = new Blob([result.file], { type: result.mime || 'application/octet-stream' }); const url = objectURL(file);
    const name = result.name || result.filename || 'archivo-recuperado'; $('downloadRestored').href = url; $('downloadRestored').download = name;
    $('restoredFileInfo').replaceChildren(); const info = el('div'); info.append(el('strong', '', name), el('small', '', `${formatBytes(file.size)} · Archivo original completo`)); $('restoredFileInfo').append(el('span', '', '✓'), info);
    $('receiverHash').textContent = `SHA-256 verificado del archivo original y reconstruido: ${result.sha256 || result.source_sha256 || result.recovered_sha256}`;
    await showRestored(file, url, name); $('receiverResult').classList.remove('hidden'); endTask('receiver');
    if (window.innerWidth < 710) $('receiverResult').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (error) { if (state.taskSerial === serial) { errorFor('receiver', error.message || String(error)); endTask('receiver', true); } }
}
async function showRestored(blob, url, name) {
  const preview = $('restoredPreview'); preview.replaceChildren(); const mime = blob.type;
  if (mime.startsWith('image/')) { const image = el('img'); image.src = url; image.alt = 'Imagen original recuperada'; preview.append(image); }
  else if (mime.startsWith('audio/')) { const audio = el('audio'); audio.controls = true; audio.src = url; preview.append(audio); }
  else if (mime === 'application/pdf' || /\.pdf$/i.test(name)) { const frame = el('iframe'); frame.src = url; frame.title = 'Documento PDF original recuperado'; preview.append(frame); }
  else if (mime.startsWith('text/') || /\.txt$/i.test(name)) { const text = await blob.slice(0, 200000).text(); preview.append(el('pre', '', text)); }
}
async function copyReceiverLink() {
  const url = new URL(location.href); url.search = ''; url.hash = ''; url.searchParams.set('modo', 'recibir');
  try { await navigator.clipboard.writeText(url.href); toast('Enlace de recepción copiado. Comparte la obra y la clave por separado.'); }
  catch (_) { const input = el('textarea'); input.value = url.href; document.body.append(input); input.select(); const copied = document.execCommand('copy'); input.remove(); toast(copied ? 'Enlace de recepción copiado.' : `Enlace para recibir: ${url.href}`); }
}
function wavFile(record) {
  const count = record.chunks.reduce((sum, chunk) => sum + chunk.length, 0); const bytes = new ArrayBuffer(44 + count * 2); const view = new DataView(bytes);
  const ascii = (offset, text) => { for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i)); };
  ascii(0, 'RIFF'); view.setUint32(4, 36 + count * 2, true); ascii(8, 'WAVE'); ascii(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, record.rate, true); view.setUint32(28, record.rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true); ascii(36, 'data'); view.setUint32(40, count * 2, true);
  let offset = 44; for (const chunk of record.chunks) for (const sample of chunk) { const x = Math.max(-1, Math.min(1, sample)); view.setInt16(offset, Math.round(x < 0 ? x * 32768 : x * 32767), true); offset += 2; }
  return new File([bytes], `nota-de-voz-${new Date().toISOString().replace(/[:.]/g, '-')}.wav`, { type: 'audio/wav' });
}
async function startRecording() {
  if (state.busy || state.recording || state.preparingMicrophone) return;
  if (!navigator.mediaDevices?.getUserMedia) { errorFor('sender', 'Abre la página por HTTPS o desde localhost para usar el micrófono. También puedes seleccionar un archivo de audio.'); return; }
  state.preparingMicrophone = true; errorFor('sender'); updateButtons(); let stream, context;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    const AudioContext = window.AudioContext || window.webkitAudioContext; context = new AudioContext(); await context.resume();
    const source = context.createMediaStreamSource(stream); const processor = context.createScriptProcessor(4096, 1, 1);
    const record = { stream, context, source, processor, chunks: [], rate: context.sampleRate, bytes: 44, start: Date.now() };
    processor.onaudioprocess = event => { if (state.recording !== record) return; const chunk = new Float32Array(event.inputBuffer.getChannelData(0)); record.chunks.push(chunk); record.bytes += chunk.length * 2; if (record.bytes > MAX_FILE_BYTES - 16384) { stopRecording(false); toast('La nota alcanzó el tamaño máximo y está lista para convertir.'); } };
    state.recording = record; source.connect(processor); processor.connect(context.destination); $('recording').classList.remove('hidden'); $('recordTime').textContent = '00:00';
    record.timer = setInterval(() => { const seconds = Math.floor((Date.now() - record.start) / 1000); $('recordTime').textContent = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`; }, 250);
  } catch (error) {
    stream?.getTracks().forEach(track => track.stop()); if (context) await context.close().catch(() => {});
    errorFor('sender', error.name === 'NotAllowedError' ? 'No se concedió acceso al micrófono. Actívalo en los permisos del navegador o selecciona un audio.' : error.name === 'NotFoundError' ? 'No se encontró un micrófono. Puedes seleccionar un archivo de audio.' : `No se pudo iniciar la grabación: ${error.message}`);
  } finally { state.preparingMicrophone = false; updateButtons(); }
}
async function stopRecording(cancel) {
  const record = state.recording; if (!record) return; state.recording = null; clearInterval(record.timer); record.processor.onaudioprocess = null; record.source.disconnect(); record.processor.disconnect(); record.stream.getTracks().forEach(track => track.stop()); await record.context.close(); $('recording').classList.add('hidden'); updateButtons();
  if (!cancel && record.chunks.length) selectFile(wavFile(record)); else if (!cancel) toast('La nota fue demasiado breve. Inténtalo de nuevo.');
}
function setupDrop(node, callback) {
  node.addEventListener('dragover', event => { event.preventDefault(); if (!state.busy) node.classList.add('dragover'); });
  node.addEventListener('dragleave', () => node.classList.remove('dragover'));
  node.addEventListener('drop', event => { event.preventDefault(); node.classList.remove('dragover'); if (!state.busy) callback(event.dataTransfer.files[0]); });
}

$('senderTab').addEventListener('click', () => setMode('sender')); $('receiverTab').addEventListener('click', () => setMode('receiver'));
$('sourceFile').addEventListener('change', () => selectFile($('sourceFile').files[0])); $('receivedArt').addEventListener('change', () => setReceived('art', $('receivedArt').files[0])); $('receivedToken').addEventListener('change', () => setReceived('token', $('receivedToken').files[0]));
setupDrop($('sourceDrop'), selectFile); setupDrop($('artDrop'), file => setReceived('art', file)); setupDrop($('tokenDrop'), file => setReceived('token', file));
$('encodeButton').addEventListener('click', encode); $('decodeButton').addEventListener('click', decode); document.querySelectorAll('.cancel-task').forEach(button => button.addEventListener('click', cancelTask));
$('recordButton').addEventListener('click', startRecording); $('stopRecord').addEventListener('click', () => stopRecording(false)); $('cancelRecord').addEventListener('click', () => stopRecording(true));
$('textButton').addEventListener('click', () => { $('textEditor').classList.toggle('hidden'); if (!$('textEditor').classList.contains('hidden')) $('textInput').focus(); });
$('useText').addEventListener('click', () => { const text = $('textInput').value; if (!text.trim()) { errorFor('sender', 'Escribe tu mensaje antes de seleccionarlo.'); return; } selectFile(new File([text], 'mensaje-astra.txt', { type: 'text/plain' })); });
$('demoButton').addEventListener('click', async () => { if (state.busy) return; $('demoButton').disabled = true; errorFor('sender'); try { const response = await fetch(new URL('./assets/documento-ejemplo.pdf', location.href)); if (!response.ok) throw new Error('No se pudo cargar el documento de ejemplo. Puedes seleccionar tu propio archivo.'); const file = new File([await response.blob()], 'documento-ejemplo.pdf', { type: 'application/pdf' }); if (selectFile(file)) await encode(); } catch (error) { errorFor('sender', error.message); } finally { updateButtons(); } });
document.querySelectorAll('.copy-receiver').forEach(button => button.addEventListener('click', copyReceiverLink));
document.addEventListener('dragover', event => { if (event.dataTransfer?.types.includes('Files')) event.preventDefault(); }); document.addEventListener('drop', event => event.preventDefault());
window.addEventListener('beforeunload', () => { state.recording?.stream.getTracks().forEach(track => track.stop()); });
setMode(new URLSearchParams(location.search).get('modo') === 'recibir' ? 'receiver' : 'sender'); updateButtons();
if (!window.Worker || !window.crypto?.subtle) { $('compatibility').textContent = 'Usa un navegador actualizado y abre esta página mediante HTTPS para procesar y verificar archivos localmente.'; $('compatibility').classList.remove('hidden'); }
startWorker();
