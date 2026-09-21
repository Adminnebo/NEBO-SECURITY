import assert from 'node:assert/strict';
import http from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import pg from 'pg';
import { createServer } from '../server/index.js';
import { hashPassword, digest } from '../worker/auth.js';

assert.ok(process.env.TEST_DATABASE_URL, 'Explicit TEST_DATABASE_URL is required; no DATABASE_URL fallback.');
const base = new URL(process.env.TEST_DATABASE_URL);
assert.match(base.protocol, /^postgres(?:ql)?:$/);
assert.match(decodeURIComponent(base.pathname), /test/i, 'Database name must contain test.');
const schema = 'nebo_http_test_' + randomUUID().replaceAll('-', '');
const connection = new URL(base);
connection.searchParams.set('options', '-c search_path=' + schema + ',pg_catalog');
const control = new pg.Pool({ connectionString: base.href, max: 2, connectionTimeoutMillis: 5000 });
const password = 'Owner-HTTP-' + randomBytes(24).toString('base64url');
const passwordHash = await hashPassword(password);
const source = {
  DATABASE_URL: connection.href,
  NEBO_BOOTSTRAP_ADMIN_JSON: JSON.stringify({ username: 'owner', displayName: 'HTTP test owner', passwordHash }),
  APP_ORIGIN: 'http://127.0.0.1',
  NODE_ENV: 'development',
};
const checks = [];
const instances = [];
const started = performance.now();
let active, cookie, csrf, postgresVersion, schemaCreated = false;

async function test(name, task) {
  try { await task(); checks.push({ name, passed: true }); }
  catch (error) {
    checks.push({ name, passed: false, error: error.name, code: typeof error.code === 'string' ? error.code : undefined });
    throw error;
  }
}

async function start(overrides = {}) {
  const instance = await createServer({ env: { ...source, ...overrides }, logger: { error() {} } });
  instances.push(instance);
  await new Promise((resolve, reject) => {
    instance.server.once('error', reject);
    instance.server.listen(0, '127.0.0.1', resolve);
  });
  return instance;
}

function request(target, { method = 'GET', headers = {}, body, chunks, instance = active } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port: instance.server.address().port, path: target, method,
      headers: { Host: '127.0.0.1', ...headers }, agent: false,
    }, res => {
      const pieces = [];
      res.on('data', value => pieces.push(value));
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(pieces), text: Buffer.concat(pieces).toString('utf8') }));
    });
    req.setTimeout(15_000, () => req.destroy(new Error('HTTP test timeout')));
    req.on('error', reject);
    if (chunks) for (const chunk of chunks) req.write(chunk);
    req.end(body);
  });
}

const login = (overrides = {}) => request('/api/auth/login', {
  method: 'POST',
  headers: { Origin: source.APP_ORIGIN, 'Content-Type': 'application/json', ...(overrides.headers || {}) },
  body: JSON.stringify({ username: 'owner', password }),
  ...Object.fromEntries(Object.entries(overrides).filter(([key]) => key !== 'headers')),
});

try {
  await test('actual HTTP listener initializes real PostgreSQL in a unique test schema', async () => {
    postgresVersion = (await control.query('SELECT version() AS version')).rows[0].version;
    assert.match(postgresVersion, /^PostgreSQL /);
    assert.match(schema, /^nebo_http_test_[a-f0-9]{32}$/);
    await control.query('CREATE SCHEMA "' + schema + '"');
    schemaCreated = true;
    active = await start();
    const result = await request('/healthz');
    assert.equal(result.status, 200);
    assert.equal(result.text, 'ok');
  });

  await test('anonymous browser routes require login and direct private files reject access', async () => {
    for (const path of ['/', '/account', '/index.html', '/?modo=recibir']) assert.equal((await request(path)).status, 303, path);
    for (const path of ['/app.js', '/account.js', '/secure-worker.js', '/sw.js', '/manifest.webmanifest']) assert.equal((await request(path)).status, 401, path);
    const page = await request('/login');
    assert.equal(page.status, 200);
    assert.match(page.headers['cache-control'], /no-store/);
    assert.match(page.headers['content-security-policy'], /frame-ancestors 'none'/);
    assert.equal((await request('/login.js')).status, 200);
  });

  await test('canonical Host rejects host spoofing and ignores forwarded host by default', async () => {
    assert.equal((await request('/login', { headers: { Host: 'attacker.test' } })).status, 421);
    assert.equal((await request('/login', { headers: { Host: 'attacker.test', 'X-Forwarded-Host': '127.0.0.1' } })).status, 421);
    assert.equal((await request('/login', { headers: { 'X-Forwarded-Host': 'attacker.test', 'X-Forwarded-Proto': 'https' } })).status, 200);
  });

  await test('exact Origin enforcement survives forwarded host and protocol spoofing', async () => {
    assert.equal((await login({ headers: { Origin: 'https://attacker.test', 'X-Forwarded-Host': 'attacker.test', 'X-Forwarded-Proto': 'https' } })).status, 403);
    const result = await login();
    assert.equal(result.status, 200);
    const data = JSON.parse(result.text);
    csrf = data.csrfToken;
    cookie = result.headers['set-cookie'][0].split(';')[0];
    assert.ok(result.headers['set-cookie'][0].includes('HttpOnly'));
    assert.ok(result.headers['set-cookie'][0].includes('Secure'));
    assert.equal(data.user.role, 'admin');
  });

  await test('authenticated private application and HEAD replies preserve protection headers', async () => {
    const result = await request('/app.js', { headers: { Cookie: cookie } });
    assert.equal(result.status, 200);
    assert.match(result.headers['content-type'], /javascript/);
    assert.match(result.headers['cache-control'], /no-store/);
    assert.ok(result.body.length > 1000);
    const head = await request('/app.js', { method: 'HEAD', headers: { Cookie: cookie } });
    assert.equal(head.status, 200);
    assert.equal(head.body.length, 0);
    assert.equal((await request('/account', { headers: { Cookie: cookie } })).status, 200);
  });

  await test('raw, encoded and malformed traversal paths never expose files', async () => {
    for (const path of ['/assets/../.env', '/assets/%2e%2e/.env', '/assets/%2f..%2f.env', '/assets/%5c..%5c.env', '/assets/%00secret', '/assets/%zz', '/assets/C:secret', '//attacker.test/file']) {
      assert.equal((await request(path, { headers: { Cookie: cookie } })).status, 400, path);
    }
    for (const path of ['/server/index.js', '/worker/auth.js', '/.env', '/.git/config', '/assets/.env']) {
      assert.equal((await request(path, { headers: { Cookie: cookie } })).status, 404, path);
    }
  });

  await test('oversized declared and chunked requests receive bounded 413 responses', async () => {
    const headers = { Origin: source.APP_ORIGIN, 'Content-Type': 'application/json' };
    const declared = await request('/api/auth/login', { method: 'POST', headers: { ...headers, 'Content-Length': '20000' }, body: 'x'.repeat(20000) });
    assert.equal(declared.status, 413);
    const chunked = await request('/api/auth/login', { method: 'POST', headers, chunks: ['x'.repeat(9000), 'x'.repeat(9000)] });
    assert.equal(chunked.status, 413);
    assert.ok(declared.body.length < 1000 && chunked.body.length < 1000);
  });

  await test('default transport ignores client CF, X-Real-IP and XFF for rate limits', async () => {
    await active.application.database.prepare('DELETE FROM nebo_auth_limits').run();
    const result = await login({ headers: { 'CF-Connecting-IP': '198.51.100.8', 'X-Real-IP': '198.51.100.9', 'X-Forwarded-For': '198.51.100.10' } });
    assert.equal(result.status, 200);
    const rows = (await active.application.database.prepare("SELECT bucket FROM nebo_auth_limits WHERE bucket LIKE 'ip:%'").all()).results;
    assert.deepEqual(rows.map(row => row.bucket), ['ip:' + digest('127.0.0.1')]);
  });

  await test('application HTTP restart preserves the original login session in PostgreSQL', async () => {
    await active.close();
    active = await start();
    const result = await request('/api/auth/session', { headers: { Cookie: cookie } });
    assert.equal(result.status, 200);
    assert.equal(JSON.parse(result.text).user.username, 'owner');
    assert.equal((await request('/app.js', { headers: { Cookie: cookie } })).status, 200);
  });

  await test('trusted Railway mode uses a single validated X-Real-IP and ignores XFF', async () => {
    const proxy = await start({ TRUST_PROXY: 'railway' });
    await proxy.application.database.prepare('DELETE FROM nebo_auth_limits').run();
    const result = await login({ instance: proxy, headers: { 'CF-Connecting-IP': '198.51.100.8', 'X-Real-IP': '203.0.113.40', 'X-Forwarded-For': '198.51.100.10, 198.51.100.11' } });
    assert.equal(result.status, 200);
    const rows = (await proxy.application.database.prepare("SELECT bucket FROM nebo_auth_limits WHERE bucket LIKE 'ip:%'").all()).results;
    assert.deepEqual(rows.map(row => row.bucket), ['ip:' + digest('203.0.113.40')]);
    assert.equal((await request('/login', { instance: proxy, headers: { Host: 'rewritten.internal', 'X-Forwarded-Host': '127.0.0.1' } })).status, 200);
    assert.equal((await request('/login', { instance: proxy, headers: { Host: 'rewritten.internal', 'X-Forwarded-Host': 'attacker.test' } })).status, 421);
    await proxy.close();
  });

  await test('HTTP mutation requires session CSRF and logout prevents cookie replay', async () => {
    const bad = await request('/api/auth/logout', { method: 'POST', headers: { Cookie: cookie, Origin: source.APP_ORIGIN } });
    assert.equal(bad.status, 403);
    const good = await request('/api/auth/logout', { method: 'POST', headers: { Cookie: cookie, Origin: source.APP_ORIGIN, 'X-CSRF-Token': csrf } });
    assert.equal(good.status, 200);
    assert.equal((await request('/app.js', { headers: { Cookie: cookie } })).status, 401);
  });

  await test('real closed database pool makes readiness and authenticated requests fail closed', async () => {
    await active.application.database.close();
    assert.equal((await request('/healthz')).status, 503);
    for (const path of ['/app.js', '/api/auth/session', '/api/admin/users']) {
      const result = await request(path, { headers: { Cookie: cookie } });
      assert.equal(result.status, 503, path);
      assert.ok(result.body.length < 1000);
      assert.equal(result.text.includes(base.password), false);
    }
  });
} catch {
  process.exitCode = 1;
} finally {
  await Promise.allSettled(instances.map(instance => instance.close()));
  if (schemaCreated) {
    assert.match(schema, /^nebo_http_test_[a-f0-9]{32}$/);
    await control.query('DROP SCHEMA "' + schema + '" CASCADE');
  }
  await control.end();
  const report = {
    testedAt: new Date().toISOString(),
    implementation: 'Real Node HTTP listener and pg TCP PostgreSQL; application restart and HTTP boundary validation; isolated disposable schema',
    postgresVersion,
    passed: checks.length === 12 && checks.every(check => check.passed),
    schemaCleanupCompleted: schemaCreated,
    durationSeconds: Number(((performance.now() - started) / 1000).toFixed(3)),
    checks,
  };
  await writeFile(new URL('./POSTGRES_HTTP_REPORT.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
  if (!report.passed) process.exitCode = 1;
}
