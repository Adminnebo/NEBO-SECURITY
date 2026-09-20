import {
  HttpError, ensureDatabase, getSession, login, logout, clearCookie,
  requireCsrf, changeOwnPassword, listUsers, createUser,
  setUserDisabled, resetUserPassword,
} from './auth.js';
import { servePrivateAsset } from './site-assets.js';

const PUBLIC_ASSETS = new Set([
  '/login.js', '/auth.css', '/theme.js',
  '/assets/nebo-logo-original.png', '/assets/nebo-symbol.svg', '/assets/mountain.png',
]);
const APP_DOCUMENTS = new Set(['/', '/index.html', '/account', '/account.html']);
const CSP = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; media-src 'self' blob:; worker-src 'self' blob:; connect-src 'self' blob:; font-src 'self' data:; frame-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

function protect(response) {
  const headers = new Headers(response.headers);
  headers.set('Cache-Control', 'no-store, private, max-age=0');
  headers.set('Pragma', 'no-cache');
  headers.set('Expires', '0');
  headers.set('Vary', 'Cookie');
  headers.set('Content-Security-Policy', CSP);
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('X-Frame-Options', 'DENY');
  headers.set('Referrer-Policy', 'no-referrer');
  headers.set('Strict-Transport-Security', 'max-age=31536000');
  headers.set('Permissions-Policy', 'camera=(self), microphone=(self), geolocation=(self)');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers } });
}

function redirect(location) {
  return new Response(null, { status: 303, headers: { Location: location } });
}

async function asset(request, env, pathname) {
  if (!env.ASSETS || typeof env.ASSETS.fetch !== 'function') throw new Error('Missing asset binding');
  const url = new URL(request.url);
  if (pathname) url.pathname = pathname;
  // Credentials are never forwarded to a third-party origin; ASSETS is the
  // private same-deployment binding, reachable only after this router's checks.
  return env.ASSETS.fetch(new Request(url, request));
}

async function privateAsset(request, pathname) {
  const response = await servePrivateAsset(request, pathname);
  if (!response) throw new HttpError(404, 'No se encontró ese archivo.');
  return response;
}

function method(request, allowed) {
  if (!allowed.includes(request.method)) throw new HttpError(405, 'Método no permitido.', { Allow: allowed.join(', ') });
}

async function route(request, env) {
  await ensureDatabase(env);
  const url = new URL(request.url);
  const path = url.pathname;

  if (path === '/api/auth/login') {
    method(request, ['POST']);
    const result = await login(request, env);
    return json(result.body, 200, { 'Set-Cookie': result.cookie });
  }

  const session = await getSession(request, env);
  if (path === '/login' || path === '/login.html') {
    method(request, ['GET', 'HEAD']);
    if (session) return redirect('/');
    if (path === '/login.html') return redirect('/login');
    return privateAsset(request, '/login.html');
  }

  if (PUBLIC_ASSETS.has(path)) {
    method(request, ['GET', 'HEAD']);
    return asset(request, env);
  }

  if (!session) {
    if (APP_DOCUMENTS.has(path) && ['GET', 'HEAD'].includes(request.method)) {
      const next = path.startsWith('/account') ? '/account' : url.searchParams.get('modo') === 'recibir' ? '/?modo=recibir' : '/';
      return redirect('/login?next=' + encodeURIComponent(next));
    }
    throw new HttpError(401, 'Inicia sesión para continuar.', { 'Set-Cookie': clearCookie() });
  }

  if (path === '/api/auth/session') {
    method(request, ['GET']);
    return json({ authenticated: true, format: 'NEBO-SESSION-V1', user: session.user, csrfToken: session.csrfToken });
  }

  if (path === '/api/auth/logout') {
    method(request, ['POST']);
    requireCsrf(request, session);
    await logout(env, session);
    return json({ ok: true }, 200, { 'Set-Cookie': clearCookie() });
  }

  if (path === '/api/auth/password') {
    method(request, ['POST']);
    requireCsrf(request, session);
    await changeOwnPassword(request, env, session);
    return json({ ok: true, signedOut: true }, 200, { 'Set-Cookie': clearCookie() });
  }

  if (path === '/api/admin/users' || path.startsWith('/api/admin/users/')) {
    if (session.user.role !== 'admin') throw new HttpError(403, 'Esta opción solo está disponible para el administrador.');
    if (path === '/api/admin/users') {
      method(request, ['GET', 'POST']);
      if (request.method === 'GET') return json({ users: await listUsers(env) });
      requireCsrf(request, session);
      return json({ ok: true, user: await createUser(request, env) }, 201);
    }
    const match = /^\/api\/admin\/users\/([0-9a-f-]{36})(\/password)?$/.exec(path);
    if (!match) throw new HttpError(404, 'No se encontró esa opción.');
    method(request, match[2] ? ['POST'] : ['PATCH']);
    requireCsrf(request, session);
    if (match[2]) await resetUserPassword(request, env, match[1]);
    else await setUserDisabled(request, env, match[1]);
    return json({ ok: true });
  }

  if (path.startsWith('/api/') || path === '/access-check.json') throw new HttpError(404, 'No se encontró esa opción.');
  method(request, ['GET', 'HEAD']);
  if (path === '/account' || path === '/account.html') return privateAsset(request, '/account.html');
  if (path === '/' || path === '/index.html') return privateAsset(request, '/index.html');
  const privateResponse = await servePrivateAsset(request, path);
  if (privateResponse) return privateResponse;
  return asset(request, env);
}

export default {
  async fetch(request, env) {
    try { return protect(await route(request, env)); }
    catch (error) {
      if (error instanceof HttpError) return protect(json({ error: error.message }, error.status, error.headers));
      // Database/configuration failures must never fall through to static files.
      return protect(json({ error: 'El servicio de acceso no está disponible. Inténtalo de nuevo más tarde.' }, 503));
    }
  },
};
