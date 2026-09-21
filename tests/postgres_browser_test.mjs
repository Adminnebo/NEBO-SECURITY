import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { createServer } from '../server/index.js';
import { hashPassword } from '../worker/auth.js';

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString) throw new Error('Set TEST_DATABASE_URL to a disposable PostgreSQL test database.');
const root = fileURLToPath(new URL('../', import.meta.url));
const schema = 'nebo_browser_' + randomBytes(10).toString('hex');
const pool = new Pool({ connectionString, max: 2, connectionTimeoutMillis: 10_000 });
pool.on('error', () => console.error('Browser test database connection failed.'));
const username = 'browser_owner';
const password = randomBytes(24).toString('base64url');
let application;
let created = false;
const started = Date.now();
const suites = [];

async function freePort() {
  const reservation = net.createServer();
  await new Promise((resolve, reject) => { reservation.once('error', reject); reservation.listen(0, '127.0.0.1', resolve); });
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  return port;
}

async function runBrowser(script, reportName, base) {
  const reportUrl = new URL(reportName, import.meta.url);
  const childEnv = { ...process.env, NEBO_TEST_LOGIN_USER: username, NEBO_TEST_LOGIN_PASSWORD: password };
  delete childEnv.NEBO_SITES_AUDIT_TOKEN;
  delete childEnv.TEST_DATABASE_URL;
  const code = await new Promise((resolve, reject) => {
    const child = spawn(process.env.PYTHON || 'python', [script, '--base-url', base, '--report', fileURLToPath(reportUrl)], {
      cwd: root, env: childEnv, windowsHide: true, stdio: ['ignore', 'inherit', 'inherit'],
    });
    const deadline = setTimeout(() => child.kill(), 240_000);
    child.on('error', reject);
    child.on('close', result => { clearTimeout(deadline); resolve(result); });
  });
  assert.equal(code, 0, script + ' failed');
  const report = JSON.parse(await readFile(reportUrl, 'utf8'));
  await writeFile(reportUrl, JSON.stringify(report, null, 2) + '\n');
  assert.equal(report.passed, true, script + ' report failed');
  suites.push({ script, report: reportName, passed: true, checks: report.checks.length });
}

try {
  await pool.query(`CREATE SCHEMA "${schema}"`);
  created = true;
  const database = new URL(connectionString);
  database.searchParams.set('options', '-c search_path=' + schema);
  const port = await freePort();
  const base = `http://localhost:${port}`;
  application = await createServer({ env: {
    DATABASE_URL: database.href,
    NEBO_BOOTSTRAP_ADMIN_JSON: JSON.stringify({ username, displayName: 'Browser test owner', passwordHash: await hashPassword(password) }),
    NODE_ENV: 'development', APP_ORIGIN: base, PORT: String(port), TRUST_PROXY: 'none',
  } });
  await new Promise((resolve, reject) => { application.server.once('error', reject); application.server.listen(port, '127.0.0.1', resolve); });
  for (const [script, reportName] of [
    ['tests/native_auth_browser_test.py', 'POSTGRES_BROWSER_AUTH_REPORT.json'],
    ['tests/v8_userflow_test.py', 'POSTGRES_BROWSER_PNG_REPORT.json'],
    ['tests/native_account_scope_test.py', 'POSTGRES_BROWSER_SCOPE_REPORT.json'],
  ]) {
    // Independent synthetic suites should not consume each other's login quotas.
    await pool.query(`DELETE FROM "${schema}".nebo_auth_limits`);
    await runBrowser(script, reportName, base);
  }
  const version = (await pool.query('SHOW server_version')).rows[0].server_version;
  const report = {
    testedAt: new Date().toISOString(), passed: true, database: 'PostgreSQL', databaseVersion: version,
    browser: 'Microsoft Edge / Playwright', runtime: process.version,
    implementation: 'Real Node HTTP server, PostgreSQL over TCP, real browser login and portable PNG reconstruction in a separate browser context',
    productionDeploymentTested: false, credentialsRecorded: false,
    durationSeconds: (Date.now() - started) / 1000, suites,
  };
  await writeFile(new URL('./POSTGRES_BROWSER_REPORT.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ passed: true, suites: suites.length, checks: suites.reduce((sum, item) => sum + item.checks, 0) }));
} catch {
  await writeFile(new URL('./POSTGRES_BROWSER_REPORT.json', import.meta.url), JSON.stringify({
    testedAt: new Date().toISOString(), passed: false, database: 'PostgreSQL',
    productionDeploymentTested: false, credentialsRecorded: false, suites,
    error: 'Browser verification failed; inspect the failed suite report.',
  }, null, 2) + '\n');
  throw new Error('PostgreSQL browser verification failed; see POSTGRES_BROWSER_REPORT.json.');
} finally {
  try { if (application) await application.close(); }
  finally {
    try { if (created) await pool.query(`DROP SCHEMA "${schema}" CASCADE`); }
    finally { await pool.end(); }
  }
}
