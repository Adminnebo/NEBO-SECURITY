import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import worker from '../worker/index.js';
import { hashPassword, verifyPassword, digest, ensureDatabase, nowSeconds } from '../worker/auth.js';

// Uses the actual worker and password KDF, with SQLite transactions implementing
// the small D1 API surface. This is not a Cloudflare deployment/browser test.
class D1 {
  constructor(sqlite = new DatabaseSync(':memory:')) { this.sqlite = sqlite; }
  prepare(sql) {
    const db = this;
    return {
      sql, values: [],
      bind(...values) { return { ...this, values }; },
      async first() { return db.sqlite.prepare(this.sql).get(...this.values) || null; },
      async all() { return { results: db.sqlite.prepare(this.sql).all(...this.values) }; },
      async run() {
        const result = db.sqlite.prepare(this.sql).run(...this.values);
        return { success: true, meta: { changes: result.changes } };
      },
    };
  }
  async batch(statements) {
    this.sqlite.exec('BEGIN IMMEDIATE');
    try {
      const results = statements.map(statement => {
        const results = this.sqlite.prepare(statement.sql).all(...statement.values);
        const changes = this.sqlite.prepare('SELECT changes() AS value').get().value;
        return { success: true, results, meta: { changes } };
      });
      this.sqlite.exec('COMMIT');
      return results;
    } catch (error) { this.sqlite.exec('ROLLBACK'); throw error; }
  }
}

const origin = 'https://nebo.example';
const checks = [];
const started = performance.now();
const ownerPassword = 'Owner-test-password-2026!';
const firstUserPassword = 'Friend-test-password-2026!';
const ownerHash = await hashPassword(ownerPassword);
const db = new D1();
const env = {
  DB: db,
  NEBO_BOOTSTRAP_ADMIN_JSON: JSON.stringify({ username: 'owner', displayName: 'Owner test', passwordHash: ownerHash }),
  ASSETS: { fetch: async request => new Response('Public fixture ' + new URL(request.url).pathname, { headers: { 'Content-Type': 'text/plain' } }) },
};

async function test(name, task) {
  try { await task(); checks.push({ name, passed: true }); }
  catch (error) { checks.push({ name, passed: false, error: error.message }); throw error; }
}

function call(path, options = {}) {
  const { method = 'GET', body, cookie, csrf, requestOrigin = origin, targetEnv = env, ip = '192.0.2.1', rawBody, contentType = 'application/json' } = options;
  const headers = { 'CF-Connecting-IP': ip };
  if (cookie) headers.Cookie = cookie;
  if (csrf) headers['X-CSRF-Token'] = csrf;
  if (requestOrigin !== null && method !== 'GET' && method !== 'HEAD') headers.Origin = requestOrigin;
  if (body !== undefined || rawBody !== undefined) headers['Content-Type'] = contentType;
  return worker.fetch(new Request(origin + path, { method, headers, body: rawBody ?? (body === undefined ? undefined : JSON.stringify(body)) }), targetEnv);
}

async function signIn(username, password, extras = {}) {
  const response = await call('/api/auth/login', { method: 'POST', body: { username, password }, ...extras });
  const data = await response.json();
  return { response, data, cookie: response.headers.get('set-cookie')?.split(';')[0], csrf: data.csrfToken };
}

let owner, friend, user;
try {
  await test('scrypt has independent 128-bit salts, correct parameters and constant-size keys', async () => {
    const second = await hashPassword(ownerPassword);
    assert.notEqual(second, ownerHash);
    assert.match(ownerHash, /^scrypt\$32768\$8\$3\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/);
    assert.equal(await verifyPassword(ownerPassword, ownerHash), true);
    assert.equal(await verifyPassword('incorrect', ownerHash), false);
  });

  await test('anonymous documents redirect; direct private assets and APIs reject access', async () => {
    for (const path of ['/', '/index.html', '/account', '/account.html', '/?modo=recibir']) {
      const response = await call(path);
      assert.equal(response.status, 303, path);
      const next = path.startsWith('/account') ? '/account' : path.includes('modo=recibir') ? '/?modo=recibir' : '/';
      assert.equal(response.headers.get('location'), '/login?next=' + encodeURIComponent(next));
      assert.match(response.headers.get('cache-control'), /no-store/);
    }
    for (const path of ['/app.js', '/access.js', '/sw.js', '/manifest.webmanifest', '/secure-worker.js', '/account.js', '/api/auth/session', '/api/admin/users', '/access-check.json']) {
      const response = await call(path);
      assert.equal(response.status, 401, path);
      assert.equal((await response.json()).error, 'Inicia sesión para continuar.');
    }
  });

  await test('only login and allowlisted presentation files are public', async () => {
    const response = await call('/login');
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.equal((await call('/login.html')).status, 303);
    for (const path of ['/login.js', '/auth.css', '/theme.js', '/assets/nebo-logo-original.png', '/assets/mountain.png']) assert.equal((await call(path)).status, 200);
    assert.equal((await call('/login.js', { method: 'POST' })).status, 405);
  });

  await test('missing database or bootstrap configuration fails closed on every surface', async () => {
    for (const targetEnv of [{ ...env, DB: undefined }, { ...env, NEBO_BOOTSTRAP_ADMIN_JSON: undefined }]) {
      for (const path of ['/', '/login', '/app.js', '/login.js', '/api/auth/session']) assert.equal((await call(path, { targetEnv })).status, 503);
    }
  });

  await test('login rejects absent/foreign Origin, oversized and malformed request bodies', async () => {
    for (const requestOrigin of [null, 'https://attacker.example']) assert.equal((await signIn('owner', ownerPassword, { requestOrigin })).response.status, 403);
    assert.equal((await call('/api/auth/login', { method: 'POST', rawBody: '{broken' })).status, 400);
    assert.equal((await call('/api/auth/login', { method: 'POST', rawBody: 'x'.repeat(16385) })).status, 413);
    assert.equal((await call('/api/auth/login', { method: 'POST', rawBody: '{}', contentType: 'text/plain' })).status, 415);
  });

  await test('unknown account and wrong password return the same generic failure', async () => {
    const unknown = await signIn('nobody', ownerPassword);
    const wrong = await signIn('owner', 'Wrong-owner-password!');
    assert.equal(unknown.response.status, 401);
    assert.equal(wrong.response.status, 401);
    assert.deepEqual(unknown.data, wrong.data);
  });

  await test('owner login creates a hash-only session and secure HttpOnly cookie', async () => {
    owner = await signIn(' OWNER ', ownerPassword);
    assert.equal(owner.response.status, 200);
    assert.equal(owner.data.user.role, 'admin');
    assert.equal(owner.data.user.username, 'owner');
    assert.equal('passwordHash' in owner.data.user, false);
    const cookieHeader = owner.response.headers.get('set-cookie');
    for (const attribute of ['__Host-nebo_session=', 'Secure', 'HttpOnly', 'SameSite=Lax', 'Path=/', 'Max-Age=28800']) assert.ok(cookieHeader.includes(attribute));
    const rawToken = owner.cookie.split('=')[1];
    const stored = db.sqlite.prepare('SELECT * FROM nebo_sessions').get();
    assert.equal(stored.token_hash, digest(rawToken));
    assert.equal(JSON.stringify(stored).includes(rawToken), false);
    const session = await call('/api/auth/session', { cookie: owner.cookie });
    assert.equal(session.status, 200);
    assert.equal((await session.json()).format, 'NEBO-SESSION-V1');
    assert.equal((await call('/app.js', { cookie: owner.cookie })).status, 200);
  });

  await test('duplicate/malformed session cookies fail; authenticated login redirects home', async () => {
    assert.equal((await call('/api/auth/session', { cookie: owner.cookie + '; ' + owner.cookie })).status, 401);
    assert.equal((await call('/api/auth/session', { cookie: '__Host-nebo_session=invalid' })).status, 401);
    const response = await call('/login', { cookie: owner.cookie });
    assert.equal(response.status, 303);
    assert.equal(response.headers.get('location'), '/');
  });

  await test('admin mutations require both exact Origin and per-session CSRF', async () => {
    const body = { username: 'friend', password: firstUserPassword };
    for (const extras of [{}, { csrf: 'A'.repeat(43) }, { csrf: owner.csrf, requestOrigin: 'https://attacker.example' }]) {
      assert.equal((await call('/api/admin/users', { method: 'POST', cookie: owner.cookie, body, ...extras })).status, 403);
    }
  });

  await test('admin can create only ordinary users; request cannot elevate role', async () => {
    const response = await call('/api/admin/users', { method: 'POST', cookie: owner.cookie, csrf: owner.csrf, body: { username: 'Friend', password: firstUserPassword, displayName: 'Friend test', role: 'admin', disabled: false } });
    assert.equal(response.status, 201);
    user = (await response.json()).user;
    assert.equal(user.role, 'user');
    assert.equal(user.username, 'friend');
    friend = await signIn('FRIEND', firstUserPassword);
    assert.equal(friend.response.status, 200);
  });

  await test('ordinary users cannot list/create/disable/reset accounts', async () => {
    for (const [path, method, body] of [['/api/admin/users', 'GET'], ['/api/admin/users', 'POST', {}], ['/api/admin/users/' + user.id, 'PATCH', { disabled: true }], ['/api/admin/users/' + user.id + '/password', 'POST', { password: firstUserPassword }]]) {
      assert.equal((await call(path, { method, body, cookie: friend.cookie, csrf: friend.csrf })).status, 403);
    }
  });

  await test('no public registration and owner cannot be disabled/reset through user endpoints', async () => {
    assert.equal((await call('/api/auth/signup', { method: 'POST', body: {} })).status, 401);
    for (const [suffix, method, body] of [['', 'PATCH', { disabled: true }], ['/password', 'POST', { password: firstUserPassword }]]) {
      assert.equal((await call('/api/admin/users/' + owner.data.user.id + suffix, { method, body, cookie: owner.cookie, csrf: owner.csrf })).status, 403);
    }
  });

  await test('expired sessions cannot access any private asset', async () => {
    const tokenHash = digest(friend.cookie.split('=')[1]);
    db.sqlite.prepare('UPDATE nebo_sessions SET expires_at = ? WHERE token_hash = ?').run(nowSeconds() - 1, tokenHash);
    assert.equal((await call('/app.js', { cookie: friend.cookie })).status, 401);
    friend = await signIn('friend', firstUserPassword);
    assert.equal(friend.response.status, 200);
  });

  await test('disable revokes every session; reenabling does not restore old cookies', async () => {
    const response = await call('/api/admin/users/' + user.id, { method: 'PATCH', body: { disabled: true }, cookie: owner.cookie, csrf: owner.csrf });
    assert.equal(response.status, 200);
    assert.equal((await call('/api/auth/session', { cookie: friend.cookie })).status, 401);
    const disabled = await signIn('friend', firstUserPassword);
    assert.equal(disabled.response.status, 401);
    assert.equal(disabled.data.error, 'Usuario o contraseña incorrectos.');
    assert.equal((await call('/api/admin/users/' + user.id, { method: 'PATCH', body: { disabled: false }, cookie: owner.cookie, csrf: owner.csrf })).status, 200);
    assert.equal((await call('/api/auth/session', { cookie: friend.cookie })).status, 401);
    friend = await signIn('friend', firstUserPassword);
    assert.equal(friend.response.status, 200);
  });

  await test('admin password reset revokes sessions and invalidates old password', async () => {
    const response = await call('/api/admin/users/' + user.id + '/password', { method: 'POST', body: { password: 'Friend-new-password-2026!' }, cookie: owner.cookie, csrf: owner.csrf });
    assert.equal(response.status, 200);
    assert.equal((await call('/api/auth/session', { cookie: friend.cookie })).status, 401);
    assert.equal((await signIn('friend', firstUserPassword)).response.status, 401);
    friend = await signIn('friend', 'Friend-new-password-2026!');
    assert.equal(friend.response.status, 200);
  });

  await test('own password change revokes all sessions and needs current password', async () => {
    const wrong = await call('/api/auth/password', { method: 'POST', cookie: friend.cookie, csrf: friend.csrf, body: { currentPassword: 'incorrect', newPassword: 'Friend-own-password-2026!' } });
    assert.equal(wrong.status, 401);
    const changed = await call('/api/auth/password', { method: 'POST', cookie: friend.cookie, csrf: friend.csrf, body: { currentPassword: 'Friend-new-password-2026!', newPassword: 'Friend-own-password-2026!' } });
    assert.equal(changed.status, 200);
    assert.match(changed.headers.get('set-cookie'), /Max-Age=0/);
    assert.equal((await call('/api/auth/session', { cookie: friend.cookie })).status, 401);
    friend = await signIn('friend', 'Friend-own-password-2026!');
    assert.equal(friend.response.status, 200);
  });

  await test('logout rejects missing CSRF, deletes session, and invalidates replay', async () => {
    assert.equal((await call('/api/auth/logout', { method: 'POST', cookie: friend.cookie })).status, 403);
    assert.equal((await call('/api/auth/logout', { method: 'POST', cookie: friend.cookie, csrf: friend.csrf })).status, 200);
    assert.equal((await call('/app.js', { cookie: friend.cookie })).status, 401);
  });

  await test('bootstrap is persistent across a fresh D1 wrapper and never recreates deleted owner', async () => {
    const original = db.sqlite.prepare('SELECT id FROM nebo_users WHERE role = ?').get('admin').id;
    await ensureDatabase({ ...env, DB: new D1(db.sqlite) });
    assert.equal(db.sqlite.prepare('SELECT id FROM nebo_users WHERE role = ?').get('admin').id, original);
    const secondDb = new D1();
    const secondEnv = { ...env, DB: secondDb };
    await ensureDatabase(secondEnv);
    secondDb.sqlite.exec('DELETE FROM nebo_users');
    await ensureDatabase({ ...secondEnv, DB: new D1(secondDb.sqlite) });
    assert.equal(secondDb.sqlite.prepare('SELECT count(*) AS n FROM nebo_users').get().n, 0);
  });

  await test('account and IP rate limits persist in SQLite and reserve attempts atomically', async () => {
    db.sqlite.exec('DELETE FROM nebo_auth_limits');
    const windowStart = Math.floor(nowSeconds() / 900) * 900;
    db.sqlite.prepare('INSERT INTO nebo_auth_limits VALUES (?, ?, ?)').run('user:' + digest('owner'), windowStart, 9);
    const tenth = await signIn('owner', 'Wrong-owner-password!', { ip: '192.0.2.20' });
    assert.equal(tenth.response.status, 401);
    const eleventh = await signIn('owner', ownerPassword, { ip: '192.0.2.21' });
    assert.equal(eleventh.response.status, 429);
    assert.ok(Number(eleventh.response.headers.get('retry-after')) > 0);
    const ip = '192.0.2.50';
    db.sqlite.prepare('INSERT INTO nebo_auth_limits VALUES (?, ?, ?)').run('ip:' + digest(ip), windowStart, 30);
    assert.equal((await signIn('new-unknown', ownerPassword, { ip })).response.status, 429);
    assert.equal(db.sqlite.prepare('SELECT attempts FROM nebo_auth_limits WHERE bucket = ?').get('ip:' + digest(ip)).attempts, 31);
    assert.equal(db.sqlite.prepare('SELECT bucket FROM nebo_auth_limits WHERE bucket LIKE ?').all('%192.0.2.%').length, 0);
  });

  await test('simultaneous login attempts cannot cross the account limit', async () => {
    db.sqlite.exec('DELETE FROM nebo_auth_limits');
    const windowStart = Math.floor(nowSeconds() / 900) * 900;
    db.sqlite.prepare('INSERT INTO nebo_auth_limits VALUES (?, ?, ?)').run('user:' + digest('owner'), windowStart, 9);
    const attempts = await Promise.all([
      signIn('owner', 'Wrong-owner-password!', { ip: '192.0.2.60' }),
      signIn('owner', 'Wrong-owner-password!', { ip: '192.0.2.61' }),
    ]);
    assert.deepEqual(attempts.map(attempt => attempt.response.status).sort(), [401, 429]);
    assert.equal(db.sqlite.prepare('SELECT attempts FROM nebo_auth_limits WHERE bucket = ?').get('user:' + digest('owner')).attempts, 11);
  });

  await test('password reset during verification cannot issue an obsolete-password session', async () => {
    db.sqlite.exec('DELETE FROM nebo_auth_limits');
    const oldPrepare = db.prepare;
    let intercepted = false;
    const resetHash = await hashPassword('Owner-replaced-password-2026!');
    db.prepare = function (sql) {
      const statement = oldPrepare.call(this, sql);
      if (sql.startsWith('INSERT INTO nebo_sessions ')) {
        const run = statement.run;
        statement.run = async function () {
          intercepted = true;
          db.sqlite.prepare('UPDATE nebo_users SET password_hash = ? WHERE username = ?').run(resetHash, 'owner');
          db.sqlite.prepare('DELETE FROM nebo_sessions WHERE user_id = ?').run(owner.data.user.id);
          return run.call(this);
        };
      }
      return statement;
    };
    try {
      const attempt = await signIn('owner', ownerPassword);
      assert.equal(intercepted, true);
      assert.equal(attempt.response.status, 401);
      assert.equal(db.sqlite.prepare('SELECT count(*) AS n FROM nebo_sessions WHERE user_id = ?').get(owner.data.user.id).n, 0);
    } finally { db.prepare = oldPrepare; }
  });

  await test('storage exception never falls through to app or assets', async () => {
    const failingDb = { prepare() { throw new Error('Simulated outage'); }, async batch() { throw new Error('Simulated outage'); } };
    for (const path of ['/', '/login', '/app.js', '/api/auth/session']) assert.equal((await call(path, { cookie: owner.cookie, targetEnv: { ...env, DB: failingDb } })).status, 503);
  });
} catch {
  process.exitCode = 1;
} finally {
  const report = { testedAt: new Date().toISOString(), implementation: 'Actual Worker modules; real node:crypto scrypt; SQLite transaction adapter for D1; no deployed service or OAuth claim', passed: checks.every(check => check.passed), durationSeconds: Number(((performance.now() - started) / 1000).toFixed(3)), checks };
  await writeFile(new URL('./NATIVE_AUTH_BACKEND_REPORT.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
}
