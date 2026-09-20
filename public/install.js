/* Installation is optional. Transfers and keys never enter the service-worker cache. */
let initialized;

export function initInstallUI() {
  if (initialized) return initialized;
  initialized = initialize();
  return initialized;
}

async function initialize() {
  const button = document.getElementById('installApp');
  const status = document.getElementById('installStatus');
  const offline = document.getElementById('offlineStatus');
  const say = text => { if (status) status.textContent = text; };
  const standalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
  let deferred, ready = false;
  const offlineStatus = () => {
    if (!offline) return;
    offline.textContent = ready
      ? navigator.onLine ? 'Aplicación guardada para abrir y recuperar envíos sin conexión.' : 'Sin conexión · la aplicación guardada puede recuperar tus envíos.'
      : navigator.onLine ? 'Preparando la aplicación para usarla sin conexión…' : 'Sin conexión. Conéctate una vez para guardar la aplicación.';
  };
  const installed = () => {
    if (button) { button.disabled = true; button.textContent = 'Aplicación instalada'; }
    say('NEBO está abierto como aplicación. Tus datos siguen guardados solo en este navegador.');
  };
  if (button) {
    button.classList.remove('hidden');
    button.addEventListener('click', async () => {
      if (standalone()) { installed(); return; }
      if (deferred) {
        const prompt = deferred; deferred = null;
        try {
          await prompt.prompt();
          const result = await prompt.userChoice;
          say(result.outcome === 'accepted' ? 'Instalación solicitada. El navegador completará el proceso.' : 'Puedes instalar NEBO más adelante.');
        } catch { say('No se pudo abrir la instalación. Usa el menú del navegador para añadir NEBO a tu dispositivo.'); }
      } else {
        say(ios ? 'En Safari, toca Compartir y después Añadir a pantalla de inicio.'
          : 'Abre el menú de tu navegador y busca Instalar aplicación o Añadir a pantalla de inicio. Si no aparece, puedes seguir usando esta página.');
      }
    });
  }
  window.addEventListener('beforeinstallprompt', event => {
    event.preventDefault(); deferred = event;
    if (button) { button.disabled = false; button.textContent = 'Instalar aplicación'; }
    say('Puedes añadir NEBO a tu dispositivo desde este botón.');
  });
  window.addEventListener('appinstalled', () => { deferred = null; installed(); });
  window.addEventListener('online', offlineStatus);
  window.addEventListener('offline', offlineStatus);
  if (standalone()) installed();
  offlineStatus();
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
  if (!('serviceWorker' in navigator) || !isSecureContext || location.protocol !== 'https:' && !local) {
    if (offline) offline.textContent = 'El guardado sin conexión requiere HTTPS y un navegador compatible.';
    return null;
  }
  try {
    const registration = await navigator.serviceWorker.register(new URL('./sw.js', import.meta.url), { scope: './', updateViaCache: 'none' });
    const waiting = () => {
      if (registration.waiting) say('Hay una actualización lista. Se aplicará al cerrar las pestañas de NEBO y volver a abrir la aplicación.');
    };
    waiting();
    const watchInstallation = worker => {
      if (!worker) return;
      const changed = () => {
        if (worker.state === 'installed') waiting();
        if (worker.state === 'redundant' && !registration.active && offline) {
          offline.textContent = 'No se pudo guardar la aplicación completa. Comprueba la conexión y recarga para reintentar.';
        }
      };
      worker.addEventListener('statechange', changed);
      changed();
    };
    watchInstallation(registration.installing);
    registration.addEventListener('updatefound', () => watchInstallation(registration.installing));
    navigator.serviceWorker.ready.then(() => { ready = true; offlineStatus(); }).catch(() => {});
    return registration;
  } catch {
    if (offline) offline.textContent = 'No se pudo guardar la aplicación sin conexión. Comprueba la conexión o los permisos de almacenamiento y recarga.';
    return null;
  }
}
