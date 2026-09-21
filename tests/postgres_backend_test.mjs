import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import pg from 'pg';
import worker from '../worker/index.js';
import { createPostgresDatabase } from '../server/postgres.js';
import { hashPassword, digest, ensureDatabase, nowSeconds } from '../worker/auth.js';

// Deliberately never falls back to DATABASE_URL or a production connection.
// Each run owns a fresh schema, sets search_path to that schema, and drops only
// that exact generated schema. No public/user table is read, reset, or removed.
const input = process.env.TEST_DATABASE_URL;
assert.ok(input, 'Set TEST_DATABASE_URL to an explicit disposable PostgreSQL test database.');
const baseUrl = new URL(input);
assert.match(baseUrl.protocol, /^postgres(?:ql)?:$/);
assert.match(decodeURIComponent(baseUrl.pathname), /test/i, 'Test database name must contain "test".');
const schema = 'nebo_pg_test_' + randomUUID().replaceAll('-', '');
assert.match(schema, /^nebo_pg_test_[a-f0-9]{32}$/);
const isolatedUrl = new URL(baseUrl);
isolatedUrl.searchParams.set('options', '-c search_path=' + schema + ',pg_catalog');
const control = new pg.Pool({ connectionString: baseUrl.href, max: 2, connectionTimeoutMillis: 5000 });
const adapters = [];
const checks = [];
const started = performance.now();
const origin = 'https://nebo.test';
const ownerPassword = 'Owner-test-' + randomBytes(24).toString('base64url');
const friendPassword = 'Friend-test-' + randomBytes(24).toString('base64url');
const resetPassword = 'Reset-test-' + randomBytes(24).toString('base64url');
const changedPassword = 'Changed-test-' + randomBytes(24).toString('base64url');
const ownerHash = await hashPassword(ownerPassword);
let schemaCreated = false;
let postgresVersion;
let db, env, owner, friend, user;
let currentFriendPassword = changedPassword;

function database() {
  const adapter = createPostgresDatabase(isolatedUrl.href);
  adapters.push(adapter);
  return adapter;
}

function environment(adapter) {
  return {
    DB: adapter,
    NEBO_BOOTSTRAP_ADMIN_JSON: JSON.stringify({ username: 'owner', displayName: 'Test owner', passwordHash: ownerHash }),
    ASSETS: { fetch: async request => new Response('Public test fixture: ' + new URL(request.url).pathname) },
  };
}

async function test(name, task) {
  try { await task(); checks.push({ name, passed: true }); }
  catch (error) {
    // Do not record connection URLs, credentials, cookies, CSRF tokens or SQL values.
    checks.push({ name, passed: false, error: error.name, code: typeof error.code === 'string' ? error.code : undefined });
    throw error;
  }
}

function call(path, options = {}) {
  const { method = 'GET', body, cookie, csrf, requestOrigin = origin, targetEnv = env, ip = '192.0.2.1' } = options;
  const headers = { 'CF-Connecting-IP': ip };
  if (cookie) headers.Cookie = cookie;
  if (csrf) headers['X-CSRF-Token'] = csrf;
  if (requestOrigin !== null && !['GET', 'HEAD'].includes(method)) headers.Origin = requestOrigin;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  return worker.fetch(new Request(origin + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), targetEnv);
}

async function signIn(username, password, extras = {}) {
  const response = await call('/api/auth/login', { method: 'POST', body: { username, password }, ...extras });
  const data = await response.json();
  return { response, data, cookie: response.headers.get('set-cookie')?.split(';')[0], csrf: data.csrfToken };
}

const mutate = (path, method, body, actor = owner, extras = {}) => call(path, {
  method, body, cookie: actor.cookie, csrf: actor.csrf, ...extras,
});

async function waitForDatabaseLock(pid) {
  const deadline = performance.now() + 8000;
  while (performance.now() < deadline) {
    const processId = pid();
    if (processId) {
      const result = await control.query('SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1', [processId]);
      if (result.rows[0]?.wait_event_type === 'Lock') return;
    }
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  throw new Error('Expected real PostgreSQL row-lock wait was not observed');
}

function bounded(promise, milliseconds = 8000) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Concurrent test step timed out')), milliseconds); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function loginFirstRace(kind) {
  await db.prepare('DELETE FROM nebo_auth_limits').run();
  const writerEnv = environment(database());
  await ensureDatabase(writerEnv);
  let writePid;
  writerEnv.DB.pool.on('acquire', client => { writePid = client.processID; });
  let unlock, acquired;
  const lockReached = new Promise(resolve => { acquired = resolve; });
  const release = new Promise(resolve => { unlock = resolve; });
  const original = db.withUserLock;
  db.withUserLock = function (id, callback) {
    return original.call(this, id, async transaction => {
      acquired();
      await release;
      return callback(transaction);
    });
  };
  const nextPassword = 'Race-next-' + randomBytes(24).toString('base64url');
  let pendingLogin, pendingMutation;
  try {
    pendingLogin = signIn('friend', currentFriendPassword);
    await bounded(lockReached);
    pendingMutation = kind === 'reset'
      ? mutate('/api/admin/users/' + user.id + '/password', 'POST', { password: nextPassword }, owner, { targetEnv: writerEnv })
      : mutate('/api/admin/users/' + user.id, 'PATCH', { disabled: true }, owner, { targetEnv: writerEnv });
    await waitForDatabaseLock(() => writePid);
    unlock();
    const [loggedIn, mutation] = await Promise.all([pendingLogin, pendingMutation]);
    assert.equal(loggedIn.response.status, 200);
    assert.equal(mutation.status, 200);
    assert.equal((await call('/api/auth/session', { cookie: loggedIn.cookie })).status, 401);
    assert.equal(Number((await db.prepare('SELECT count(*) AS n FROM nebo_sessions WHERE user_id = ?').bind(user.id).first()).n), 0);
    if (kind === 'reset') currentFriendPassword = nextPassword;
    else assert.equal((await mutate('/api/admin/users/' + user.id, 'PATCH', { disabled: false })).status, 200);
  } finally {
    unlock();
    db.withUserLock = original;
    await Promise.allSettled([pendingLogin, pendingMutation].filter(Boolean));
  }
}

async function writerFirstRace(kind) {
  await db.prepare('DELETE FROM nebo_auth_limits').run();
  const readerEnv = environment(database());
  await ensureDatabase(readerEnv);
  let readPid;
  readerEnv.DB.pool.on('acquire', client => { readPid = client.processID; });
  const nextPassword = 'Race-reverse-' + randomBytes(24).toString('base64url');
  const nextHash = await hashPassword(nextPassword);
  const writer = await db.pool.connect();
  let pendingLogin;
  try {
    await writer.query('BEGIN');
    if (kind === 'reset') await writer.query('UPDATE nebo_users SET password_hash = $1 WHERE id = $2', [nextHash, user.id]);
    else await writer.query('UPDATE nebo_users SET disabled = 1 WHERE id = $1', [user.id]);
    await writer.query('DELETE FROM nebo_sessions WHERE user_id = $1', [user.id]);
    pendingLogin = signIn('friend', currentFriendPassword, { targetEnv: readerEnv });
    await waitForDatabaseLock(() => readPid);
    await writer.query('COMMIT');
    assert.equal((await pendingLogin).response.status, 401);
    assert.equal(Number((await db.prepare('SELECT count(*) AS n FROM nebo_sessions WHERE user_id = ?').bind(user.id).first()).n), 0);
    if (kind === 'reset') currentFriendPassword = nextPassword;
    else assert.equal((await mutate('/api/admin/users/' + user.id, 'PATCH', { disabled: false })).status, 200);
  } finally {
    await writer.query('ROLLBACK').catch(() => {});
    writer.release();
    if (pendingLogin) await pendingLogin;
  }
}

try {
  await test('real PostgreSQL TCP connection and unique isolated schema', async () => {
    const result = await control.query('SELECT version() AS version');
    postgresVersion = result.rows[0].version;
    assert.match(postgresVersion, /^PostgreSQL /);
    await control.query('CREATE SCHEMA "' + schema + '"');
    schemaCreated = true;
    db = database();
    env = environment(db);
    assert.equal((await db.prepare('SELECT current_schema() AS name').first()).name, schema);
  });

  await test('four independent connection pools initialize concurrently with one owner and marker', async () => {
    const environments = [env, ...Array.from({ length: 3 }, () => environment(database()))];
    await Promise.all(environments.map(value => ensureDatabase(value)));
    assert.equal(Number((await db.prepare("SELECT count(*) AS n FROM nebo_users WHERE role = 'admin'").first()).n), 1);
    assert.equal(Number((await db.prepare("SELECT count(*) AS n FROM nebo_auth_meta WHERE name = 'bootstrapped'").first()).n), 1);
    assert.equal(await db.healthCheck(), true);
  });

  await test('anonymous application documents and private modules are blocked', async () => {
    for (const path of ['/', '/index.html', '/account', '/?modo=recibir']) assert.equal((await call(path)).status, 303, path);
    for (const path of ['/app.js', '/account.js', '/secure-worker.js', '/sw.js', '/manifest.webmanifest', '/api/admin/users']) {
      assert.equal((await call(path)).status, 401, path);
    }
    assert.equal((await call('/login')).status, 200);
  });

  await test('wrong and unknown-user passwords return the same generic failure', async () => {
    const wrong = await signIn('owner', 'Wrong-password-for-test!');
    const unknown = await signIn('unknown', 'Wrong-password-for-test!');
    assert.equal(wrong.response.status, 401);
    assert.equal(unknown.response.status, 401);
    assert.equal(wrong.data.error, unknown.data.error);
  });

  await test('login stores a hashed session token in PostgreSQL and sets secure HttpOnly cookie', async () => {
    owner = await signIn('OWNER', ownerPassword);
    assert.equal(owner.response.status, 200);
    assert.equal(owner.data.user.role, 'admin');
    for (const attribute of ['__Host-nebo_session=', 'Secure', 'HttpOnly', 'SameSite=Lax', 'Path=/']) {
      assert.ok(owner.response.headers.get('set-cookie').includes(attribute));
    }
    const token = owner.cookie.split('=')[1];
    const stored = await db.prepare('SELECT token_hash FROM nebo_sessions WHERE user_id = ?').bind(owner.data.user.id).first();
    assert.equal(stored.token_hash, digest(token));
    assert.equal(JSON.stringify(stored).includes(token), false);
    assert.equal((await call('/app.js', { cookie: owner.cookie })).status, 200);
  });

  await test('CSRF and exact Origin are required for admin mutations', async () => {
    const body = { username: 'friend', password: friendPassword };
    for (const extras of [{ csrf: undefined }, { csrf: 'invalid' }, { requestOrigin: 'https://attacker.test' }, { requestOrigin: null }]) {
      assert.equal((await mutate('/api/admin/users', 'POST', body, owner, extras)).status, 403);
    }
  });

  await test('owner creates ordinary account, rejects duplicate and ignores role escalation', async () => {
    const response = await mutate('/api/admin/users', 'POST', { username: 'Friend', password: friendPassword, displayName: 'Test friend', role: 'admin' });
    assert.equal(response.status, 201);
    user = (await response.json()).user;
    assert.equal(user.username, 'friend');
    assert.equal(user.role, 'user');
    assert.equal((await mutate('/api/admin/users', 'POST', { username: 'friend', password: friendPassword })).status, 409);
    friend = await signIn('friend', friendPassword);
    assert.equal(friend.response.status, 200);
  });

  await test('ordinary account cannot list, create, disable, reset or escalate users', async () => {
    for (const [path, method, body] of [
      ['/api/admin/users', 'GET'], ['/api/admin/users', 'POST', {}],
      ['/api/admin/users/' + user.id, 'PATCH', { disabled: true }],
      ['/api/admin/users/' + user.id + '/password', 'POST', { password: resetPassword }],
    ]) assert.equal((await mutate(path, method, body, friend)).status, 403);
    assert.equal((await call('/api/auth/signup', { method: 'POST', body: {} })).status, 401);
  });

  await test('closing and reopening the real connection pool preserves accounts and active sessions', async () => {
    const ownerId = owner.data.user.id;
    await db.close();
    db = database();
    env = environment(db);
    await ensureDatabase(env);
    assert.equal((await db.prepare("SELECT id FROM nebo_users WHERE username = 'owner'").first()).id, ownerId);
    assert.equal(Number((await db.prepare('SELECT count(*) AS n FROM nebo_users').first()).n), 2);
    assert.equal((await call('/api/auth/session', { cookie: owner.cookie })).status, 200);
    assert.equal((await call('/api/auth/session', { cookie: friend.cookie })).status, 200);
  });

  await test('database transaction rolls back all writes on a SQL failure', async () => {
    await assert.rejects(db.batch([
      db.prepare("INSERT INTO nebo_auth_meta (name, value) VALUES ('rollback-test', 'value')"),
      db.prepare('INSERT INTO deliberately_missing_table (id) VALUES (1)'),
    ]));
    assert.equal(await db.prepare("SELECT name FROM nebo_auth_meta WHERE name = 'rollback-test'").first(), null);
  });

  await test('expiry in PostgreSQL immediately invalidates a session', async () => {
    await db.prepare('UPDATE nebo_sessions SET expires_at = ? WHERE token_hash = ?').bind(nowSeconds() - 1, digest(friend.cookie.split('=')[1])).run();
    assert.equal((await call('/app.js', { cookie: friend.cookie })).status, 401);
    friend = await signIn('friend', friendPassword);
    assert.equal(friend.response.status, 200);
  });

  await test('disabling revokes every session and reenabling never revives old cookies', async () => {
    const second = await signIn('friend', friendPassword);
    assert.equal((await mutate('/api/admin/users/' + user.id, 'PATCH', { disabled: true })).status, 200);
    for (const actor of [friend, second]) assert.equal((await call('/api/auth/session', { cookie: actor.cookie })).status, 401);
    assert.equal((await signIn('friend', friendPassword)).response.status, 401);
    assert.equal((await mutate('/api/admin/users/' + user.id, 'PATCH', { disabled: false })).status, 200);
    assert.equal((await call('/api/auth/session', { cookie: friend.cookie })).status, 401);
    friend = await signIn('friend', friendPassword);
    assert.equal(friend.response.status, 200);
  });

  await test('administrator password reset rejects old password and revokes sessions', async () => {
    assert.equal((await mutate('/api/admin/users/' + user.id + '/password', 'POST', { password: resetPassword })).status, 200);
    assert.equal((await call('/api/auth/session', { cookie: friend.cookie })).status, 401);
    assert.equal((await signIn('friend', friendPassword)).response.status, 401);
    friend = await signIn('friend', resetPassword);
    assert.equal(friend.response.status, 200);
  });

  await test('own password change requires current password and ends current sessions', async () => {
    assert.equal((await mutate('/api/auth/password', 'POST', { currentPassword: 'incorrect', newPassword: changedPassword }, friend)).status, 401);
    assert.equal((await mutate('/api/auth/password', 'POST', { currentPassword: resetPassword, newPassword: changedPassword }, friend)).status, 200);
    assert.equal((await call('/api/auth/session', { cookie: friend.cookie })).status, 401);
    friend = await signIn('friend', changedPassword);
    assert.equal(friend.response.status, 200);
  });

  await test('logout deletes persisted session and prevents replay', async () => {
    assert.equal((await mutate('/api/auth/logout', 'POST', undefined, friend, { csrf: undefined })).status, 403);
    assert.equal((await mutate('/api/auth/logout', 'POST', undefined, friend)).status, 200);
    assert.equal((await call('/app.js', { cookie: friend.cookie })).status, 401);
  });

  await test('real MVCC: reset waits for an in-flight locked login then revokes its inserted session', () => loginFirstRace('reset'));
  await test('real MVCC: disable waits for an in-flight locked login then revokes its inserted session', () => loginFirstRace('disable'));
  await test('real MVCC: login waits for an uncommitted password reset and rejects the old password', () => writerFirstRace('reset'));
  await test('real MVCC: login waits for an uncommitted disable and rejects the disabled account', () => writerFirstRace('disable'));

  await test('concurrent password attempts across pools obey persistent atomic account limit', async () => {
    await db.prepare('DELETE FROM nebo_auth_limits').run();
    const window = Math.floor(nowSeconds() / 900) * 900;
    await db.prepare('INSERT INTO nebo_auth_limits (bucket, window_start, attempts) VALUES (?, ?, ?)').bind('user:' + digest('owner'), window, 9).run();
    const secondEnv = environment(database());
    await ensureDatabase(secondEnv);
    const attempts = await Promise.all([
      signIn('owner', 'Wrong-concurrent-password!', { ip: '192.0.2.60' }),
      signIn('owner', 'Wrong-concurrent-password!', { ip: '192.0.2.61', targetEnv: secondEnv }),
    ]);
    assert.deepEqual(attempts.map(value => value.response.status).sort(), [401, 429]);
    assert.equal(Number((await db.prepare('SELECT attempts FROM nebo_auth_limits WHERE bucket = ?').bind('user:' + digest('owner')).first()).attempts), 11);
  });

  await test('bootstrap marker survives reconnect and does not resurrect deleted accounts', async () => {
    await db.prepare('DELETE FROM nebo_users').run();
    const freshEnv = environment(database());
    await ensureDatabase(freshEnv);
    assert.equal(Number((await freshEnv.DB.prepare('SELECT count(*) AS n FROM nebo_users').first()).n), 0);
  });

  await test('closed actual PostgreSQL pool fails closed for every private surface', async () => {
    const dead = database();
    await dead.close();
    for (const path of ['/', '/login', '/app.js', '/api/auth/session']) {
      assert.equal((await call(path, { cookie: owner.cookie, targetEnv: environment(dead) })).status, 503, path);
    }
  });
} catch {
  process.exitCode = 1;
} finally {
  await Promise.allSettled(adapters.map(adapter => adapter.close()));
  if (schemaCreated) {
    assert.match(schema, /^nebo_pg_test_[a-f0-9]{32}$/);
    await control.query('DROP SCHEMA "' + schema + '" CASCADE');
  }
  await control.end();
  const report = {
    testedAt: new Date().toISOString(),
    implementation: 'Actual application Worker/auth modules, node:crypto scrypt, pg TCP connection to PostgreSQL; isolated schema; no SQLite or mock database',
    postgresVersion,
    passed: checks.length === 22 && checks.every(check => check.passed),
    schemaCleanupCompleted: schemaCreated,
    durationSeconds: Number(((performance.now() - started) / 1000).toFixed(3)),
    checks,
  };
  await writeFile(new URL('./POSTGRES_BACKEND_REPORT.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
  if (!report.passed) process.exitCode = 1;
}
