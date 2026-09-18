'use strict';
import { loadIdentity, createIdentity, exportPublicIdentity, clearIdentity, loadRecipientBundle, fingerprintPublicBundle } from './identity-store.js';

const $ = id => document.getElementById(id);
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const state = { file: null, sourceURL: null, urls: [], workers: { classic: null, secure: null }, workerReady: new Set(), nextId: 1,
  pending: null, busy: false, activeMode: 'sender', recording: null,
  preparingMicrophone: false, receivedArt: null, receivedToken: null, target: null, taskSerial: 0,
  cover: 'mountain', coverFile: null, coverURL: null, identity: null, recipient: null,
  tokenFormat: null, tokenMode: null, secretURL: null, coverVersion: 0, mobileStep: 0, shareFiles: null };
const mobileScreen = window.matchMedia('(max-width: 760px)');
const el = (tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; };
const sharePackageButton = el('button', 'button secondary wide hidden', 'Compartir PNG y token ↗');
sharePackageButton.id = 'sharePackage'; sharePackageButton.type = 'button';
document.querySelector('.download-pair').after(sharePackageButton);
const formatBytes = bytes => bytes < 1024 ? `${bytes} B` : bytes < 1048576 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1048576).toFixed(2)} MB`;
const formatNumber = value => Number(value).toLocaleString('es-DO');
let toastTimer;
let resolveWorkerReady, rejectWorkerReady;
window.ASTRA_READY = new Promise((resolve, reject) => { resolveWorkerReady = resolve; rejectWorkerReady = reject; });
window.ASTRA_READY.catch(() => {});

function toast(message) { $('toast').textContent = message; $('toast').classList.remove('hidden'); clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').classList.add('hidden'), 5000); }
function errorFor(mode, message = '') { const node = $(mode + 'Error'); node.textContent = message; node.classList.toggle('hidden', !message); if (message && !state.busy) revealMobileError(mode); }
function objectURL(blob) { const url = URL.createObjectURL(blob); state.urls.push(url); return url; }
function revealMobileError(mode) {
  if (!mobileScreen.matches || state.activeMode !== mode) return;
  document.activeElement?.blur();
  requestAnimationFrame(() => {
    const error = $(mode + 'Error'); if (error.classList.contains('hidden')) { mobileScroll(); return; }
    const rect = error.getBoundingClientRect(), available = $('mobileDock').getBoundingClientRect().top;
    window.scrollTo({ top: Math.max(0, window.scrollY + rect.top - Math.max(16, (available - rect.height) / 2)), behavior: 'instant' });
  });
}
function mobileScroll() {
  if (!mobileScreen.matches) return;
  document.activeElement?.blur();
  requestAnimationFrame(() => {
    const target = state.activeMode === 'sender' ? $('composeSteps') : $('receiverPanel');
    target.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'start' });
  });
}
function syncMobile() {
  const receiving = state.activeMode === 'receiver';
  document.body.dataset.mobileStep = String(state.mobileStep);
  document.body.dataset.view = state.activeMode;
  $('composeSteps').classList.toggle('hidden', receiving);
  $('composeSteps').querySelectorAll('li').forEach((step, index) => {
    step.classList.toggle('current', index === state.mobileStep); step.classList.toggle('complete', index < state.mobileStep);
    if (index === state.mobileStep) step.setAttribute('aria-current', 'step'); else step.removeAttribute('aria-current');
  });
  $('mobileIntroTitle').textContent = receiving ? 'Abre tu mensaje.' : 'Comparte algo privado.';
  $('mobileIntroDescription').textContent = receiving ? 'Recupera el original desde tu teléfono.' : 'Tu archivo, protegido dentro de una imagen.';
  $('senderStepTitle').textContent = mobileScreen.matches && state.mobileStep === 1 ? 'Dale tu estilo' : 'Elige tu archivo';
  $('senderStepDescription').textContent = mobileScreen.matches && state.mobileStep === 1 ? 'Elige una portada y la calidad de la imagen.' : 'Se procesa en este dispositivo.';
  $('senderPanel').querySelector('.input-panel .step-number').textContent = mobileScreen.matches && state.mobileStep === 1 ? '02' : '01';
  $('senderPanel').querySelector('.output-panel .step-number').textContent = mobileScreen.matches ? '03' : '02';
  for (const [id, active] of [['mobileSendTab', !receiving], ['mobileReceiveTab', receiving]]) {
    $(id).classList.toggle('active', active); $(id).setAttribute('aria-pressed', String(active));
    $(id).disabled = state.busy || Boolean(state.recording) || state.preparingMicrophone;
  }
  const button = $('mobileAction'), back = $('mobileBack'), hint = $('mobileHint');
  const recovered = $('receiverPanel').classList.contains('has-result');
  back.classList.toggle('hidden', receiving ? !recovered : state.mobileStep === 0);
  back.disabled = state.busy || Boolean(state.recording) || state.preparingMicrophone;
  button.disabled = state.busy || state.preparingMicrophone;
  if (state.busy) { button.textContent = receiving ? 'Abriendo…' : 'Creando envío…'; hint.textContent = 'Procesando en tu dispositivo. Espera un momento.'; }
  else if (receiving) {
    button.textContent = recovered ? 'Guardar archivo original ↓' : 'Abrir y verificar →';
    button.disabled = !recovered && $('decodeButton').disabled;
    hint.textContent = recovered ? 'Archivo original recuperado y verificado.' : !state.receivedArt || !state.receivedToken ? 'Selecciona el PNG y el token que recibiste.' : state.tokenMode === 'secret' ? 'Introduce también la clave que recibiste aparte.' : 'Todo se reconstruye en tu navegador.';
  } else if (state.recording) { button.textContent = 'Terminar grabación ■'; hint.textContent = 'Tu nota de voz se está grabando.'; }
  else if (state.mobileStep === 0) {
    button.textContent = 'Elegir portada →'; button.disabled = !state.file || state.preparingMicrophone;
    hint.textContent = state.file ? `${state.file.name} · ${formatBytes(state.file.size)}` : 'Elige un archivo, escribe o graba una nota.';
  } else if (state.mobileStep === 1) {
    button.textContent = $('encodingMode').value === 'private' ? 'Crear envío privado →' : 'Crear envío sin cifrado →'; button.disabled = $('encodeButton').disabled;
    hint.textContent = button.disabled ? 'Confirma la identidad destinataria para continuar.' : $('encodingMode').value === 'private' ? 'Cifrado y verificado antes de compartir.' : 'El modo clásico no cifra el contenido.';
  } else { button.textContent = 'Editar mi envío'; hint.textContent = 'Guarda la obra, el token y tu clave por separado.'; }
  $('mobileEditReceived').classList.toggle('hidden', !recovered);
}
function setMobileStep(step) {
  if (state.busy || state.recording || state.preparingMicrophone) return;
  state.mobileStep = step; syncMobile(); mobileScroll();
}
function editReceived() {
  if (state.busy) return;
  $('receiverPanel').classList.remove('has-result'); syncMobile(); mobileScroll();
}
function setMode(mode) {
  if (state.busy || state.recording || state.preparingMicrophone) return;
  state.activeMode = mode; const receiving = mode === 'receiver';
  $('senderTab').classList.toggle('active', !receiving); $('senderTab').setAttribute('aria-pressed', String(!receiving));
  $('receiverTab').classList.toggle('active', receiving); $('receiverTab').setAttribute('aria-pressed', String(receiving));
  $('senderPanel').classList.toggle('hidden', receiving); $('receiverPanel').classList.toggle('hidden', !receiving);
  const url = new URL(location.href); if (receiving) url.searchParams.set('modo', 'recibir'); else url.searchParams.delete('modo'); history.replaceState({}, '', url);
  syncMobile();
}
function updateButtons() {
  const privateMode = $('encodingMode').value === 'private';
  const needsRecipient = privateMode && document.querySelector('input[name=accessMode]:checked').value === 'recipient';
  $('encodeButton').disabled = state.busy || !state.file || Boolean(state.recording) || state.preparingMicrophone || needsRecipient && (!state.recipient || !$('recipientVerified').checked);
  $('decodeButton').disabled = state.busy || !state.receivedArt || !state.receivedToken;
  for (const id of ['sourceFile', 'receivedArt', 'receivedToken', 'recordButton', 'demoButton', 'textButton', 'useText', 'encodingMode', 'coverFile', 'coverFormat', 'coverResolution', 'coverStyle', 'recipientFile', 'recipientVerified', 'createIdentity', 'clearIdentity']) $(id).disabled = state.busy || Boolean(state.recording) || state.preparingMicrophone;
  document.querySelectorAll('.cover-choice,input[name=accessMode]').forEach(node => { node.disabled = state.busy; });
  $('useSourceCover').disabled = state.busy || !state.file?.type.startsWith('image/');
  $('recordButton').disabled = state.busy || Boolean(state.recording) || state.preparingMicrophone;
  $('senderTab').disabled = $('receiverTab').disabled = state.busy || Boolean(state.recording) || state.preparingMicrophone;
  syncMobile();
}
function progress(mode, percent, message) {
  $(mode + 'Stage').textContent = message || (mode === 'sender' ? 'Creando tu envío…' : 'Reconstruyendo…');
  const value = Math.max(0, Math.min(100, Number(percent) || 0));
  $(mode + 'ProgressBar').value = value; $(mode + 'Percent').textContent = `${Math.round(value)}%`;
}
function beginTask(mode) {
  const serial = ++state.taskSerial;
  $(mode + 'Panel').classList.add('is-processing'); $(mode + 'Panel').classList.remove('has-result');
  if (mode === 'sender') state.mobileStep = 2;
  state.busy = true; errorFor(mode); $(mode + 'Empty').classList.add('hidden'); $(mode + 'Result').classList.add('hidden'); $(mode + 'Progress').classList.remove('hidden');
  $(mode + 'ProgressText').textContent = mode === 'sender' ? 'El procesamiento ocurre en tu navegador.' : 'Comprobando la obra y su clave.';
  progress(mode, 0, mode === 'sender' ? 'Preparando el archivo…' : 'Leyendo la obra y su clave…'); updateButtons(); mobileScroll(); return serial;
}
function endTask(mode, failed = false) {
  state.busy = false; $(mode + 'Progress').classList.add('hidden');
  $(mode + 'Panel').classList.remove('is-processing');
  $(mode + 'Panel').classList.toggle('has-result', !failed);
  if (failed) { $(mode + 'Empty').classList.remove('hidden'); if (mode === 'sender') state.mobileStep = state.file ? 1 : 0; }
  updateButtons(); if (failed) revealMobileError(mode);
}
function startWorker(engine) {
  try {
    const worker = new Worker(new URL(engine === 'secure' ? './secure-worker.js' : './codec-worker.js', location.href), { type: 'module' }); state.workers[engine] = worker;
    worker.onmessage = event => {
      const data = event.data || {};
      if (data.type === 'ready') { state.workerReady.add(engine); document.body.dataset[engine + 'WorkerReady'] = 'true'; if (state.workerReady.size === 2) { document.body.dataset.workerReady = 'true'; resolveWorkerReady(true); } return; }
      const job = state.pending; if (!job || String(data.id) !== String(job.id)) return;
      if (data.type === 'progress') { progress(job.mode, data.percent ?? data.progress, data.message); return; }
      if (data.type === 'result') { state.pending = null; job.resolve(data); }
      else if (data.type === 'error') { state.pending = null; const error = new Error(data.message || data.error || 'No se pudo completar la operación.'); Object.assign(error, { code: data.code, required: data.required_ciphertext_bytes, capacity: data.max_ciphertext_bytes }); job.reject(error); }
    };
    worker.onerror = event => {
      const message = event.message || 'No se pudo cargar el motor de conversión. Recarga la página y vuelve a intentarlo.';
      if (state.pending?.engine === engine) { const job = state.pending; state.pending = null; job.reject(new Error(message)); }
      rejectWorkerReady(new Error(message));
      $('compatibility').textContent = 'No se pudo cargar el motor de conversión. Recarga la página cuando tengas conexión.'; $('compatibility').classList.remove('hidden');
    };
  } catch (error) {
    rejectWorkerReady(error); $('compatibility').textContent = 'Abre esta página mediante HTTPS en un navegador actualizado para usar la conversión local.'; $('compatibility').classList.remove('hidden');
  }
}
function runWorker(action, data, mode, engine = 'classic') {
  if (!state.workers[engine]) startWorker(engine);
  if (!state.workers[engine]) return Promise.reject(new Error('El motor de conversión no está disponible.'));
  return new Promise((resolve, reject) => {
    const id = state.nextId++; state.pending = { id, resolve, reject, mode, engine };
    const transfer = []; for (const key of ['file', 'artwork', 'token']) if (data[key] instanceof ArrayBuffer) transfer.push(data[key]);
    if (data.preview?.data instanceof ArrayBuffer) transfer.push(data.preview.data);
    if (data.cover?.data instanceof ArrayBuffer) transfer.push(data.cover.data);
    // The cached target remains reusable; do not transfer/detach its buffer.
    state.workers[engine].postMessage({ id, action, ...data }, transfer);
  });
}
function cancelTask() {
  if (!state.busy) return;
  state.taskSerial++;
  const mode = state.pending?.mode || state.activeMode;
  const engine = state.pending?.engine;
  if (state.pending) { state.pending.reject(new Error('Operación cancelada. Puedes volver a intentarlo.')); state.pending = null; }
  if (engine) { state.workers[engine]?.terminate(); state.workers[engine] = null; state.workerReady.delete(engine); startWorker(engine); }
  endTask(mode, true); toast('Operación cancelada.');
}
function clearFile() {
  if (state.busy || state.recording) return;
  if (state.sourceURL) URL.revokeObjectURL(state.sourceURL); state.sourceURL = null; state.file = null;
  $('sourceFile').value = ''; $('selectedFile').replaceChildren(); $('selectedFile').classList.add('hidden'); updateButtons();
  if (state.cover === 'source') chooseCover('mountain');
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
  $('senderPanel').classList.remove('has-result');
  updateButtons(); return true;
}
function scaledDimensions(width, height, maxPixels = 900000) { const scale = Math.min(1, Math.sqrt(maxPixels / (width * height))); return [Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale))]; }
function rgbaFromCanvas(canvas) { return { width: canvas.width, height: canvas.height, channels: 4, data: canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, canvas.width, canvas.height).data.buffer }; }
function coverDimensions() {
  const edge = Number($('coverResolution').value), format = $('coverFormat').value;
  return format === 'square' ? [edge, edge] : format === 'portrait' ? [Math.round(edge * 2 / 3), edge] : [edge, Math.round(edge * 2 / 3)];
}
function describeCover() {
  const [width, height] = coverDimensions(), image = $('coverReference');
  $('coverDimensions').textContent = `${formatNumber(width)} × ${formatNumber(height)} píxeles de salida`;
  if (image.naturalWidth) {
    const scale = Math.max(width / image.naturalWidth, height / image.naturalHeight);
    $('coverScaleNote').textContent = `Referencia: ${formatNumber(image.naturalWidth)} × ${formatNumber(image.naturalHeight)}. ${scale > 1.001 ? 'La imagen se amplía; el tamaño de salida no añade detalle nativo.' : 'Se ajusta y recorta al formato elegido.'}`;
  }
  image.dataset.style = $('coverStyle').value;
}
function chooseCover(kind, file = null) {
  if (state.busy) return;
  if (state.coverURL) { URL.revokeObjectURL(state.coverURL); state.coverURL = null; }
  state.cover = kind; state.coverFile = file; state.coverVersion++;
  document.querySelectorAll('.cover-choice').forEach(button => { const selected = button.dataset.cover === kind; button.classList.toggle('selected', selected); button.setAttribute('aria-pressed', String(selected)); });
  const custom = kind === 'custom' || kind === 'source'; const info = $('customCoverInfo'); info.replaceChildren(); info.classList.toggle('hidden', !custom);
  if (custom) {
    const selectedFile = kind === 'source' ? state.file : file;
    if (!selectedFile) return;
    state.coverURL = URL.createObjectURL(selectedFile); $('coverReference').src = state.coverURL;
    info.append(el('strong', '', kind === 'source' ? 'La imagen del mensaje será la portada visible.' : 'Portada personalizada visible.'), el('span', '', selectedFile.name));
  } else $('coverReference').src = new URL(`./assets/${kind}.png`, location.href).href;
  describeCover();
}
async function prepareCover() {
  let blob;
  if (state.cover === 'custom') blob = state.coverFile;
  else if (state.cover === 'source') blob = state.file;
  else { const response = await fetch(new URL(`./assets/${state.cover}.png`, location.href)); if (!response.ok) throw new Error('No se pudo cargar esta portada. Elige otra imagen o sube una propia.'); blob = await response.blob(); }
  if (!blob) throw new Error('Selecciona una imagen de portada.');
  const bitmap = await createImageBitmap(blob);
  try {
    const [width, height] = coverDimensions(); const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
    const context = canvas.getContext('2d', { willReadFrequently: true }); context.fillStyle = '#ffffff'; context.fillRect(0, 0, width, height);
    context.filter = $('coverStyle').value === 'vivid' ? 'saturate(1.22) contrast(1.06)' : $('coverStyle').value === 'cinematic' ? 'saturate(0.88) contrast(1.14) sepia(0.08)' : 'none';
    const scale = Math.max(width / bitmap.width, height / bitmap.height), drawnWidth = bitmap.width * scale, drawnHeight = bitmap.height * scale;
    context.drawImage(bitmap, (width - drawnWidth) / 2, (height - drawnHeight) / 2, drawnWidth, drawnHeight); context.filter = 'none';
    return rgbaFromCanvas(canvas);
  } finally { bitmap.close(); }
}
function updateEncodingMode() {
  const privateMode = $('encodingMode').value === 'private';
  $('coverControls').classList.toggle('hidden', !privateMode); $('protectionControls').classList.toggle('hidden', !privateMode);
  $('advancedAccess').classList.toggle('hidden', !privateMode); $('encodingSummary').textContent = privateMode ? 'Privado' : 'Sin cifrado';
  $('modeExplanation').textContent = privateMode ? 'Una portada a color transporta el archivo cifrado. Para recuperarlo hacen falta la obra, el token y la clave secreta o la identidad destinataria.' : 'Reorganiza los píxeles de una representación del archivo y conserva su paleta. La obra y el token permiten recuperarlo sin una clave secreta. Este modo no cifra el contenido.';
  $('encodeButton').replaceChildren(document.createTextNode(privateMode ? 'Crear envío privado' : 'Crear permutación clásica'), el('span', '', '→'));
  $('senderOutputSubtitle').textContent = privateMode ? 'Obra y token. El acceso se comparte por separado.' : 'Obra y token. Permutación clásica sin cifrado.';
  $('senderResult').classList.add('hidden'); $('senderEmpty').classList.remove('hidden'); updateButtons();
}
async function refreshIdentity() {
  try { state.identity = await loadIdentity(); }
  catch (error) { state.identity = null; $('identityStatus').textContent = `No se pudo acceder al almacenamiento de identidad: ${error.message}`; return; }
  const exists = Boolean(state.identity); $('createIdentity').classList.toggle('hidden', exists); $('exportIdentity').classList.toggle('hidden', !exists); $('clearIdentity').classList.toggle('hidden', !exists); $('identityFingerprint').classList.toggle('hidden', !exists);
  $('identityStatus').textContent = exists ? 'Identidad local lista. La clave privada permanece en este navegador.' : 'No hay una identidad de recepción guardada.';
  if (exists) $('identityFingerprint').textContent = await fingerprintPublicBundle(state.identity.publicBundle);
  updateReceiverAccess();
}
function updateReceiverAccess() {
  const privateMode = state.tokenFormat === 'ASTRA-SECURE-V2'; $('receiverAccess').classList.toggle('hidden', !state.tokenFormat);
  $('receiverFormatLabel').textContent = privateMode ? 'Envío privado cifrado · ASTRA-SECURE-V2' : state.tokenFormat === 'ASTRA-MSG-V1' ? 'Permutación clásica sin cifrado · ASTRA-MSG-V1' : 'Formato pendiente de validación';
  const recipientMode = privateMode && state.tokenMode === 'recipient';
  $('receiverSecretFields').classList.toggle('hidden', !privateMode || recipientMode); $('receiverIdentityInfo').classList.toggle('hidden', !recipientMode);
  if (recipientMode) $('receiverIdentityInfo').textContent = state.identity ? 'Se usará la identidad privada guardada en este navegador. Solo una identidad coincidente puede abrir el envío.' : 'Este envío requiere la identidad destinataria que ya existía al enviarlo. Abre esta página en el navegador donde guardaste esa identidad; crear otra no recupera la anterior.';
}
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
  context.fillStyle = '#10293a'; context.fillRect(0, 0, 768, 101); context.fillStyle = 'white'; context.font = 'bold 30px Arial'; context.fillText('NEBO AI - SECURITY', 51, 60);
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
  const privateMode = $('encodingMode').value === 'private'; const accessMode = document.querySelector('input[name=accessMode]:checked').value;
  if (privateMode && accessMode === 'recipient' && (!state.recipient || !$('recipientVerified').checked)) { errorFor('sender', 'Carga la identidad pública y confirma su huella por otro canal.'); return; }
  const file = state.file; const serial = beginTask('sender');
  try {
    const bytes = await file.arrayBuffer(); let result;
    if (privateMode) {
      progress('sender', 3, 'Preparando la portada de alta resolución…');
      const cover = await prepareCover(); if (state.taskSerial !== serial) return;
      result = await runWorker('encode', { file: bytes, name: file.name, mime: file.type || 'application/octet-stream', cover, ...(accessMode === 'recipient' ? { recipient: state.recipient } : {}) }, 'sender', 'secure');
    } else {
      progress('sender', 3, 'Preparando una vista del original…'); let preview;
      try { preview = await preparePreview(file, bytes); } catch (error) { $('senderProgressText').textContent = 'La vista previa no está disponible. Conservaremos el archivo original completo.'; }
      if (state.taskSerial !== serial) return;
      const target = await loadTarget(); if (state.taskSerial !== serial) return;
      result = await runWorker('encode', { file: bytes, name: file.name, mime: file.type || 'application/octet-stream', preview, target }, 'sender', 'classic');
    }
    if (result.exact_file_recovery !== true) throw new Error('La conversión no confirmó la recuperación exacta del archivo. No se mostrará como verificada.');
    const art = new Blob([result.artwork], { type: 'image/png' }); const token = new Blob([result.token], { type: 'application/json' });
    const artURL = objectURL(art); const tokenURL = objectURL(token); const base = privateMode ? 'NEBO-SECURITY-envio-privado' : downloadName(file.name);
    $('artworkImage').src = artURL; $('artworkView').href = artURL;
    $('downloadArt').href = artURL; $('downloadArt').download = `${base}-NEBO-obra.png`;
    $('downloadToken').href = tokenURL; $('downloadToken').download = `${base}-NEBO-token.json`;
    // Share only the transport files. The recovery secret never enters this list.
    state.shareFiles = [new File([art], `${base}-NEBO-obra.png`, { type: 'image/png' }), new File([token], `${base}-NEBO-token.txt`, { type: 'text/plain' })];
    let canShare = false; try { canShare = Boolean(navigator.share && navigator.canShare?.({ files: state.shareFiles })); } catch (_) {}
    sharePackageButton.classList.toggle('hidden', !canShare);
    $('artworkCaption').textContent = privateMode ? 'Imagen portadora con datos cifrados; utiliza colores de referencia. No es una permutación del documento.' : 'Permutación clásica de la representación del archivo. Conserva sus píxeles y su paleta; no cifra el contenido.';
    $('senderStats').replaceChildren(el('span', '', `${result.width} × ${result.height}`), el('span', '', `Token: ${formatBytes(result.token_bytes ?? token.size)}`), el('span', '', `${formatNumber(result.pixel_count)} píxeles`));
    if (privateMode) $('senderStats').append(el('span', '', `${result.bits_per_channel ?? result.bits} bits por canal`));
    $('secretResult').classList.add('hidden'); $('recipientResult').classList.add('hidden'); $('recoverySecret').value = '';
    if (state.secretURL) { URL.revokeObjectURL(state.secretURL); state.secretURL = null; }
    if (privateMode && result.recovery_secret) {
      $('recoverySecret').value = result.recovery_secret; $('recoverySecret').type = 'password'; $('showSecret').textContent = 'Mostrar'; $('showSecret').setAttribute('aria-pressed', 'false');
      state.secretURL = objectURL(new Blob([result.recovery_secret + '\n'], { type: 'text/plain' })); $('downloadSecret').href = state.secretURL; $('downloadSecret').download = 'NEBO-SECURITY-clave-secreta.key.txt'; $('secretResult').classList.remove('hidden');
    } else if (privateMode) {
      $('recipientResult').replaceChildren(el('strong', '', 'Protegido para la identidad destinataria'), el('code', 'fingerprint', await fingerprintPublicBundle(state.recipient))); $('recipientResult').classList.remove('hidden');
    }
    $('conservationExplanation').textContent = privateMode ? 'El archivo original, su nombre y sus metadatos de recuperación se cifran con AES-256-GCM. Los datos cifrados se insertan en los bits menos significativos de la portada visible. El token permite localizar y autenticar el contenido; requiere además la clave secreta o la identidad privada destinataria.' : 'La representación reversible incluye el archivo original completo y, cuando está disponible, una vista previa. Una permutación conserva todos los píxeles de esa representación. La obra y el token bastan para recuperar el original; no hay cifrado.';
    $('senderHash').textContent = `SHA-256 del archivo original: ${result.source_sha256}`;
    $('senderResult').classList.remove('hidden'); endTask('sender');
    mobileScroll();
  } catch (error) { if (state.taskSerial === serial) { errorFor('sender', error.code === 'CAPACITY' ? `El archivo no cabe en la portada elegida${error.capacity ? ` (capacidad: ${formatBytes(error.capacity)})` : ''}. Selecciona una resolución mayor; para los archivos más grandes usa Cuadrado · 4096 px.` : error.message || String(error)); endTask('sender', true); } }
}
async function setReceived(kind, file) {
  if (!file || state.busy) return;
  const artwork = kind === 'art'; if (file.size > (artwork ? 180 : 80) * 1048576) { errorFor('receiver', 'Este archivo supera el tamaño admitido para la reconstrucción en el navegador.'); return; }
  state[artwork ? 'receivedArt' : 'receivedToken'] = file;
  $('receiverPanel').classList.remove('has-result'); $('receiverResult').classList.add('hidden');
  $(artwork ? 'receivedArtName' : 'receivedTokenName').textContent = `${file.name} · ${formatBytes(file.size)}`;
  $(artwork ? 'artDrop' : 'tokenDrop').classList.add('selected'); $(artwork ? 'artDrop' : 'tokenDrop').querySelector('.file-plus').textContent = '✓'; errorFor('receiver');
  if (!artwork) {
    try { const token = JSON.parse(await file.text()); if (state.receivedToken !== file) return; state.tokenFormat = token.format; state.tokenMode = token.mode; }
    catch (_) { state.tokenFormat = null; state.tokenMode = null; errorFor('receiver', 'No se pudo leer el token como JSON. Selecciona el archivo original que acompaña al PNG.'); }
    updateReceiverAccess();
  }
  updateButtons();
}
async function decode() {
  if (state.busy || !state.receivedArt || !state.receivedToken) return;
  const serial = beginTask('receiver');
  try {
    const [artwork, token] = await Promise.all([state.receivedArt.arrayBuffer(), state.receivedToken.arrayBuffer()]);
    if (state.taskSerial !== serial) return;
    const header = JSON.parse(new TextDecoder().decode(token)); const privateMode = header.format === 'ASTRA-SECURE-V2';
    let access = {};
    if (privateMode && header.mode === 'recipient') {
      state.identity = await loadIdentity();
      if (!state.identity) throw new Error('Este envío requiere la identidad privada destinataria. Ábrelo en el navegador donde guardaste esa identidad.');
      access = { privateKey: state.identity.privateKey, recipientPublic: state.identity.publicBundle };
    } else if (privateMode) {
      const secret = $('receivedSecret').value.trim(); if (!secret) throw new Error('Pega la clave secreta que recibiste por separado. La obra y el token no bastan para abrir este envío privado.'); access = { secret };
    }
    const result = await runWorker('decode', { artwork, token, ...access }, 'receiver', privateMode ? 'secure' : 'classic');
    if (result.exact_file_recovery !== true) throw new Error('La clave y la obra no confirmaron una recuperación exacta.');
    const file = new Blob([result.file], { type: result.mime || 'application/octet-stream' }); const url = objectURL(file);
    const name = result.name || result.filename || 'archivo-recuperado'; $('downloadRestored').href = url; $('downloadRestored').download = name;
    $('restoredFileInfo').replaceChildren(); const info = el('div'); info.append(el('strong', '', name), el('small', '', `${formatBytes(file.size)} · Archivo original completo`)); $('restoredFileInfo').append(el('span', '', '✓'), info);
    $('receiverHash').textContent = `SHA-256 verificado del archivo original y reconstruido: ${result.sha256 || result.source_sha256 || result.recovered_sha256}`;
    await showRestored(file, url, name); $('receiverResult').classList.remove('hidden'); endTask('receiver');
    mobileScroll();
  } catch (error) { if (state.taskSerial === serial) { errorFor('receiver', error.message || String(error)); endTask('receiver', true); } }
}
async function showRestored(blob, url, name) {
  const preview = $('restoredPreview'); preview.replaceChildren(); const mime = blob.type;
  if (mime.startsWith('image/')) { const image = el('img'); image.src = url; image.alt = 'Imagen original recuperada'; preview.append(image); }
  else if (mime.startsWith('audio/')) { const audio = el('audio'); audio.controls = true; audio.src = url; preview.append(audio); }
  else if (mime === 'application/pdf') {
    // Recovered documents are untrusted. Never execute them in a same-origin
    // iframe, including a file whose authenticated name merely ends in .pdf.
    const card = el('div', 'pdf-safe-card'); card.append(el('span', 'file-type', 'PDF'), el('strong', '', 'Documento original recuperado'), el('p', '', 'El archivo se ha verificado. Descárgalo para abrirlo en tu visor de documentos.')); preview.append(card);
  }
  else if (mime.startsWith('text/') || /\.txt$/i.test(name)) { const text = await blob.slice(0, 200000).text(); preview.append(el('pre', '', text)); }
}
async function copyReceiverLink() {
  const url = new URL(location.href); url.search = ''; url.hash = ''; url.searchParams.set('modo', 'recibir');
  try { await navigator.clipboard.writeText(url.href); toast('Enlace de recepción copiado. Comparte la obra y la clave por separado.'); }
  catch (_) { const input = el('textarea'); input.value = url.href; document.body.append(input); input.select(); const copied = document.execCommand('copy'); input.remove(); toast(copied ? 'Enlace de recepción copiado.' : `Enlace para recibir: ${url.href}`); }
}
async function copySecret() {
  const secret = $('recoverySecret').value; if (!secret) return;
  try { await navigator.clipboard.writeText(secret); toast('Clave copiada. Compártela por un canal distinto.'); }
  catch (_) { toast('No se pudo copiar automáticamente. Usa Mostrar y selecciona la clave.'); }
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
$('mobileSendTab').addEventListener('click', () => { setMode('sender'); mobileScroll(); });
$('mobileReceiveTab').addEventListener('click', () => { setMode('receiver'); mobileScroll(); });
$('mobileBack').addEventListener('click', () => { if (state.activeMode === 'receiver') editReceived(); else setMobileStep(Math.max(0, state.mobileStep - 1)); });
$('mobileEditReceived').addEventListener('click', editReceived);
$('mobileAction').addEventListener('click', () => {
  if (state.busy || state.preparingMicrophone) return;
  if (state.activeMode === 'receiver') {
    if ($('receiverPanel').classList.contains('has-result')) $('downloadRestored').click(); else decode();
  } else if (state.recording) stopRecording(false);
  else if (state.mobileStep === 0 && state.file) setMobileStep(1);
  else if (state.mobileStep === 1) encode();
  else if (state.mobileStep === 2) setMobileStep(1);
});
$('sourceFile').addEventListener('change', () => selectFile($('sourceFile').files[0])); $('receivedArt').addEventListener('change', () => setReceived('art', $('receivedArt').files[0])); $('receivedToken').addEventListener('change', () => setReceived('token', $('receivedToken').files[0]));
setupDrop($('sourceDrop'), selectFile); setupDrop($('artDrop'), file => setReceived('art', file)); setupDrop($('tokenDrop'), file => setReceived('token', file));
$('encodeButton').addEventListener('click', encode); $('decodeButton').addEventListener('click', decode); document.querySelectorAll('.cancel-task').forEach(button => button.addEventListener('click', cancelTask));
$('recordButton').addEventListener('click', startRecording); $('stopRecord').addEventListener('click', () => stopRecording(false)); $('cancelRecord').addEventListener('click', () => stopRecording(true));
$('textButton').addEventListener('click', () => { $('textEditor').classList.toggle('hidden'); if (!$('textEditor').classList.contains('hidden')) $('textInput').focus(); });
$('useText').addEventListener('click', () => { const text = $('textInput').value; if (!text.trim()) { errorFor('sender', 'Escribe tu mensaje antes de seleccionarlo.'); return; } selectFile(new File([text], 'mensaje-nebo.txt', { type: 'text/plain' })); });
$('demoButton').addEventListener('click', async () => { if (state.busy) return; $('demoButton').disabled = true; errorFor('sender'); try { const response = await fetch(new URL('./assets/documento-ejemplo.pdf', location.href)); if (!response.ok) throw new Error('No se pudo cargar el documento de ejemplo. Puedes seleccionar tu propio archivo.'); const file = new File([await response.blob()], 'documento-ejemplo.pdf', { type: 'application/pdf' }); if (selectFile(file)) { if (mobileScreen.matches) setMobileStep(1); else await encode(); } } catch (error) { errorFor('sender', error.message); } finally { updateButtons(); } });
document.querySelectorAll('.copy-receiver').forEach(button => button.addEventListener('click', copyReceiverLink));
document.querySelectorAll('.cover-choice').forEach(button => button.addEventListener('click', () => chooseCover(button.dataset.cover)));
$('encodingMode').addEventListener('change', updateEncodingMode);
$('coverReference').addEventListener('load', describeCover);
$('coverReference').addEventListener('error', () => { $('coverScaleNote').textContent = 'No se pudo cargar la referencia. Selecciona otra portada o sube una imagen.'; });
$('coverFormat').addEventListener('change', () => { const square = $('coverFormat').value === 'square'; $('coverResolution').querySelector('option[value="4096"]').disabled = !square; if (!square && $('coverResolution').value === '4096') $('coverResolution').value = '3840'; describeCover(); });
$('coverResolution').addEventListener('change', describeCover); $('coverStyle').addEventListener('change', describeCover);
$('coverFile').addEventListener('change', () => { const file = $('coverFile').files[0]; if (!file) return; if (!file.type.startsWith('image/') || file.size > MAX_FILE_BYTES) { errorFor('sender', 'Selecciona una imagen de portada de hasta 20 MB.'); return; } chooseCover('custom', file); });
$('useSourceCover').addEventListener('click', () => { if (state.file?.type.startsWith('image/')) chooseCover('source'); });
document.querySelectorAll('input[name=accessMode]').forEach(input => input.addEventListener('change', () => { const recipient = document.querySelector('input[name=accessMode]:checked').value === 'recipient'; $('recipientControls').classList.toggle('hidden', !recipient); $('accessSummary').textContent = recipient ? 'Identidad destinataria' : 'Clave secreta'; updateButtons(); }));
$('recipientFile').addEventListener('change', async () => {
  state.recipient = null; $('recipientVerified').checked = false; $('recipientSummary').classList.add('hidden'); updateButtons(); const file = $('recipientFile').files[0]; if (!file) return;
  try { state.recipient = await loadRecipientBundle(file); $('recipientFingerprint').textContent = await fingerprintPublicBundle(state.recipient); $('recipientSummary').classList.remove('hidden'); errorFor('sender'); }
  catch (error) { errorFor('sender', error.message); } updateButtons();
});
$('recipientVerified').addEventListener('change', updateButtons);
$('showSecret').addEventListener('click', () => { const show = $('recoverySecret').type === 'password'; $('recoverySecret').type = show ? 'text' : 'password'; $('showSecret').textContent = show ? 'Ocultar' : 'Mostrar'; $('showSecret').setAttribute('aria-pressed', String(show)); });
$('copySecret').addEventListener('click', copySecret);
sharePackageButton.addEventListener('click', async () => {
  if (!state.shareFiles || state.busy) return;
  sharePackageButton.disabled = true;
  try { await navigator.share({ files: state.shareFiles, title: 'Envío NEBO AI - SECURITY' }); toast('Recuerda compartir la clave secreta por otro canal.'); }
  catch (error) { if (error.name !== 'AbortError') toast('Este dispositivo no pudo compartir los archivos. Usa los botones de descarga.'); }
  finally { sharePackageButton.disabled = false; }
});
$('receivedSecretFile').addEventListener('change', async () => { const file = $('receivedSecretFile').files[0]; if (!file) return; if (file.size > 2048) { errorFor('receiver', 'Este archivo no parece una clave secreta NEBO. Selecciona el archivo .key.txt que recibiste.'); return; } const secret = (await file.text()).trim(); if (!/^[A-Za-z0-9_-]{43}$/.test(secret)) { errorFor('receiver', 'La clave debe contener los 43 caracteres de la clave secreta NEBO.'); return; } $('receivedSecret').value = secret; errorFor('receiver'); toast('Clave secreta cargada en este navegador.'); });
$('createIdentity').addEventListener('click', async () => { $('createIdentity').disabled = true; try { state.identity = await createIdentity(); await refreshIdentity(); toast('Identidad creada. Descarga su archivo público para compartirlo.'); } catch (error) { $('identityStatus').textContent = error.message; } finally { updateButtons(); } });
$('exportIdentity').addEventListener('click', async () => { try { const json = await exportPublicIdentity(state.identity); const link = el('a'); link.href = objectURL(new Blob([json], { type: 'application/json' })); link.download = 'NEBO-SECURITY-identidad-publica.json'; document.body.append(link); link.click(); link.remove(); } catch (error) { $('identityStatus').textContent = error.message; } });
$('clearIdentity').addEventListener('click', async () => { if (!window.confirm('Si eliminas esta identidad, no podrás abrir los envíos dirigidos a ella. ¿Eliminar identidad de este navegador?')) return; try { await clearIdentity(); await refreshIdentity(); toast('Identidad local eliminada.'); } catch (error) { $('identityStatus').textContent = error.message; } });
document.addEventListener('dragover', event => { if (event.dataTransfer?.types.includes('Files')) event.preventDefault(); }); document.addEventListener('drop', event => event.preventDefault());
window.addEventListener('beforeunload', () => { state.recording?.stream.getTracks().forEach(track => track.stop()); });
function applyResponsiveLayout() {
  $('advancedOptions').open = !mobileScreen.matches;
  $('advancedAccess').open = !mobileScreen.matches || document.querySelector('input[name=accessMode]:checked').value === 'recipient';
  const names = mobileScreen.matches ? ['Horizontal', 'Vertical', 'Cuadrado'] : ['Horizontal · 3:2', 'Vertical · 2:3', 'Cuadrado · 1:1'];
  Array.from($('coverFormat').options).forEach((option, i) => { option.textContent = names[i]; });
  $('sourceDrop').querySelector('small').textContent = mobileScreen.matches ? 'Hasta 20 MB · Sin subirlo al servidor' : 'Imágenes, PDF, texto y audio · Hasta 20 MB';
  syncMobile();
}
mobileScreen.addEventListener('change', applyResponsiveLayout);
document.querySelector('.help-link').addEventListener('click', () => { document.body.classList.add('mobile-help-open'); });
applyResponsiveLayout();
setMode(new URLSearchParams(location.search).get('modo') === 'recibir' ? 'receiver' : 'sender'); updateEncodingMode(); describeCover();
if (!window.Worker || !window.crypto?.subtle) { $('compatibility').textContent = 'Usa un navegador actualizado y abre esta página mediante HTTPS para procesar y verificar archivos localmente.'; $('compatibility').classList.remove('hidden'); }
startWorker('classic'); startWorker('secure'); refreshIdentity();
