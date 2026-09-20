const $ = id => document.getElementById(id);
let session = null;
let resetUser = null;
let loadingUsers = false;
let checkingSession = false;

function tell(id, message, error = false) {
  $(id).textContent = message;
  $(id).dataset.kind = error ? 'error' : '';
}

function clearCredentials() {
  $('credentialUsername').value = '';
  $('credentialPassword').value = '';
  $('credentialPassword').type = 'password';
  $('credentialsResult').hidden = true;
  tell('copyStatus', '');
}

function clearSecrets() {
  clearCredentials();
  document.querySelectorAll('input[autocomplete="current-password"], input[autocomplete="new-password"]').forEach(input => { input.value = ''; });
  session = null;
  resetUser = null;
}

function loginAgain() {
  clearSecrets();
  $('accountContent').hidden = true;
  location.replace('/login?next=%2Faccount');
}

async function api(path, { method = 'GET', body } = {}) {
  const headers = { Accept: 'application/json' };
  if (method !== 'GET') {
    if (!session?.csrfToken) throw new Error('Tu sesión debe verificarse de nuevo. Recarga la página.');
    headers['X-CSRF-Token'] = session.csrfToken;
  }
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let response;
  let data;
  try {
    response = await fetch(path, {
      method, headers, credentials: 'same-origin', cache: 'no-store', redirect: 'error',
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20000),
    });
    data = response.status === 204 ? {} : await response.json();
  } catch (_) { throw new Error('No pudimos conectar. Comprueba tu conexión e inténtalo de nuevo.'); }
  if (response.status === 401) {
    loginAgain();
    throw new Error('Tu sesión terminó. Vuelve a entrar.');
  }
  if (!response.ok) throw new Error(typeof data.error === 'string' ? data.error : 'No pudimos completar esta acción.');
  return data;
}

async function runForm(form, statusId, action) {
  if (form.dataset.busy === 'true' || !form.reportValidity()) return;
  form.dataset.busy = 'true';
  form.setAttribute('aria-busy', 'true');
  const controls = [...form.elements].map(control => [control, control.disabled]);
  controls.forEach(([control]) => { control.disabled = true; });
  tell(statusId, 'Guardando…');
  try { await action(); }
  catch (error) { tell(statusId, error.message, true); }
  finally {
    controls.forEach(([control, disabled]) => { control.disabled = disabled; });
    delete form.dataset.busy;
    form.removeAttribute('aria-busy');
  }
}

function randomPassword() {
  // 64 symbols divide the byte range exactly: no modulo bias.
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  return [...crypto.getRandomValues(new Uint8Array(16))].map(byte => alphabet[byte & 63]).join('');
}

document.querySelectorAll('[data-password]').forEach(button => {
  button.addEventListener('click', () => {
    const input = $(button.dataset.password);
    const visible = input.type === 'password';
    input.type = visible ? 'text' : 'password';
    button.textContent = visible ? 'Ocultar' : 'Mostrar';
    button.setAttribute('aria-pressed', String(visible));
  });
});

function showCredentials(username, password) {
  $('credentialUsername').value = username;
  $('credentialPassword').value = password;
  $('credentialPassword').type = 'password';
  const toggle = document.querySelector('[data-password="credentialPassword"]');
  toggle.textContent = 'Mostrar';
  toggle.setAttribute('aria-pressed', 'false');
  $('credentialsResult').hidden = false;
  tell('copyStatus', '');
  $('credentialsResult').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

$('generatePassword').addEventListener('click', () => {
  $('newUserPassword').value = randomPassword();
  tell('createUserStatus', 'Contraseña generada. Puedes crear el usuario.');
});
$('generateResetPassword').addEventListener('click', () => {
  $('resetPassword').value = randomPassword();
  tell('resetStatus', 'Contraseña generada. Guarda para aplicarla.');
});
$('clearCredentials').addEventListener('click', clearCredentials);
$('copyCredentials').addEventListener('click', async () => {
  if (!$('credentialPassword').value) return;
  const text = `NEBO AI - SECURITY\nEntra: ${location.origin}/login\nUsuario: ${$('credentialUsername').value}\nContraseña: ${$('credentialPassword').value}\nPuedes cambiar tu contraseña en Mi cuenta.`;
  try {
    await navigator.clipboard.writeText(text);
    tell('copyStatus', 'Datos copiados. Compártelos en privado con esta persona.');
  } catch (_) { tell('copyStatus', 'El navegador no permitió copiar. Puedes seleccionar y copiar los datos de arriba.', true); }
});

$('createUserForm').addEventListener('submit', event => {
  event.preventDefault();
  const form = event.currentTarget;
  const username = form.elements.username.value.trim().toLowerCase();
  const password = form.elements.password.value;
  const displayName = form.elements.displayName.value.trim();
  runForm(form, 'createUserStatus', async () => {
    await api('/api/admin/users', { method: 'POST', body: { username, password, displayName } });
    form.reset();
    tell('createUserStatus', `Usuario ${username} creado.`);
    showCredentials(username, password);
    await loadUsers();
  });
});

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function renderUser(user) {
  const row = node('li', 'user-row');
  const description = node('div', 'user-description');
  description.append(node('strong', '', user.displayName || user.username), node('span', 'muted', `@${user.username}`));
  const badges = node('div', 'user-badges');
  badges.append(node('span', user.disabled ? 'pill disabled-pill' : 'pill', user.disabled ? 'Sin acceso' : 'Activo'));
  if (user.role === 'admin') badges.append(node('span', 'pill', 'Administrador'));
  if (user.id === session.user.id) badges.append(node('span', 'pill', 'Tú'));
  description.append(badges);
  row.append(description);
  const actions = node('div', 'user-actions');
  if (user.id !== session.user.id) {
    const reset = node('button', 'button secondary small-button', 'Nueva contraseña');
    reset.type = 'button';
    reset.setAttribute('aria-label', `Nueva contraseña para ${user.username}`);
    reset.addEventListener('click', () => {
      resetUser = user;
      $('resetPassword').value = '';
      tell('resetStatus', '');
      $('resetDescription').textContent = `Cambiarás la contraseña de @${user.username}. Sus sesiones abiertas se cerrarán al guardar.`;
      $('resetDialog').showModal();
    });
    const toggle = node('button', 'text-button', user.disabled ? 'Permitir acceso' : 'Quitar acceso');
    toggle.type = 'button';
    toggle.setAttribute('aria-label', `${user.disabled ? 'Permitir' : 'Quitar'} acceso a ${user.username}`);
    toggle.addEventListener('click', async () => {
      if (toggle.disabled) return;
      if (!user.disabled && !confirm(`¿Quitar el acceso a @${user.username}? Sus sesiones se cerrarán. Podrás permitirle entrar de nuevo después.`)) return;
      toggle.disabled = true;
      reset.disabled = true;
      tell('usersStatus', 'Actualizando acceso…');
      try {
        await api(`/api/admin/users/${encodeURIComponent(user.id)}`, { method: 'PATCH', body: { disabled: !user.disabled } });
        await loadUsers();
        tell('usersStatus', user.disabled ? `Acceso permitido a @${user.username}.` : `Acceso retirado a @${user.username}.`);
      } catch (error) { tell('usersStatus', error.message, true); }
      finally { toggle.disabled = false; reset.disabled = false; }
    });
    actions.append(reset, toggle);
  } else {
    actions.append(node('span', 'muted', 'Tu contraseña se cambia más abajo.'));
  }
  row.append(actions);
  return row;
}

async function loadUsers() {
  if (loadingUsers || session?.user.role !== 'admin') return;
  loadingUsers = true;
  $('refreshUsers').disabled = true;
  try {
    const data = await api('/api/admin/users');
    if (!Array.isArray(data.users)) throw new Error('No pudimos leer la lista de usuarios.');
    $('usersList').replaceChildren(...data.users.map(renderUser));
    $('userCount').textContent = `${data.users.length} ${data.users.length === 1 ? 'usuario' : 'usuarios'}`;
    tell('usersStatus', data.users.length ? '' : 'Todavía no has creado usuarios.');
  } catch (error) { tell('usersStatus', error.message, true); }
  finally { loadingUsers = false; $('refreshUsers').disabled = false; }
}
$('refreshUsers').addEventListener('click', loadUsers);

$('closeReset').addEventListener('click', () => $('resetDialog').close());
$('resetDialog').addEventListener('close', () => {
  $('resetPassword').value = '';
  resetUser = null;
});
$('resetPasswordForm').addEventListener('submit', event => {
  event.preventDefault();
  if (!resetUser) return;
  const user = resetUser;
  const password = $('resetPassword').value;
  runForm(event.currentTarget, 'resetStatus', async () => {
    await api(`/api/admin/users/${encodeURIComponent(user.id)}/password`, { method: 'POST', body: { password } });
    $('resetDialog').close();
    showCredentials(user.username, password);
    tell('usersStatus', `Contraseña actualizada para @${user.username}.`);
  });
});

$('confirmPassword').addEventListener('input', () => $('confirmPassword').setCustomValidity(''));
$('newPassword').addEventListener('input', () => $('confirmPassword').setCustomValidity(''));
$('changePasswordForm').addEventListener('submit', event => {
  event.preventDefault();
  if ($('newPassword').value !== $('confirmPassword').value) {
    $('confirmPassword').setCustomValidity('Las contraseñas deben coincidir.');
    $('confirmPassword').reportValidity();
    return;
  }
  const body = { currentPassword: $('currentPassword').value, newPassword: $('newPassword').value };
  runForm(event.currentTarget, 'passwordStatus', async () => {
    await api('/api/auth/password', { method: 'POST', body });
    tell('passwordStatus', 'Contraseña guardada. Entra de nuevo con tu nueva contraseña.');
    loginAgain();
  });
});

$('logoutButton').addEventListener('click', async () => {
  $('logoutButton').disabled = true;
  tell('accountStatus', 'Cerrando sesión…');
  try {
    await api('/api/auth/logout', { method: 'POST' });
    clearSecrets();
    location.replace('/login');
  } catch (error) {
    tell('accountStatus', error.message, true);
    $('logoutButton').disabled = false;
  }
});

async function checkSession() {
  if (checkingSession) return;
  checkingSession = true;
  try {
    const result = await api('/api/auth/session');
    if (result.authenticated !== true || result.format !== 'NEBO-SESSION-V1' || !result.user || typeof result.csrfToken !== 'string') {
      loginAgain();
      return;
    }
    const firstLoad = !session;
    session = result;
    $('accountName').textContent = session.user.displayName || session.user.username;
    $('accountUsername').textContent = `@${session.user.username}`;
    $('accountAvatar').textContent = (session.user.displayName || session.user.username).slice(0, 1).toUpperCase();
    $('accountRole').textContent = session.user.role === 'admin' ? 'Administrador' : 'Usuario';
    $('accountContent').hidden = false;
    $('adminSection').hidden = session.user.role !== 'admin';
    $('logoutButton').disabled = false;
    tell('accountStatus', '');
    if (firstLoad && session.user.role === 'admin') await loadUsers();
  } catch (error) { tell('accountStatus', error.message, true); }
  finally { checkingSession = false; }
}
checkSession();
document.addEventListener('visibilitychange', () => { if (!document.hidden) checkSession(); });
setInterval(() => { if (!document.hidden) checkSession(); }, 60000);
window.addEventListener('pagehide', clearSecrets);
window.addEventListener('pageshow', event => { if (event.persisted) { $('accountContent').hidden = true; checkSession(); } });
