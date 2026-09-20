/* The hosting access policy is the authentication boundary. This bootstrap
 * rechecks that protected origin and never treats a local flag as a session. */
const $ = id => document.getElementById(id);
const ROOT = new URL('./', import.meta.url);
const PRIVATE_WORKER = new URL('./sw.js?v=10', import.meta.url).href;
const OWNED_CACHE = /^nebo-app-v\d+$/;
let loaded = false, inFlight = null, lastCheck = 0, workerPrepared = false;

function gate(state, title, description) {
  document.body.dataset.access = state;
  $('accessTitle').textContent = title;
  $('accessDescription').textContent = description;
  $('accessStatus').textContent = state === 'checking' ? 'Comprobando tu acceso con el servidor…' : '';
  $('accessRetry').disabled = state === 'checking';
  $('accessRetry').textContent = state === 'offline' ? 'Volver a comprobar' : 'Continuar al inicio de sesión';
  document.querySelector('main').inert = state !== 'granted';
  $('mobileDock').inert = state !== 'granted';
}

async function probe() {
  const url = new URL('access-check.json', ROOT);
  url.searchParams.set('check', crypto.randomUUID());
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store', redirect: 'error', headers: { Accept: 'application/json' }, signal: controller.signal });
    if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) return false;
    const data = await response.json();
    return data?.format === 'NEBO-HOST-ACCESS-V1' && data.version === 10;
  } finally { clearTimeout(timer); }
}

async function preparePrivateWorker() {
  if (workerPrepared) return;
  // An older public release may have stored the whole app. Preserve identities
  // in IndexedDB and any cache belonging to a different application.
  if ('caches' in window) for (const name of await caches.keys()) if (OWNED_CACHE.test(name)) await caches.delete(name);
  if (!('serviceWorker' in navigator)) { workerPrepared = true; return; }
  const registration = await navigator.serviceWorker.register(PRIVATE_WORKER, { scope: ROOT.href, updateViaCache: 'none' });
  await new Promise((resolve, reject) => {
    const deadline = setTimeout(() => finish(new Error('La actualización de acceso no terminó. Recarga con conexión.')), 15000);
    const watched = new Set();
    let finished = false;
    const ready = () => registration.active?.scriptURL === PRIVATE_WORKER && registration.active?.state === 'activated' && navigator.serviceWorker.controller?.scriptURL === PRIVATE_WORKER;
    function finish(error) {
      if (finished) return; finished = true;
      clearTimeout(deadline); registration.removeEventListener('updatefound', inspect); navigator.serviceWorker.removeEventListener('controllerchange', inspect);
      for (const worker of watched) worker.removeEventListener('statechange', inspect);
      if (error) reject(error); else resolve();
    }
    function inspect() {
      if (finished) return;
      if (ready()) { finish(); return; }
      for (const worker of [registration.installing, registration.waiting, registration.active]) {
        if (worker && !watched.has(worker)) { watched.add(worker); worker.addEventListener('statechange', inspect); }
      }
    }
    registration.addEventListener('updatefound', inspect); navigator.serviceWorker.addEventListener('controllerchange', inspect); inspect();
  });
  workerPrepared = true;
}

async function checkAccess() {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    if (!loaded) gate('checking', 'Verificando tu acceso', 'NEBO está disponible para las personas autorizadas.');
    let allowed = false;
    try { allowed = await probe(); } catch (_) {}
    if (!allowed) {
      const offline = !navigator.onLine;
      gate(offline ? 'offline' : 'denied', offline ? 'Conéctate para entrar' : 'Comprueba tu sesión', offline ? 'Esta versión verifica tu autorización por internet antes de abrir la aplicación.' : 'Abre el inicio de sesión del alojamiento con una cuenta autorizada. Si no tienes acceso, solicítalo al propietario.');
      if (loaded) window.dispatchEvent(new Event('nebo:access-locked'));
      return false;
    }
    try {
      await preparePrivateWorker();
      if (!loaded) { await import('./app.js?v=10'); loaded = true; }
      lastCheck = Date.now();
      gate('granted', 'Acceso autorizado', 'Tu contenido se procesa en este dispositivo.');
      return true;
    } catch (error) {
      gate('denied', 'No se pudo preparar la aplicación', error.message || 'Recarga la página con conexión para volver a intentarlo.');
      return false;
    }
  })();
  try { return await inFlight; } finally { inFlight = null; }
}

// Every encode/decode rechecks the protected origin. This object contains no
// credentials, tokens, user details, or server authorization decisions to cache.
window.NEBO_ACCESS = Object.freeze({ require: () => checkAccess() });
$('accessRetry').addEventListener('click', () => {
  if (!navigator.onLine || document.body.dataset.access === 'offline') checkAccess();
  else location.reload();
});
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && loaded && Date.now() - lastCheck > 15000) checkAccess();
});
window.addEventListener('focus', () => {
  if (loaded && Date.now() - lastCheck > 15000) checkAccess();
});
window.addEventListener('pageshow', event => { if (event.persisted) checkAccess(); });
window.addEventListener('online', () => { if (document.body.dataset.access !== 'granted') checkAccess(); });
setInterval(() => { if (loaded && !document.hidden) checkAccess(); }, 60000);
checkAccess();
