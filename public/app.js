'use strict';
import { loadIdentity, createIdentity, exportPublicIdentity, clearIdentity, loadRecipientBundle, fingerprintPublicBundle } from './identity-store.js';
import { createBundle, readBundle, isBundleMime, estimateBundleSize, MAX_BUNDLE_ITEMS, BUNDLE_MIME } from './bundle.js';
import { estimateCiphertextBytes } from './secure-worker.js';
import { unpackPortablePNG } from './portable-png.js';
import { planCover } from './cover-planner.js';
import { listContacts, saveContact, removeContact } from './contact-store.js';
import { initInstallUI } from './install.js?v=10';

const $ = id => document.getElementById(id);
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const state = { file: null, items: [], nextItemId: 1, receivedCount: 1, receivedBundle: false, locating: false, locationRequest: 0, locationFix: null, urls: [], workers: { classic: null, secure: null }, workerReady: new Set(), nextId: 1,
  pending: null, busy: false, activeMode: 'sender', recording: null,
  preparingMicrophone: false, receivedArt: null, receivedToken: null, embeddedToken: null, inspectingArt: false, receiveSerial: 0, receivedPreviewURL: null, target: null, taskSerial: 0,
  cover: 'mountain', coverFile: null, coverURL: null, identity: null, recipient: null,
  tokenFormat: null, tokenMode: null, secretURL: null, coverVersion: 0, mobileStep: 0, shareFiles: null, contacts: [], contactBusy: false, recipientSerial: 0, recipientLoading: false };
const mobileScreen = window.matchMedia('(max-width: 760px)');
const el = (tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; };
const sharePackageButton = el('button', 'button secondary wide hidden', 'Compartir imagen ↗');
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
  $('mobileIntroDescription').textContent = receiving ? 'Recupera todos los elementos del envío.' : 'Archivos, mensajes y ubicación en una sola imagen.';
  $('senderStepTitle').textContent = mobileScreen.matches && state.mobileStep === 1 ? 'Dale tu estilo' : 'Prepara tu envío';
  $('senderStepDescription').textContent = mobileScreen.matches && state.mobileStep === 1 ? 'Elige una portada y la calidad de la imagen.' : 'Añade uno o varios elementos. Se procesan aquí.';
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
    button.textContent = recovered ? state.receivedBundle ? 'Descargar todo en ZIP ↓' : 'Guardar archivo original ↓' : 'Abrir y verificar →';
    button.disabled = !recovered && $('decodeButton').disabled;
    hint.textContent = recovered ? `${state.receivedCount} elemento${state.receivedCount === 1 ? '' : 's'} recuperado${state.receivedCount === 1 ? '' : 's'} y verificado${state.receivedCount === 1 ? '' : 's'}.` : state.inspectingArt ? 'Leyendo tu imagen…' : !state.receivedArt ? 'Selecciona la imagen PNG que recibiste.' : !state.embeddedToken && !state.receivedToken ? 'Este envío anterior necesita su token separado.' : state.tokenMode === 'secret' ? 'Pega la clave que recibiste por separado.' : 'Tu identidad abrirá el envío en este navegador.';
  } else if (state.recording) { button.textContent = 'Terminar grabación ■'; hint.textContent = 'Tu nota de voz se está grabando.'; }
  else if (state.mobileStep === 0) {
    button.textContent = $('encodingMode').value === 'private' ? 'Crear imagen privada →' : 'Crear envío sin cifrado →'; button.disabled = $('encodeButton').disabled;
    hint.textContent = state.file ? `${state.items.length} elemento${state.items.length === 1 ? '' : 's'} · ${formatBytes(totalAttachmentBytes())}` : 'Añade archivos, texto, voz o ubicación.';
  } else if (state.mobileStep === 1) {
    button.textContent = $('encodingMode').value === 'private' ? 'Crear envío privado →' : 'Crear envío sin cifrado →'; button.disabled = $('encodeButton').disabled;
    hint.textContent = button.disabled ? 'Confirma la identidad destinataria para continuar.' : $('encodingMode').value === 'private' ? 'Cifrado y verificado antes de compartir.' : 'El modo clásico no cifra el contenido.';
  } else { button.textContent = 'Editar mi envío'; hint.textContent = $('encodingMode').value === 'private' ? 'Comparte la imagen. Guarda tu clave por separado.' : 'Comparte la obra y su token. Este modo no cifra.'; }
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
  $('encodeButton').disabled = state.busy || state.contactBusy || (!state.file && !$('textInput').value.trim()) || Boolean(state.recording) || state.preparingMicrophone || needsRecipient && (state.recipientLoading || !state.recipient || !$('recipientVerified').checked);
  $('decodeButton').disabled = state.busy || state.inspectingArt || !state.receivedArt || (!state.embeddedToken && !state.receivedToken);
  for (const id of ['sourceFile', 'photoFile', 'receivedArt', 'receivedToken', 'recordButton', 'demoButton', 'textButton', 'useText', 'encodingMode', 'coverFile', 'coverFormat', 'coverResolution', 'coverStyle', 'recipientFile', 'recipientVerified', 'createIdentity', 'clearIdentity', 'locationButton', 'useCurrentLocation', 'addLocation', 'locationLabel', 'locationLatitude', 'locationLongitude', 'clearAttachments', 'editCoverButton', 'savedContact', 'saveContact', 'removeContact', 'contactName']) $(id).disabled = state.busy || Boolean(state.recording) || state.preparingMicrophone;
  $('saveContact').disabled ||= state.contactBusy || !state.recipient || !$('recipientVerified').checked;
  $('removeContact').disabled ||= state.contactBusy || !$('savedContact').value;
  for (const id of ['savedContact', 'recipientFile', 'contactName', 'recipientVerified']) $(id).disabled ||= state.contactBusy;
  $('recipientVerified').disabled ||= state.recipientLoading;
  $('textInput').disabled = state.busy || Boolean(state.recording) || state.preparingMicrophone;
  $('useCurrentLocation').disabled ||= state.locating;
  document.querySelectorAll('.remove-attachment,.attachment-cover').forEach(node => { node.disabled = state.busy || Boolean(state.recording) || state.preparingMicrophone; });
  document.querySelectorAll('.cover-choice,input[name=accessMode]').forEach(node => { node.disabled = state.busy; });
  $('useSourceCover').disabled = state.busy || !state.items.some(item => item.file.type.startsWith('image/'));
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
  state.locationRequest++; state.locating = false;
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
function totalAttachmentBytes() { return state.items.reduce((sum, item) => sum + item.file.size, 0); }
function draftMessage() {
  const text = $('textInput').value;
  if (!text.trim()) return null;
  const count = state.items.filter(item => item.kind === 'text').length;
  return { file: new File([text], count ? `mensaje-nebo-${count + 1}.txt` : 'mensaje-nebo.txt', { type: 'text/plain' }), kind: 'text' };
}
function addDraftMessage() {
  const item = draftMessage(); if (!item) return true;
  if (!selectFile(item.file, item.kind)) return false;
  $('textInput').value = ''; describeCover(); updateButtons(); return true;
}
function needsBundle(items = state.items) { return items.length > 1 || items.some(item => item.kind === 'location' || item.file.size === 0); }
function itemKindLabel(item) {
  return item.kind === 'location' ? 'UBICACIÓN' : item.kind === 'text' ? 'MENSAJE' : item.kind === 'voice' || item.file.type.startsWith('audio/') ? 'AUDIO' : item.file.type.startsWith('image/') ? 'FOTO' : item.file.type.startsWith('video/') ? 'VIDEO' : item.file.type === 'application/pdf' ? 'PDF' : 'ARCHIVO';
}
function invalidateSenderResult() {
  $('senderResult').classList.add('hidden'); $('senderEmpty').classList.remove('hidden'); $('senderPanel').classList.remove('has-result');
  state.shareFiles = null; sharePackageButton.classList.add('hidden'); $('recoverySecret').value = '';
  if (state.secretURL) { URL.revokeObjectURL(state.secretURL); state.secretURL = null; }
}
function renderAttachments() {
  state.file = state.items[0]?.file || null;
  const selection = $('selectedFile'); selection.replaceChildren(); selection.classList.toggle('hidden', !state.items.length);
  $('attachmentSummary').classList.remove('hidden');
  $('attachmentSummary').textContent = state.items.length ? `${state.items.length} de ${MAX_BUNDLE_ITEMS} elementos · ${formatBytes(totalAttachmentBytes())} en total` : 'Todavía no has añadido elementos.';
  $('clearAttachments').classList.toggle('hidden', !state.items.length);
  for (const item of state.items) {
    const row = el('article', 'attachment-row'); row.dataset.itemId = String(item.id);
    const visual = el('div', 'attachment-preview');
    if (item.file.type.startsWith('image/')) { const img = el('img'); img.src = item.url; img.alt = ''; img.loading = 'lazy'; visual.append(img); }
    else visual.append(el('span', 'attachment-kind', itemKindLabel(item)));
    const info = el('div', 'attachment-info'); info.append(el('strong', '', item.file.name), el('small', '', `${itemKindLabel(item)} · ${formatBytes(item.file.size)}`));
    if (item.file.type.startsWith('audio/')) { const audio = el('audio'); audio.controls = true; audio.preload = 'none'; audio.src = item.url; info.append(audio); }
    if (item.file.type.startsWith('image/')) {
      const cover = el('button', 'attachment-cover text-link', 'Usar como portada visible'); cover.type = 'button';
      cover.addEventListener('click', () => { chooseCover('source', item.file); toast('Esta imagen será visible en la portada del envío.'); }); info.append(cover);
    }
    const remove = el('button', 'remove-attachment', '×'); remove.type = 'button'; remove.setAttribute('aria-label', `Quitar ${item.file.name}`); remove.addEventListener('click', () => removeAttachment(item.id));
    row.append(visual, info, remove); selection.append(row);
  }
  describeCover(); updateButtons();
}
function removeAttachment(id) {
  if (state.busy || state.recording || state.preparingMicrophone) return;
  const item = state.items.find(item => item.id === id); if (!item) return;
  URL.revokeObjectURL(item.url); state.items = state.items.filter(item => item.id !== id);
  if (state.cover === 'source' && state.coverFile === item.file) chooseCover('mountain');
  errorFor('sender'); invalidateSenderResult(); renderAttachments();
}
function clearFile() {
  if (state.busy || state.recording || state.preparingMicrophone) return;
  for (const item of state.items) URL.revokeObjectURL(item.url);
  state.items = []; $('sourceFile').value = '';
  if (state.cover === 'source') chooseCover('mountain');
  errorFor('sender'); invalidateSenderResult(); renderAttachments();
}
function addFiles(files, kind = 'file') {
  if (state.busy || state.recording || state.preparingMicrophone) return false;
  const additions = Array.from(files || []).map(file => ({ file, kind })); if (!additions.length) return false;
  const items = [...state.items, ...additions];
  if (items.length > MAX_BUNDLE_ITEMS) { errorFor('sender', `Puedes añadir hasta ${MAX_BUNDLE_ITEMS} elementos por envío. No se ha añadido este lote.`); return false; }
  try {
    const size = needsBundle(items) ? estimateBundleSize(items) : items[0].file.size;
    if (size > MAX_FILE_BYTES) throw new Error('El envío completo supera los 20 MB, incluido el espacio para organizar los adjuntos. Quita elementos o usa archivos más pequeños.');
  } catch (error) { errorFor('sender', error.message); return false; }
  for (const item of additions) state.items.push({ ...item, id: state.nextItemId++, url: URL.createObjectURL(item.file) });
  $('sourceFile').value = ''; errorFor('sender'); invalidateSenderResult(); renderAttachments(); return true;
}
function selectFile(file, kind = 'file') { return file ? addFiles([file], kind) : false; }
function readLocationInputs() {
  const latitude = $('locationLatitude').value.trim(), longitude = $('locationLongitude').value.trim();
  const lat = Number(latitude), lon = Number(longitude);
  if (!latitude || !longitude || !Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) throw new Error('Introduce una latitud entre -90 y 90 y una longitud entre -180 y 180.');
  return { lat, lon };
}
function addLocation() {
  if (state.busy || state.recording || state.preparingMicrophone) return;
  try {
    const { lat, lon } = readLocationInputs();
    const properties = { label: $('locationLabel').value.trim().slice(0, 120) || 'Ubicación compartida' };
    if (state.locationFix && state.locationFix.lat === lat && state.locationFix.lon === lon) {
      properties.accuracy_meters = state.locationFix.accuracy; properties.captured_at = state.locationFix.timestamp;
    }
    const geo = { type: 'Feature', geometry: { type: 'Point', coordinates: [lon, lat] }, properties };
    const count = state.items.filter(item => item.kind === 'location').length + 1;
    if (selectFile(new File([JSON.stringify(geo, null, 2) + '\n'], `ubicacion-${count}.geojson`, { type: 'application/geo+json' }), 'location')) {
      state.locationRequest++; state.locating = false; state.locationFix = null;
      $('locationEditor').classList.add('hidden'); $('locationButton').setAttribute('aria-expanded', 'false'); $('locationLabel').value = ''; $('locationLatitude').value = ''; $('locationLongitude').value = ''; $('locationStatus').textContent = ''; updateButtons(); toast('Ubicación añadida al envío.');
    }
  } catch (error) { $('locationStatus').textContent = error.message; }
}
function useCurrentLocation() {
  if (state.busy || state.recording || state.preparingMicrophone || state.locating) return;
  if (!navigator.geolocation) { $('locationStatus').textContent = 'Este navegador no ofrece ubicación. Puedes escribir las coordenadas.'; return; }
  const request = ++state.locationRequest; state.locating = true; $('locationStatus').textContent = 'Buscando tu ubicación. Puedes introducir las coordenadas manualmente.'; updateButtons();
  navigator.geolocation.getCurrentPosition(position => {
    if (request !== state.locationRequest) return;
    state.locating = false;
    const { latitude: lat, longitude: lon, accuracy } = position.coords;
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) { $('locationStatus').textContent = 'No se recibió una ubicación válida. Introduce las coordenadas.'; updateButtons(); return; }
    $('locationLatitude').value = String(lat); $('locationLongitude').value = String(lon);
    state.locationFix = { lat, lon, accuracy: Number.isFinite(accuracy) ? accuracy : null, timestamp: new Date(position.timestamp).toISOString() };
    $('locationStatus').textContent = `Ubicación encontrada${Number.isFinite(accuracy) ? ` · precisión aproximada de ${Math.round(accuracy)} m` : ''}. Pulsa Añadir ubicación para incluirla.`; updateButtons();
  }, error => {
    if (request !== state.locationRequest) return;
    state.locating = false;
    $('locationStatus').textContent = error.code === 1 ? 'No se concedió permiso de ubicación. Puedes escribir las coordenadas.' : 'No se pudo obtener la ubicación. Inténtalo de nuevo o escribe las coordenadas.'; updateButtons();
  }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 });
}
function scaledDimensions(width, height, maxPixels = 900000) { const scale = Math.min(1, Math.sqrt(maxPixels / (width * height))); return [Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale))]; }
function rgbaFromCanvas(canvas) { return { width: canvas.width, height: canvas.height, channels: 4, data: canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, canvas.width, canvas.height).data.buffer }; }
function coverDimensions() {
  const plan = currentCoverPlan(); return [plan.width, plan.height];
}
function currentCoverPlan() {
  let ciphertextBytes = 0;
  const draft = draftMessage(); const items = draft ? [...state.items, draft] : state.items;
  if (items.length) {
    const bundled = needsBundle(items);
    const file = bundled ? { size: estimateBundleSize(items) } : items[0].file;
    ciphertextBytes = estimateCiphertextBytes({ file, name: bundled ? 'NEBO-envio.zip' : file.name, mime: bundled ? BUNDLE_MIME : file.type || 'application/octet-stream' });
  }
  return planCover({ ciphertextBytes, format: $('coverFormat').value, resolution: $('coverResolution').value });
}
function coverFilter() {
  return $('coverStyle').value === 'vivid' ? 'saturate(1.22) contrast(1.06)' : $('coverStyle').value === 'cinematic' ? 'saturate(0.88) contrast(1.14) sepia(0.08)' : 'none';
}
function describeCover() {
  const image = $('coverReference'), live = $('liveCoverImage');
  if (live.src !== image.src) live.src = image.src;
  live.style.filter = coverFilter(); image.dataset.style = $('coverStyle').value;
  const empty = $('emptyCoverImage');
  if (empty.src !== image.src) empty.src = image.src;
  empty.style.filter = coverFilter();
  $('liveCoverTitle').textContent = { mountain: 'Montañas al atardecer', coast: 'Costa tropical', aurora: 'Aurora boreal', nebula: 'Cosmos', custom: 'Tu portada', source: 'Foto elegida como portada' }[state.cover];
  try {
    const { width, height, maxPngBytes, automatic } = currentCoverPlan();
    live.style.aspectRatio = `${width} / ${height}`;
    empty.style.aspectRatio = `${width} / ${height}`;
    live.style.objectFit = 'cover';
    $('coverDimensions').textContent = `${formatNumber(width)} × ${formatNumber(height)} px`;
    $('liveCoverSize').textContent = `${automatic ? 'Tamaño automático' : 'Tamaño elegido'} · ${formatNumber(width)} × ${formatNumber(height)} px`;
    $('estimatedSize').textContent = state.items.length ? `${state.items.length} elemento${state.items.length === 1 ? '' : 's'} · PNG hasta ${formatBytes(maxPngBytes)}; se optimiza al crear.` : 'Vista previa de la portada. Añade tu contenido para crear el envío.';
    if (image.naturalWidth) {
      const enlarged = Math.max(width / image.naturalWidth, height / image.naturalHeight) > 1.001;
      $('coverScaleNote').textContent = enlarged ? 'La portada se ampliará. Los adjuntos conservan su calidad original.' : 'La portada se ajusta al formato. Los adjuntos se conservan completos.';
    }
  } catch (error) { $('estimatedSize').textContent = error.message; $('coverScaleNote').textContent = error.message; }
}
function chooseCover(kind, file = null) {
  if (state.busy) return;
  if (state.coverURL) { URL.revokeObjectURL(state.coverURL); state.coverURL = null; }
  state.cover = kind; state.coverFile = file; state.coverVersion++;
  document.querySelectorAll('.cover-choice').forEach(button => { const selected = button.dataset.cover === kind; button.classList.toggle('selected', selected); button.setAttribute('aria-pressed', String(selected)); });
  const custom = kind === 'custom' || kind === 'source'; const info = $('customCoverInfo'); info.replaceChildren(); info.classList.toggle('hidden', !custom);
  if (custom) {
    const selectedFile = kind === 'source' ? file || state.items.find(item => item.file.type.startsWith('image/'))?.file : file;
    if (!selectedFile) return;
    state.coverFile = selectedFile;
    state.coverURL = URL.createObjectURL(selectedFile); $('coverReference').src = state.coverURL;
    info.append(el('strong', '', kind === 'source' ? 'La imagen del mensaje será la portada visible.' : 'Portada personalizada visible.'), el('span', '', selectedFile.name));
  } else $('coverReference').src = new URL(`./assets/${kind}.png`, location.href).href;
  invalidateSenderResult(); describeCover();
}
async function prepareCover() {
  let blob;
  if (state.cover === 'custom') blob = state.coverFile;
  else if (state.cover === 'source') blob = state.coverFile;
  else { const response = await fetch(new URL(`./assets/${state.cover}.png`, location.href)); if (!response.ok) throw new Error('No se pudo cargar esta portada. Elige otra imagen o sube una propia.'); blob = await response.blob(); }
  if (!blob) throw new Error('Selecciona una imagen de portada.');
  const bitmap = await createImageBitmap(blob);
  try {
    const [width, height] = coverDimensions(); const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
    const context = canvas.getContext('2d', { willReadFrequently: true }); context.fillStyle = '#ffffff'; context.fillRect(0, 0, width, height);
    context.filter = coverFilter();
    const scale = Math.max(width / bitmap.width, height / bitmap.height), drawnWidth = bitmap.width * scale, drawnHeight = bitmap.height * scale;
    context.drawImage(bitmap, (width - drawnWidth) / 2, (height - drawnHeight) / 2, drawnWidth, drawnHeight); context.filter = 'none';
    return rgbaFromCanvas(canvas);
  } finally { bitmap.close(); }
}
function updateEncodingMode() {
  const privateMode = $('encodingMode').value === 'private';
  $('coverControls').classList.toggle('hidden', !privateMode); $('protectionControls').classList.toggle('hidden', !privateMode);
  $('advancedAccess').classList.toggle('hidden', !privateMode); $('encodingSummary').textContent = privateMode ? 'Privado' : 'Sin cifrado';
  $('liveCoverPanel').classList.toggle('hidden', !privateMode);
  $('modeExplanation').textContent = privateMode ? 'La imagen lleva el contenido cifrado y su token integrado. Se abre con tu clave secreta o con la identidad del destinatario.' : 'Reorganiza los píxeles de una representación del archivo y conserva su paleta. La obra y el token permiten recuperarlo sin una clave secreta. Este modo no cifra el contenido.';
  $('encodeButton').replaceChildren(document.createTextNode(privateMode ? 'Crear imagen privada' : 'Crear permutación clásica'), el('span', '', '→'));
  $('senderOutputSubtitle').textContent = privateMode ? 'Una imagen para compartir. Tu clave, por separado.' : 'Obra y token. Permutación clásica sin cifrado.';
  invalidateSenderResult(); describeCover(); updateButtons();
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
  $('receiverFormatLabel').textContent = privateMode ? 'Imagen privada · contenido cifrado' : state.tokenFormat === 'ASTRA-MSG-V1' ? 'Envío clásico · sin cifrado' : 'Formato pendiente de validación';
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
  if (state.busy || !window.NEBO_ACCESS || !await window.NEBO_ACCESS.require()) return;
  if (state.busy || state.contactBusy || state.recording || state.preparingMicrophone || !addDraftMessage() || !state.file) return;
  const privateMode = $('encodingMode').value === 'private'; const accessMode = document.querySelector('input[name=accessMode]:checked').value;
  if (privateMode && accessMode === 'recipient' && (state.recipientLoading || !state.recipient || !$('recipientVerified').checked)) { errorFor('sender', 'Carga la identidad pública y confirma su huella por otro canal.'); return; }
  const recipient = state.recipient;
  const items = state.items.map(({ file, kind }) => ({ file, kind })); const bundled = needsBundle(items); const serial = beginTask('sender');
  try {
    const file = bundled ? await createBundle(items) : items[0].file;
    const bytes = await file.arrayBuffer(); if (state.taskSerial !== serial) return; let result;
    if (privateMode) {
      progress('sender', 3, 'Preparando la portada de alta resolución…');
      const cover = await prepareCover(); if (state.taskSerial !== serial) return;
      result = await runWorker('encode', { file: bytes, name: file.name, mime: file.type || 'application/octet-stream', cover, embed_token: true, ...(accessMode === 'recipient' ? { recipient } : {}) }, 'sender', 'secure');
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
    state.shareFiles = [new File([art], `${base}-NEBO-obra.png`, { type: 'image/png' })];
    if (!privateMode) state.shareFiles.push(new File([token], `${base}-NEBO-token.txt`, { type: 'text/plain' }));
    sharePackageButton.textContent = privateMode ? 'Compartir imagen ↗' : 'Compartir PNG y token ↗';
    let canShare = false; try { canShare = Boolean(navigator.share && navigator.canShare?.({ files: state.shareFiles })); } catch (_) {}
    sharePackageButton.classList.toggle('hidden', !canShare);
    $('artworkCaption').textContent = privateMode ? 'Imagen final verificada. Incluye el contenido cifrado y el token. Comparte la clave por separado.' : 'Permutación clásica de la representación del archivo. Conserva sus píxeles y su paleta; no cifra el contenido.';
    $('senderStats').replaceChildren(el('span', '', `${result.width} × ${result.height} px`), el('span', '', `PNG: ${formatBytes(art.size)}`), el('span', '', privateMode ? 'Token integrado' : `Token: ${formatBytes(token.size)}`));
    $('senderStats').append(el('span', '', `${items.length} elemento${items.length === 1 ? '' : 's'} · ${formatBytes(file.size)}`));
    const backup = document.querySelector('.token-backup'); backup.open = !privateMode;
    backup.querySelector('summary').textContent = privateMode ? 'Copia opcional del token' : 'Token necesario para este envío clásico';
    backup.querySelector('p').textContent = privateMode ? 'El PNG ya lo incluye. Puedes guardar otra copia por separado.' : 'Este modo anterior requiere compartir tanto el PNG como este token.';
    document.querySelector('.pair-note').textContent = privateMode ? 'Comparte el PNG como archivo, sin comprimir ni editar. El token ya va dentro; la clave se comparte por separado.' : 'Comparte el PNG y el token. Este modo no cifra el contenido.';
    $('secretResult').classList.add('hidden'); $('recipientResult').classList.add('hidden'); $('recoverySecret').value = '';
    if (state.secretURL) { URL.revokeObjectURL(state.secretURL); state.secretURL = null; }
    if (privateMode && result.recovery_secret) {
      $('recoverySecret').value = result.recovery_secret; $('recoverySecret').type = 'password'; $('showSecret').textContent = 'Mostrar'; $('showSecret').setAttribute('aria-pressed', 'false');
      state.secretURL = objectURL(new Blob([result.recovery_secret + '\n'], { type: 'text/plain' })); $('downloadSecret').href = state.secretURL; $('downloadSecret').download = 'NEBO-SECURITY-clave-secreta.key.txt'; $('secretResult').classList.remove('hidden');
    } else if (privateMode) {
      $('recipientResult').replaceChildren(el('strong', '', 'Protegido para la identidad destinataria'), el('code', 'fingerprint', await fingerprintPublicBundle(recipient))); $('recipientResult').classList.remove('hidden');
    }
    $('conservationExplanation').textContent = privateMode ? 'El contenido completo, sus nombres y sus metadatos se cifran con AES-256-GCM. Los datos cifrados viajan en los píxeles y el token integrado permite extraerlos y verificarlos. La compresión PNG es sin pérdida. La clave secreta o la identidad privada destinataria permanecen fuera del PNG.' : 'La representación reversible incluye el archivo original completo y, cuando está disponible, una vista previa. Una permutación conserva todos los píxeles de esa representación. La obra y el token bastan para recuperar el original; no hay cifrado.';
    $('senderHash').textContent = `SHA-256 ${bundled ? 'del paquete completo' : 'del archivo original'}: ${result.source_sha256}`;
    $('senderResult').classList.remove('hidden'); endTask('sender');
    mobileScroll();
  } catch (error) { if (state.taskSerial === serial) { errorFor('sender', error.code === 'CAPACITY' ? `El envío completo no cabe en la portada elegida${error.capacity ? ` (capacidad: ${formatBytes(error.capacity)})` : ''}. Selecciona una resolución mayor; para los envíos más grandes usa Cuadrado · 4096 px.` : error.message || String(error)); endTask('sender', true); } }
}
async function setReceived(kind, file) {
  if (!file || state.busy) return;
  const artwork = kind === 'art'; if (file.size > (artwork ? 180 : 80) * 1048576) { errorFor('receiver', 'Este archivo supera el tamaño admitido para la reconstrucción en el navegador.'); return; }
  const previousArt = state.receivedArt;
  state[artwork ? 'receivedArt' : 'receivedToken'] = file;
  $('receiverPanel').classList.remove('has-result'); $('receiverResult').classList.add('hidden');
  $(artwork ? 'receivedArtName' : 'receivedTokenName').textContent = `${file.name} · ${formatBytes(file.size)}`;
  $(artwork ? 'artDrop' : 'tokenDrop').classList.add('selected'); $(artwork ? 'artDrop' : 'tokenDrop').querySelector('.file-plus').textContent = '✓'; errorFor('receiver');
  if (artwork) {
    const serial = ++state.receiveSerial;
    state.inspectingArt = true; state.embeddedToken = null; state.tokenFormat = state.tokenMode = null;
    if (previousArt) {
      state.receivedToken = null; $('receivedToken').value = '';
      $('receivedTokenName').textContent = 'Token en JSON o TXT'; $('tokenDrop').classList.remove('selected'); $('tokenDrop').querySelector('.file-plus').textContent = '+';
    }
    if (state.receivedPreviewURL) URL.revokeObjectURL(state.receivedPreviewURL);
    state.receivedPreviewURL = null; $('receivedPreview').removeAttribute('src'); $('receivedPreview').classList.add('hidden');
    $('embeddedTokenStatus').textContent = 'Leyendo la imagen y buscando el token…'; updateReceiverAccess(); updateButtons();
    try {
      const parsed = unpackPortablePNG(new Uint8Array(await file.arrayBuffer()));
      if (serial !== state.receiveSerial) return;
      if (parsed.token) state.embeddedToken = new Blob([parsed.token], { type: 'application/json' });
      state.receivedPreviewURL = URL.createObjectURL(file); $('receivedPreview').src = state.receivedPreviewURL; $('receivedPreview').classList.remove('hidden');
      $('embeddedTokenStatus').textContent = parsed.token ? 'Token integrado detectado. El contenido se verificará al abrir con tu clave o identidad.' : 'Este PNG usa un token separado. Selecciónalo para abrir el envío.';
      $('legacyTokenOptions').open = !parsed.token;
    } catch (error) {
      if (serial !== state.receiveSerial) return;
      state.receivedArt = null; $('embeddedTokenStatus').textContent = 'No se pudo leer este PNG de NEBO.';
      errorFor('receiver', error.message || 'Selecciona el PNG original del envío, sin editar ni comprimir.');
    } finally { if (serial === state.receiveSerial) { state.inspectingArt = false; updateButtons(); } }
  }
  const activeToken = state.embeddedToken || state.receivedToken;
  if (activeToken) {
    try {
      const token = JSON.parse(await activeToken.text());
      if (activeToken !== (state.embeddedToken || state.receivedToken)) return;
      state.tokenFormat = token.format; state.tokenMode = token.mode;
    } catch (_) {
      if (activeToken !== (state.embeddedToken || state.receivedToken)) return;
      state.tokenFormat = null; state.tokenMode = null; errorFor('receiver', 'No se pudo leer el token como JSON. Selecciona el token original de este envío.');
    }
  }
  updateReceiverAccess(); updateButtons();
}
async function decode() {
  if (state.busy || !window.NEBO_ACCESS || !await window.NEBO_ACCESS.require()) return;
  if (state.busy || state.inspectingArt || !state.receivedArt || (!state.embeddedToken && !state.receivedToken)) return;
  const serial = beginTask('receiver');
  try {
    // Explicit external tokens are checked against the embedded token by the codec.
    const selectedToken = state.receivedToken || state.embeddedToken;
    const [artwork, token] = await Promise.all([state.receivedArt.arrayBuffer(), selectedToken.arrayBuffer()]);
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
    const items = isBundleMime(result.mime) ? await readBundle(new Uint8Array(result.file)) : null;
    if (state.taskSerial !== serial) return;
    state.receivedCount = items?.length || 1; state.receivedBundle = Boolean(items);
    const file = new Blob([result.file], { type: items ? 'application/zip' : result.mime || 'application/octet-stream' }); const url = objectURL(file);
    const name = result.name || result.filename || 'archivo-recuperado'; $('downloadRestored').href = url; $('downloadRestored').download = name;
    $('downloadRestored').textContent = items ? 'Descargar todo en ZIP ↓' : 'Descargar archivo original ↓';
    $('restoredFileInfo').replaceChildren(); const info = el('div'); info.append(el('strong', '', items ? `${items.length} elemento${items.length === 1 ? '' : 's'} recuperado${items.length === 1 ? '' : 's'}` : name), el('small', '', `${formatBytes(file.size)} · ${items ? 'Contenido completo verificado' : 'Archivo original completo'}`)); $('restoredFileInfo').append(el('span', '', '✓'), info);
    $('receiverHash').textContent = `SHA-256 verificado ${items ? 'del paquete; también se comprobó cada adjunto' : 'del archivo original y reconstruido'}: ${result.sha256 || result.source_sha256 || result.recovered_sha256}`;
    if (items) await showRestoredItems(items); else await showRestored(file, url, name);
    if (state.taskSerial !== serial) return;
    $('receiverResult').classList.remove('hidden'); endTask('receiver');
    mobileScroll();
  } catch (error) { if (state.taskSerial === serial) { errorFor('receiver', error.message || String(error)); endTask('receiver', true); } }
}
async function showRestoredItems(items) {
  const preview = $('restoredPreview'); preview.replaceChildren(); const list = el('div', 'restored-items'); preview.append(list);
  const order = item => item.kind === 'text' || item.mime.startsWith('text/') ? 0 : item.mime.startsWith('image/') ? 1 : item.mime.startsWith('audio/') ? 2 : item.mime.startsWith('video/') ? 3 : 4;
  for (const item of [...items].sort((a, b) => order(a) - order(b))) {
    const blob = new Blob([item.bytes], { type: item.mime }); const url = objectURL(blob);
    const card = el('article', 'restored-item'); const heading = el('div', 'restored-item-heading');
    heading.append(el('strong', '', item.name), el('small', '', `${formatBytes(blob.size)} · Verificado`));
    const content = el('div', 'restored-item-content');
    const download = el('a', 'button secondary attachment-download', 'Descargar este elemento ↓'); download.href = url; download.download = item.name;
    card.append(heading, content, download); list.append(card);
    await showRestored(blob, url, item.name, content, item.kind);
  }
}
async function showRestored(blob, url, name, preview = $('restoredPreview'), kind = 'file') {
  preview.replaceChildren(); const mime = blob.type;
  if (kind === 'location') {
    if (blob.size > 8192) throw new Error('La ubicación recibida supera el tamaño admitido.');
    const geo = JSON.parse(await blob.text()); const coordinates = geo?.geometry?.coordinates;
    if (geo?.type !== 'Feature' || geo.geometry?.type !== 'Point' || !Array.isArray(coordinates) || coordinates.length !== 2 || coordinates.some(value => typeof value !== 'number' || !Number.isFinite(value)) || Math.abs(coordinates[0]) > 180 || Math.abs(coordinates[1]) > 90) throw new Error('La ubicación recibida no contiene coordenadas válidas.');
    const [lon, lat] = coordinates;
    preview.append(el('strong', '', typeof geo.properties?.label === 'string' ? geo.properties.label.slice(0, 120) : 'Ubicación compartida'), el('p', '', `Latitud: ${lat} · Longitud: ${lon}`));
    if (Number.isFinite(geo.properties?.accuracy_meters) && geo.properties.accuracy_meters >= 0) preview.append(el('small', '', `Precisión aproximada: ${Math.round(geo.properties.accuracy_meters)} m`));
    const link = el('a', 'text-link location-map-link', 'Abrir ubicación en OpenStreetMap ↗'); link.href = `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=16/${lat}/${lon}`; link.target = '_blank'; link.rel = 'noopener noreferrer'; preview.append(link);
  }
  else if (mime.startsWith('image/')) { const image = el('img'); image.src = url; image.alt = 'Imagen original recuperada'; image.loading = 'eager'; preview.append(image); }
  else if (mime.startsWith('audio/') || mime.startsWith('video/')) { const media = el(mime.startsWith('audio/') ? 'audio' : 'video'); media.controls = true; media.preload = 'none'; media.src = url; preview.append(media); }
  else if (mime === 'application/pdf') {
    // Recovered documents are untrusted. Never execute them in a same-origin
    // iframe, including a file whose authenticated name merely ends in .pdf.
    const card = el('div', 'pdf-safe-card'); card.append(el('span', 'file-type', 'PDF'), el('strong', '', 'Documento original recuperado'), el('p', '', 'El archivo se ha verificado. Descárgalo para abrirlo en tu visor de documentos.')); preview.append(card);
  }
  else if (mime.startsWith('text/') || /\.txt$/i.test(name)) { const text = await blob.slice(0, 200000).text(); preview.append(el('pre', '', text)); }
  else preview.append(el('p', '', 'Archivo recuperado. Descárgalo para abrirlo con una aplicación compatible.'));
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
  const remaining = MAX_FILE_BYTES - totalAttachmentBytes() - 65536;
  if (state.items.length >= MAX_BUNDLE_ITEMS || remaining < 16384) { errorFor('sender', 'Quita algún elemento para dejar espacio para una nota de voz.'); return; }
  if (!navigator.mediaDevices?.getUserMedia) { errorFor('sender', 'Abre la página por HTTPS o desde localhost para usar el micrófono. También puedes seleccionar un archivo de audio.'); return; }
  state.preparingMicrophone = true; errorFor('sender'); updateButtons(); let stream, context;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    const AudioContext = window.AudioContext || window.webkitAudioContext; context = new AudioContext(); await context.resume();
    const source = context.createMediaStreamSource(stream); const processor = context.createScriptProcessor(4096, 1, 1);
    const record = { stream, context, source, processor, chunks: [], rate: context.sampleRate, bytes: 44, maxBytes: remaining, start: Date.now() };
    processor.onaudioprocess = event => { if (state.recording !== record) return; const count = Math.max(0, Math.floor((record.maxBytes - record.bytes) / 2)); const chunk = new Float32Array(event.inputBuffer.getChannelData(0).subarray(0, count)); record.chunks.push(chunk); record.bytes += chunk.length * 2; if (record.bytes >= record.maxBytes - 8192) { stopRecording(false); toast('La nota alcanzó el espacio disponible y se añadió al envío.'); } };
    state.recording = record; source.connect(processor); processor.connect(context.destination); $('recording').classList.remove('hidden'); $('recordTime').textContent = '00:00';
    record.timer = setInterval(() => { const seconds = Math.floor((Date.now() - record.start) / 1000); $('recordTime').textContent = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`; }, 250);
  } catch (error) {
    stream?.getTracks().forEach(track => track.stop()); if (context) await context.close().catch(() => {});
    errorFor('sender', error.name === 'NotAllowedError' ? 'No se concedió acceso al micrófono. Actívalo en los permisos del navegador o selecciona un audio.' : error.name === 'NotFoundError' ? 'No se encontró un micrófono. Puedes seleccionar un archivo de audio.' : `No se pudo iniciar la grabación: ${error.message}`);
  } finally { state.preparingMicrophone = false; updateButtons(); }
}
async function stopRecording(cancel) {
  const record = state.recording; if (!record) return; state.recording = null; state.preparingMicrophone = true; clearInterval(record.timer); record.processor.onaudioprocess = null; record.source.disconnect(); record.processor.disconnect(); record.stream.getTracks().forEach(track => track.stop());
  try { await record.context.close(); } finally { state.preparingMicrophone = false; $('recording').classList.add('hidden'); updateButtons(); }
  if (!cancel && record.chunks.some(chunk => chunk.length)) selectFile(wavFile(record), 'voice'); else if (!cancel) toast('La nota fue demasiado breve. Inténtalo de nuevo.');
}
function setupDrop(node, callback, multiple = false) {
  node.addEventListener('dragover', event => { event.preventDefault(); if (!state.busy) node.classList.add('dragover'); });
  node.addEventListener('dragleave', () => node.classList.remove('dragover'));
  node.addEventListener('drop', event => { event.preventDefault(); node.classList.remove('dragover'); if (!state.busy) callback(multiple ? event.dataTransfer.files : event.dataTransfer.files[0]); });
}

async function refreshContacts(selected = $('savedContact').value) {
  try {
    state.contacts = await listContacts();
    const placeholder = el('option', '', state.contacts.length ? 'Seleccionar contacto' : 'Aún no hay contactos guardados'); placeholder.value = '';
    $('savedContact').replaceChildren(placeholder);
    for (const contact of state.contacts) { const option = el('option', '', contact.name); option.value = contact.id; $('savedContact').append(option); }
    $('savedContact').value = state.contacts.some(contact => contact.id === selected) ? selected : '';
  } catch (error) { $('contactStatus').textContent = error.message; }
  updateButtons();
}
$('savedContact').addEventListener('change', () => {
  state.recipientSerial++; state.recipientLoading = false;
  const contact = state.contacts.find(item => item.id === $('savedContact').value);
  state.recipient = contact?.publicBundle || null; $('recipientVerified').checked = Boolean(contact);
  $('recipientSummary').classList.toggle('hidden', !contact); $('recipientFingerprint').textContent = contact?.id || '';
  $('contactName').value = contact?.name || ''; $('recipientFile').value = '';
  $('contactStatus').textContent = contact ? `Usando la identidad pública guardada de ${contact.name}.` : '';
  invalidateSenderResult(); errorFor('sender'); updateButtons();
});
$('saveContact').addEventListener('click', async () => {
  if (state.busy || state.contactBusy || !state.recipient || !$('recipientVerified').checked) return;
  state.contactBusy = true; updateButtons();
  try {
    const contact = await saveContact($('contactName').value, state.recipient);
    await refreshContacts(contact.id); $('contactStatus').textContent = `Contacto ${contact.name} guardado en este navegador.`;
  } catch (error) { $('contactStatus').textContent = error.message; }
  finally { state.contactBusy = false; updateButtons(); }
});
$('removeContact').addEventListener('click', async () => {
  const id = $('savedContact').value; if (!id || state.busy || state.contactBusy) return;
  state.contactBusy = true; updateButtons();
  try {
    await removeContact(id); state.recipient = null; $('recipientVerified').checked = false;
    $('recipientSummary').classList.add('hidden'); $('contactName').value = ''; invalidateSenderResult();
    await refreshContacts(''); $('contactStatus').textContent = 'Contacto eliminado. Las identidades privadas siguen en sus dispositivos.';
  } catch (error) { $('contactStatus').textContent = error.message; }
  finally { state.contactBusy = false; updateButtons(); }
});

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
  else if (state.mobileStep === 0 || state.mobileStep === 1) encode();
  else if (state.mobileStep === 2) setMobileStep(0);
});
$('editCoverButton').addEventListener('click', () => { if (mobileScreen.matches) setMobileStep(1); else $('coverControls').scrollIntoView({ behavior: 'smooth', block: 'start' }); });
$('photoFile').addEventListener('change', () => { const files = Array.from($('photoFile').files); $('photoFile').value = ''; addFiles(files); });
$('sourceFile').addEventListener('change', () => { const files = Array.from($('sourceFile').files); $('sourceFile').value = ''; addFiles(files); }); $('receivedArt').addEventListener('change', () => setReceived('art', $('receivedArt').files[0])); $('receivedToken').addEventListener('change', () => setReceived('token', $('receivedToken').files[0]));
setupDrop($('sourceDrop'), addFiles, true); setupDrop($('artDrop'), file => setReceived('art', file)); setupDrop($('tokenDrop'), file => setReceived('token', file));
$('clearAttachments').addEventListener('click', clearFile);
$('encodeButton').addEventListener('click', encode); $('decodeButton').addEventListener('click', decode); document.querySelectorAll('.cancel-task').forEach(button => button.addEventListener('click', cancelTask));
$('recordButton').addEventListener('click', startRecording); $('stopRecord').addEventListener('click', () => stopRecording(false)); $('cancelRecord').addEventListener('click', () => stopRecording(true));
$('textButton').addEventListener('click', () => $('textInput').focus());
$('textInput').addEventListener('input', () => { invalidateSenderResult(); describeCover(); updateButtons(); });
$('useText').addEventListener('click', () => { if (!draftMessage()) { errorFor('sender', 'Escribe tu mensaje antes de añadirlo.'); return; } if (addDraftMessage()) toast('Mensaje añadido al envío.'); });
$('locationButton').addEventListener('click', () => { const editor = $('locationEditor'); editor.classList.toggle('hidden'); $('locationButton').setAttribute('aria-expanded', String(!editor.classList.contains('hidden'))); if (!editor.classList.contains('hidden')) $('locationLabel').focus(); });
$('useCurrentLocation').addEventListener('click', useCurrentLocation); $('addLocation').addEventListener('click', addLocation);
for (const id of ['locationLatitude', 'locationLongitude']) $(id).addEventListener('input', () => { state.locationRequest++; state.locating = false; state.locationFix = null; $('locationStatus').textContent = ''; updateButtons(); });
$('demoButton').addEventListener('click', async () => { if (state.busy) return; $('demoButton').disabled = true; errorFor('sender'); try { const response = await fetch(new URL('./assets/documento-ejemplo.pdf', location.href)); if (!response.ok) throw new Error('No se pudo cargar el documento de ejemplo. Puedes seleccionar tu propio archivo.'); const file = new File([await response.blob()], 'documento-ejemplo.pdf', { type: 'application/pdf' }); if (selectFile(file)) { if (mobileScreen.matches) setMobileStep(1); else await encode(); } } catch (error) { errorFor('sender', error.message); } finally { updateButtons(); } });
document.querySelectorAll('.copy-receiver').forEach(button => button.addEventListener('click', copyReceiverLink));
document.querySelectorAll('.cover-choice').forEach(button => button.addEventListener('click', () => chooseCover(button.dataset.cover)));
$('encodingMode').addEventListener('change', updateEncodingMode);
$('coverReference').addEventListener('load', describeCover);
$('coverReference').addEventListener('error', () => { $('coverScaleNote').textContent = 'No se pudo cargar la referencia. Selecciona otra portada o sube una imagen.'; });
for (const id of ['coverFormat', 'coverResolution', 'coverStyle']) $(id).addEventListener('change', () => { invalidateSenderResult(); describeCover(); });
$('coverFile').addEventListener('change', () => { const file = $('coverFile').files[0]; if (!file) return; if (!file.type.startsWith('image/') || file.size > MAX_FILE_BYTES) { errorFor('sender', 'Selecciona una imagen de portada de hasta 20 MB.'); return; } chooseCover('custom', file); });
$('useSourceCover').addEventListener('click', () => { const image = state.items.find(item => item.file.type.startsWith('image/')); if (image) { chooseCover('source', image.file); toast('La primera foto adjunta será la portada visible. Puedes elegir otra desde la lista.'); } });
document.querySelectorAll('input[name=accessMode]').forEach(input => input.addEventListener('change', () => { const recipient = document.querySelector('input[name=accessMode]:checked').value === 'recipient'; $('recipientControls').classList.toggle('hidden', !recipient); $('accessSummary').textContent = recipient ? 'Identidad destinataria' : 'Clave secreta'; invalidateSenderResult(); updateButtons(); }));
$('recipientFile').addEventListener('change', async () => {
  const serial = ++state.recipientSerial; state.recipientLoading = false;
  $('savedContact').value = ''; $('contactName').value = ''; $('contactStatus').textContent = '';
  state.recipient = null; $('recipientVerified').checked = false; $('recipientSummary').classList.add('hidden'); updateButtons(); const file = $('recipientFile').files[0]; if (!file) return;
  state.recipientLoading = true; invalidateSenderResult(); updateButtons();
  try {
    const recipient = await loadRecipientBundle(file); const fingerprint = await fingerprintPublicBundle(recipient);
    if (serial !== state.recipientSerial) return;
    state.recipient = recipient; $('recipientFingerprint').textContent = fingerprint; $('recipientSummary').classList.remove('hidden'); errorFor('sender');
  } catch (error) { if (serial === state.recipientSerial) errorFor('sender', error.message); }
  finally { if (serial === state.recipientSerial) { state.recipientLoading = false; updateButtons(); } }
});
$('recipientVerified').addEventListener('change', () => { invalidateSenderResult(); updateButtons(); });
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
// A failed authorization check closes the in-memory session. Reload goes
// through the hosting gate; identities in IndexedDB are deliberately retained.
window.addEventListener('nebo:access-locked', () => {
  state.recording?.stream.getTracks().forEach(track => track.stop());
  for (const worker of Object.values(state.workers)) worker?.terminate();
  for (const url of state.urls) URL.revokeObjectURL(url);
  $('recoverySecret').value = ''; $('receivedSecret').value = '';
  location.reload();
}, { once: true });
function applyResponsiveLayout() {
  $('advancedOptions').open = !mobileScreen.matches;
  $('advancedAccess').open = !mobileScreen.matches || document.querySelector('input[name=accessMode]:checked').value === 'recipient';
  const names = mobileScreen.matches ? { auto: 'Automático', landscape: 'Horizontal', portrait: 'Vertical', square: 'Cuadrado' } : { auto: 'Automático · según el envío', landscape: 'Horizontal · 3:2', portrait: 'Vertical · 2:3', square: 'Cuadrado · 1:1' };
  Array.from($('coverFormat').options).forEach(option => { option.textContent = names[option.value]; });
  $('sourceDrop').querySelector('small').textContent = 'Hasta 20 MB en total · 32 elementos';
  syncMobile();
}
mobileScreen.addEventListener('change', applyResponsiveLayout);
document.querySelector('.help-link').addEventListener('click', () => { document.body.classList.add('mobile-help-open'); });
applyResponsiveLayout(); renderAttachments();
setMode(new URLSearchParams(location.search).get('modo') === 'recibir' ? 'receiver' : 'sender'); updateEncodingMode(); describeCover();
if (!window.Worker || !window.crypto?.subtle) { $('compatibility').textContent = 'Usa un navegador actualizado y abre esta página mediante HTTPS para procesar y verificar archivos localmente.'; $('compatibility').classList.remove('hidden'); }
startWorker('classic'); startWorker('secure'); refreshIdentity(); refreshContacts();
initInstallUI();
// Keep the visible page from accepting files before its module handlers exist.
document.querySelectorAll('[data-app-initializing]').forEach(node => { node.inert = false; node.removeAttribute('data-app-initializing'); });
