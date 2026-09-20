/* Installation adds a home-screen icon; access still requires the server. */
let initialized;

export function initInstallUI() {
  if (initialized) return initialized;
  initialized = initialize();
  return initialized;
}

async function initialize() {
  const buttons = ['installApp', 'installShortcut'].map(id => document.getElementById(id)).filter(Boolean);
  const status = document.getElementById('installStatus');
  const offline = document.getElementById('offlineStatus');
  const say = text => { if (status) status.textContent = text; };
  const labelButtons = (text, disabled) => {
    for (const button of buttons) {
      button.disabled = disabled;
      if (button.id === 'installShortcut') {
        button.title = text;
        button.setAttribute('aria-label', text);
      } else button.textContent = text;
    }
  };
  const standalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
  let deferred;
  const connectionStatus = () => {
    if (offline) offline.textContent = navigator.onLine
      ? 'Necesitas internet para abrir NEBO y comprobar tu acceso.'
      : 'Sin conexión. Conéctate para abrir la aplicación privada.';
  };
  const installed = () => {
    labelButtons('Aplicación instalada', true);
    say('NEBO está abierto como aplicación. Necesitas internet para comprobar tu acceso al abrirla.');
  };
  const showInstructions = () => {
    say(ios ? 'En Safari, toca Compartir y después Añadir a pantalla de inicio. Abre NEBO desde su icono para usarlo sin la barra del navegador.'
      : 'Abre el menú de tu navegador y busca Instalar aplicación o Añadir a pantalla de inicio. Después abre NEBO desde su icono.');
    // The header shortcut must reveal instructions when no native prompt exists.
    const details = status?.closest('details');
    if (details) details.open = true;
    status?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };
  for (const button of buttons) {
    button.classList.remove('hidden');
    button.addEventListener('click', async () => {
      if (standalone()) { installed(); return; }
      if (!deferred) { showInstructions(); return; }
      const prompt = deferred; deferred = null;
      try {
        await prompt.prompt();
        const result = await prompt.userChoice;
        say(result.outcome === 'accepted' ? 'Instalación solicitada. El navegador completará el proceso.' : 'Puedes instalar NEBO más adelante.');
      } catch { showInstructions(); }
    });
  }
  window.addEventListener('beforeinstallprompt', event => {
    event.preventDefault(); deferred = event;
    labelButtons('Instalar aplicación', false);
    say('Añade NEBO a tu pantalla de inicio. El acceso seguirá protegido al abrirlo.');
  });
  window.addEventListener('appinstalled', () => { deferred = null; installed(); });
  window.addEventListener('online', connectionStatus);
  window.addEventListener('offline', connectionStatus);
  if (standalone()) installed();
  connectionStatus();
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
  if (!('serviceWorker' in navigator) || !isSecureContext || location.protocol !== 'https:' && !local) {
    say('Puedes usar la web con tu acceso autorizado. Instalarla requiere HTTPS y un navegador compatible.');
    return null;
  }
  try {
    return await navigator.serviceWorker.register(new URL('./sw.js?v=10', import.meta.url), { scope: './', updateViaCache: 'none' });
  } catch {
    say('No se pudo preparar la instalación. Comprueba la conexión y vuelve a cargar NEBO.');
    return null;
  }
}
