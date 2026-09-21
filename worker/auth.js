import { randomBytes, scrypt, timingSafeEqual, createHash, randomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';

export const SESSION_SECONDS = 8 * 60 * 60;
export const COOKIE_NAME = '__Host-nebo_session';
const SCRYPT = { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 };
const HASH_PREFIX = 'scrypt$32768$8$3$';
const DUMMY_HASH = HASH_PREFIX + Buffer.alloc(16).toString('base64url') + '$' + Buffer.alloc(32).toString('base64url');
const initialized = new WeakMap();

export class HttpError extends Error {
  constructor(status, message, headers = {}) {
    super(message);
    this.status = status;
    this.headers = headers;
  }
}

export function normalizeUsername(value) {
  if (typeof value !== 'string') return null;
  const result = value.trim().toLowerCase();
  return /^[a-z0-9._-]{3,40}$/.test(result) ? result : null;
}

export function validatePassword(password) {
  return typeof password === 'string' && [...password].length >= 12 && [...password].length <= 128 && Buffer.byteLength(password, 'utf8') <= 1024;
}

function derive(password, salt) {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, 32, SCRYPT, (error, key) => error ? reject(error) : resolve(key));
  });
}

function parseHash(value) {
  if (typeof value !== 'string' || !value.startsWith(HASH_PREFIX)) return null;
  const parts = value.split('$');
  if (parts.length !== 6 || !/^[A-Za-z0-9_-]{22}$/.test(parts[4]) || !/^[A-Za-z0-9_-]{43}$/.test(parts[5])) return null;
  const salt = Buffer.from(parts[4], 'base64url');
  const key = Buffer.from(parts[5], 'base64url');
  if (salt.length !== 16 || key.length !== 32 || salt.toString('base64url') !== parts[4] || key.toString('base64url') !== parts[5]) return null;
  return { salt, key };
}

export async function hashPassword(password) {
  if (!validatePassword(password)) throw new HttpError(400, 'La contraseña debe tener entre 12 y 128 caracteres.');
  const salt = randomBytes(16);
  const key = await derive(password, salt);
  return HASH_PREFIX + salt.toString('base64url') + '$' + key.toString('base64url');
}

export async function verifyPassword(password, encoded) {
  const parsed = parseHash(encoded) || parseHash(DUMMY_HASH);
  const key = await derive(password, parsed.salt);
  return timingSafeEqual(key, parsed.key) && Boolean(parseHash(encoded));
}

export function digest(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function nowSeconds() { return Math.floor(Date.now() / 1000); }

export function publicUser(row) {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    role: row.role,
    disabled: Boolean(row.disabled),
    createdAt: new Date(row.created_at * 1000).toISOString(),
  };
}

export function displayName(value, fallback) {
  if (value === undefined || value === '') return fallback;
  if (typeof value !== 'string' || value.trim().length < 1 || [...value.trim()].length > 80 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new HttpError(400, 'El nombre debe tener entre 1 y 80 caracteres.');
  }
  return value.trim();
}

async function initialize(env) {
  if (!env.DB || typeof env.DB.prepare !== 'function' || typeof env.DB.batch !== 'function') throw new Error('Missing database binding');
  let bootstrap;
  try { bootstrap = JSON.parse(env.NEBO_BOOTSTRAP_ADMIN_JSON); } catch { throw new Error('Missing bootstrap configuration'); }
  const username = normalizeUsername(bootstrap?.username);
  if (!username || !parseHash(bootstrap?.passwordHash)) throw new Error('Invalid bootstrap configuration');
  const name = displayName(bootstrap.displayName, username);
  const initializeDatabase = async database => {
    await database.batch([
      database.prepare('CREATE TABLE IF NOT EXISTS nebo_auth_meta (name TEXT PRIMARY KEY, value TEXT NOT NULL)'),
      database.prepare("CREATE TABLE IF NOT EXISTS nebo_users (id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL, password_hash TEXT NOT NULL, role TEXT NOT NULL CHECK (role IN ('admin', 'user')), disabled INTEGER NOT NULL DEFAULT 0 CHECK (disabled IN (0, 1)), created_at INTEGER NOT NULL)"),
      database.prepare('CREATE TABLE IF NOT EXISTS nebo_sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES nebo_users(id) ON DELETE CASCADE, csrf_token TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL)'),
      database.prepare('CREATE INDEX IF NOT EXISTS nebo_sessions_user ON nebo_sessions(user_id)'),
      database.prepare('CREATE INDEX IF NOT EXISTS nebo_sessions_expiry ON nebo_sessions(expires_at)'),
      database.prepare('CREATE TABLE IF NOT EXISTS nebo_auth_limits (bucket TEXT PRIMARY KEY, window_start INTEGER NOT NULL, attempts INTEGER NOT NULL)'),
      database.prepare('CREATE INDEX IF NOT EXISTS nebo_auth_limits_window ON nebo_auth_limits(window_start)'),
    ]);
    // The persistent marker prevents resurrection after later account changes.
    // D1 serializes each batch; PostgreSQL also locks the complete initialization.
    await database.batch([
      database.prepare("INSERT INTO nebo_users (id, username, display_name, password_hash, role, disabled, created_at) SELECT ?, ?, ?, ?, 'admin', 0, ? WHERE NOT EXISTS (SELECT 1 FROM nebo_auth_meta WHERE name = 'bootstrapped') AND NOT EXISTS (SELECT 1 FROM nebo_users)").bind(randomUUID(), username, name, bootstrap.passwordHash, nowSeconds()),
      database.prepare("INSERT INTO nebo_auth_meta (name, value) VALUES ('bootstrapped', '1') ON CONFLICT(name) DO NOTHING"),
    ]);
  };
  if (typeof env.DB.withInitializationLock === 'function') await env.DB.withInitializationLock(initializeDatabase);
  else await initializeDatabase(env.DB);
}

export async function ensureDatabase(env) {
  if (!env.DB || typeof env.DB !== 'object') throw new Error('Missing database binding');
  if (typeof env.NEBO_BOOTSTRAP_ADMIN_JSON !== 'string' || !env.NEBO_BOOTSTRAP_ADMIN_JSON) throw new Error('Missing bootstrap configuration');
  let task = initialized.get(env.DB);
  if (!task) {
    task = initialize(env);
    initialized.set(env.DB, task);
    task.catch(() => initialized.delete(env.DB));
  }
  await task;
}

export async function readJson(request) {
  if ((request.headers.get('content-type') || '').split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
    throw new HttpError(415, 'Envía los datos en formato JSON.');
  }
  const limit = 16 * 1024;
  const declaredLength = Number(request.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > limit) throw new HttpError(413, 'La solicitud es demasiado grande.');
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, 'Faltan los datos de la solicitud.');
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel();
        throw new HttpError(413, 'La solicitud es demasiado grande.');
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  try {
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    const data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!data || Array.isArray(data) || typeof data !== 'object') throw new Error('Invalid JSON object');
    return data;
  } catch { throw new HttpError(400, 'Los datos de la solicitud no son válidos.'); }
}

export function requireOrigin(request) {
  if (request.headers.get('origin') !== new URL(request.url).origin) {
    throw new HttpError(403, 'La solicitud debe realizarse desde esta aplicación.');
  }
}

function sessionCookie(request) {
  const matches = (request.headers.get('cookie') || '').split(';').map(part => part.trim()).filter(part => part.startsWith(COOKIE_NAME + '='));
  if (matches.length !== 1) return null;
  const token = matches[0].slice(COOKIE_NAME.length + 1);
  return /^[A-Za-z0-9_-]{43}$/.test(token) ? token : null;
}

export async function getSession(request, env) {
  const token = sessionCookie(request);
  if (!token) return null;
  const row = await env.DB.prepare('SELECT u.id, u.username, u.display_name, u.role, u.disabled, u.created_at, s.token_hash, s.csrf_token, s.expires_at FROM nebo_sessions s JOIN nebo_users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ? AND u.disabled = 0').bind(digest(token), nowSeconds()).first();
  return row ? { user: publicUser(row), tokenHash: row.token_hash, csrfToken: row.csrf_token, expiresAt: row.expires_at } : null;
}

export function requireCsrf(request, session) {
  requireOrigin(request);
  const token = request.headers.get('x-csrf-token') || '';
  if (!/^[A-Za-z0-9_-]{43}$/.test(token) || !timingSafeEqual(Buffer.from(token), Buffer.from(session.csrfToken))) {
    throw new HttpError(403, 'La sesión de seguridad cambió. Actualiza la página.');
  }
}

export function clearCookie() {
  return `${COOKIE_NAME}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`;
}

async function reserveLoginAttempt(request, env, username) {
  const now = nowSeconds();
  const windowStart = Math.floor(now / 900) * 900;
  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  const sql = 'INSERT INTO nebo_auth_limits (bucket, window_start, attempts) VALUES (?, ?, 1) ON CONFLICT(bucket) DO UPDATE SET attempts = CASE WHEN nebo_auth_limits.window_start = excluded.window_start THEN nebo_auth_limits.attempts + 1 ELSE 1 END, window_start = excluded.window_start RETURNING attempts';
  const results = await env.DB.batch([
    env.DB.prepare(sql).bind('user:' + digest(username), windowStart),
    env.DB.prepare(sql).bind('ip:' + digest(ip), windowStart),
    env.DB.prepare('DELETE FROM nebo_auth_limits WHERE window_start < ?').bind(windowStart - 900),
    env.DB.prepare('DELETE FROM nebo_sessions WHERE expires_at <= ?').bind(now),
  ]);
  if (Number(results[0].results[0].attempts) > 10 || Number(results[1].results[0].attempts) > 30) {
    throw new HttpError(429, 'Demasiados intentos. Espera unos minutos antes de volver a entrar.', { 'Retry-After': String(windowStart + 900 - now) });
  }
}

export async function login(request, env) {
  requireOrigin(request);
  const body = await readJson(request);
  const username = normalizeUsername(body.username);
  if (typeof body.password !== 'string' || Buffer.byteLength(body.password, 'utf8') > 1024 || [...body.password].length > 128) {
    throw new HttpError(400, 'Revisa el usuario y la contraseña.');
  }
  await reserveLoginAttempt(request, env, username || '(invalid)');
  const row = username ? await env.DB.prepare('SELECT * FROM nebo_users WHERE username = ?').bind(username).first() : null;
  const valid = await verifyPassword(body.password, row?.password_hash || DUMMY_HASH);
  if (!valid || !row || row.disabled) throw new HttpError(401, 'Usuario o contraseña incorrectos.');
  const token = randomBytes(32).toString('base64url');
  const csrfToken = randomBytes(32).toString('base64url');
  const now = nowSeconds();
  // Recheck credentials at insertion. PostgreSQL also holds a shared user-row
  // lock through commit so a concurrent reset/disable either happens first or
  // revokes this session afterwards. The expensive KDF stays outside the lock.
  const insertSession = database => database.prepare('INSERT INTO nebo_sessions (token_hash, user_id, csrf_token, created_at, expires_at) SELECT ?, id, ?, ?, ? FROM nebo_users WHERE id = ? AND password_hash = ? AND disabled = 0').bind(digest(token), csrfToken, now, now + SESSION_SECONDS, row.id, row.password_hash).run();
  const result = typeof env.DB.withUserLock === 'function'
    ? await env.DB.withUserLock(row.id, insertSession)
    : await insertSession(env.DB);
  if (result.meta.changes !== 1) throw new HttpError(401, 'Usuario o contraseña incorrectos.');
  return {
    body: { ok: true, user: publicUser(row), csrfToken },
    cookie: `${COOKIE_NAME}=${token}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${SESSION_SECONDS}`,
  };
}

export async function logout(env, session) {
  await env.DB.prepare('DELETE FROM nebo_sessions WHERE token_hash = ?').bind(session.tokenHash).run();
}

export async function changeOwnPassword(request, env, session) {
  const body = await readJson(request);
  if (typeof body.currentPassword !== 'string' || Buffer.byteLength(body.currentPassword, 'utf8') > 1024 || !validatePassword(body.newPassword)) {
    throw new HttpError(400, 'La contraseña nueva debe tener entre 12 y 128 caracteres.');
  }
  const row = await env.DB.prepare('SELECT password_hash FROM nebo_users WHERE id = ? AND disabled = 0').bind(session.user.id).first();
  if (!row || !await verifyPassword(body.currentPassword, row.password_hash)) throw new HttpError(401, 'La contraseña actual no es correcta.');
  const passwordHash = await hashPassword(body.newPassword);
  const results = await env.DB.batch([
    env.DB.prepare('UPDATE nebo_users SET password_hash = ? WHERE id = ? AND password_hash = ? AND disabled = 0').bind(passwordHash, session.user.id, row.password_hash),
    env.DB.prepare('DELETE FROM nebo_sessions WHERE user_id = ?').bind(session.user.id),
  ]);
  if (results[0].meta.changes !== 1) throw new HttpError(401, 'La sesión cambió. Vuelve a iniciar sesión.');
}

export async function listUsers(env) {
  const result = await env.DB.prepare('SELECT id, username, display_name, role, disabled, created_at FROM nebo_users ORDER BY created_at, username').all();
  return result.results.map(publicUser);
}

export async function createUser(request, env) {
  const body = await readJson(request);
  const username = normalizeUsername(body.username);
  if (!username) throw new HttpError(400, 'Usa un usuario de 3 a 40 letras, números, puntos, guiones o guiones bajos.');
  const name = displayName(body.displayName, username);
  const passwordHash = await hashPassword(body.password);
  const user = { id: randomUUID(), username, display_name: name, role: 'user', disabled: 0, created_at: nowSeconds() };
  const result = await env.DB.prepare("INSERT INTO nebo_users (id, username, display_name, password_hash, role, disabled, created_at) VALUES (?, ?, ?, ?, 'user', 0, ?) ON CONFLICT(username) DO NOTHING").bind(user.id, username, name, passwordHash, user.created_at).run();
  if (result.meta.changes !== 1) throw new HttpError(409, 'Ese nombre de usuario ya existe.');
  return publicUser(user);
}

async function manageableUser(env, id) {
  const row = await env.DB.prepare('SELECT id, role FROM nebo_users WHERE id = ?').bind(id).first();
  if (!row) throw new HttpError(404, 'No se encontró ese usuario.');
  if (row.role !== 'user') throw new HttpError(403, 'La cuenta administradora no se puede modificar desde esta opción.');
}

export async function setUserDisabled(request, env, id) {
  const body = await readJson(request);
  if (typeof body.disabled !== 'boolean') throw new HttpError(400, 'Indica si el usuario está desactivado.');
  await manageableUser(env, id);
  const statements = [env.DB.prepare("UPDATE nebo_users SET disabled = ? WHERE id = ? AND role = 'user'").bind(body.disabled ? 1 : 0, id)];
  if (body.disabled) statements.push(env.DB.prepare('DELETE FROM nebo_sessions WHERE user_id = ?').bind(id));
  await env.DB.batch(statements);
}

export async function resetUserPassword(request, env, id) {
  const body = await readJson(request);
  await manageableUser(env, id);
  const passwordHash = await hashPassword(body.password);
  await env.DB.batch([
    env.DB.prepare("UPDATE nebo_users SET password_hash = ? WHERE id = ? AND role = 'user'").bind(passwordHash, id),
    env.DB.prepare('DELETE FROM nebo_sessions WHERE user_id = ?').bind(id),
  ]);
}
