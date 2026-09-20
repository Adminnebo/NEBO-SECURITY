const form = document.getElementById('loginForm');
const submit = document.getElementById('loginSubmit');
const status = document.getElementById('loginStatus');
let busy = false;

// An explicit allowlist prevents external and protocol-relative redirects.
const requested = new URL(location.href).searchParams.get('next');
const next = ['/', '/?modo=recibir', '/account'].includes(requested) ? requested : '/';

document.querySelectorAll('[data-password]').forEach(button => {
  button.addEventListener('click', () => {
    const input = document.getElementById(button.dataset.password);
    const visible = input.type === 'password';
    input.type = visible ? 'text' : 'password';
    button.textContent = visible ? 'Ocultar' : 'Mostrar';
    button.setAttribute('aria-pressed', String(visible));
  });
});

form.addEventListener('submit', async event => {
  event.preventDefault();
  if (busy || !form.reportValidity()) return;
  busy = true;
  submit.disabled = true;
  form.setAttribute('aria-busy', 'true');
  status.dataset.kind = '';
  status.textContent = 'Comprobando tus datos…';
  try {
    const response = await fetch('/api/auth/login', {
      method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ username: form.elements.username.value.trim().toLowerCase(), password: form.elements.password.value }),
      signal: AbortSignal.timeout(20000),
    });
    const data = await response.json();
    if (!response.ok || data.ok !== true) throw new Error(typeof data.error === 'string' ? data.error : 'No pudimos iniciar sesión. Revisa tus datos.');
    form.elements.password.value = '';
    status.textContent = 'Acceso confirmado. Abriendo tu espacio…';
    location.replace(next);
  } catch (error) {
    status.dataset.kind = 'error';
    status.textContent = error instanceof TypeError || error.name === 'TimeoutError' || error.name === 'SyntaxError' ? 'No pudimos conectar. Comprueba tu conexión e inténtalo de nuevo.' : error.message;
  } finally {
    busy = false;
    submit.disabled = false;
    form.removeAttribute('aria-busy');
  }
});

// Cookies, not browser storage, decide whether an existing session is valid.
fetch('/api/auth/session', { credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(10000) })
  .then(async response => {
    if (!response.ok || busy) return;
    const session = await response.json();
    if (session.authenticated === true && session.format === 'NEBO-SESSION-V1' && !busy) location.replace(next);
  }).catch(() => {});

window.addEventListener('pagehide', () => { form.elements.password.value = ''; });
