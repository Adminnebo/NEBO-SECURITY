import http from 'node:http';
import { isIP } from 'node:net';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import worker from '../worker/index.js';
import { ensureDatabase } from '../worker/auth.js';
import { createPostgresDatabase } from './postgres.js';
import { createAssetBinding } from './assets.js';

const BODY_LIMIT = 16 * 1024;
const DEFAULT_ASSETS = fileURLToPath(new URL('../public/', import.meta.url));
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export function loadConfiguration(source = process.env) {
  if (typeof source.DATABASE_URL !== 'string' || !source.DATABASE_URL.trim()) throw new Error('DATABASE_URL is required');
  if (typeof source.NEBO_BOOTSTRAP_ADMIN_JSON !== 'string' || !source.NEBO_BOOTSTRAP_ADMIN_JSON.trim()) throw new Error('NEBO_BOOTSTRAP_ADMIN_JSON is required');
  const configured = source.APP_ORIGIN || (source.RAILWAY_PUBLIC_DOMAIN ? 'https://' + source.RAILWAY_PUBLIC_DOMAIN : '');
  let origin;
  try { origin = new URL(configured); } catch { throw new Error('APP_ORIGIN must be a valid origin'); }
  const development = source.NODE_ENV === 'development';
  if (origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash ||
      (origin.protocol !== 'https:' && !(development && origin.protocol === 'http:' && LOCAL_HOSTS.has(origin.hostname)))) {
    throw new Error('APP_ORIGIN must use HTTPS; local HTTP requires NODE_ENV=development');
  }
  if (source.RAILWAY_PUBLIC_DOMAIN && !source.APP_ORIGIN && origin.host !== source.RAILWAY_PUBLIC_DOMAIN) throw new Error('Invalid RAILWAY_PUBLIC_DOMAIN');
  const port = source.PORT === undefined || source.PORT === '' ? 3000 : Number(source.PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be between 1 and 65535');
  const trustProxy = source.TRUST_PROXY || 'none';
  if (!['none', 'railway'].includes(trustProxy)) throw new Error('TRUST_PROXY must be none or railway');
  return Object.freeze({ origin: origin.origin, host: origin.host, port, trustProxy });
}

class RequestError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function errorResponse(status, message) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store, private, max-age=0',
      'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Strict-Transport-Security': 'max-age=31536000',
    },
  });
}

function requestUrl(request, configuration) {
  const target = request.url || '/';
  // Reject absolute-form URLs and ambiguous separators before WHATWG URL can
  // normalize them. The configured origin is never derived from request headers.
  if (!target.startsWith('/') || target.startsWith('//') || /[\\\u0000-\u0020\u007f#]/.test(target)) throw new RequestError(400, 'Invalid request target');
  const rawPath = target.split('?', 1)[0];
  let decoded;
  try { decoded = decodeURIComponent(rawPath); } catch { throw new RequestError(400, 'Invalid request path'); }
  if (/[\\:\u0000-\u001f\u007f]/.test(decoded) || /%2f|%5c/i.test(rawPath) || decoded.split('/').some(part => part === '.' || part === '..')) throw new RequestError(400, 'Invalid request path');
  const url = new URL(configuration.origin + target);
  const host = request.headers.host?.toLowerCase();
  const forwardedHost = configuration.trustProxy === 'railway' && typeof request.headers['x-forwarded-host'] === 'string'
    ? request.headers['x-forwarded-host'].toLowerCase() : null;
  const allowedHost = candidate => candidate === configuration.host.toLowerCase() || (url.pathname === '/healthz' && candidate === 'healthcheck.railway.app');
  if (!allowedHost(host) && !allowedHost(forwardedHost)) throw new RequestError(421, 'Unrecognized request host');
  return url;
}

function clientAddress(request, configuration) {
  const peer = request.socket.remoteAddress || 'unknown';
  if (configuration.trustProxy !== 'railway') return peer;
  // Opt in only when this listener is reachable through the trusted Railway
  // edge. Railway documents X-Real-IP as the remote client address; it does not
  // promise an X-Forwarded-For append policy. Never trust XFF lists here.
  const forwarded = request.headers['x-real-ip'];
  if (typeof forwarded !== 'string') return peer;
  const candidate = forwarded.trim();
  return isIP(candidate) ? candidate : peer;
}

function requestHeaders(request, configuration) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined || ['host', 'cf-connecting-ip', 'x-real-ip', 'forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'connection', 'transfer-encoding'].includes(name)) continue;
    if (Array.isArray(value)) for (const item of value) headers.append(name, item);
    else headers.set(name, value);
  }
  // The shared Worker consumes this header for rate limits. Caller input is
  // replaced with the transport-derived address, including in default mode.
  headers.set('cf-connecting-ip', clientAddress(request, configuration));
  return headers;
}

async function readBody(request) {
  const length = request.headers['content-length'];
  if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > BODY_LIMIT)) throw new RequestError(413, 'Request body exceeds 16 KiB');
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    const cleanup = () => {
      request.off('data', onData);
      request.off('end', onEnd);
      request.off('error', onError);
      request.off('aborted', onAborted);
    };
    const onError = () => { cleanup(); reject(new RequestError(400, 'Incomplete request body')); };
    const onAborted = () => onError();
    const onEnd = () => { cleanup(); resolve(Buffer.concat(chunks, total)); };
    const onData = chunk => {
      total += chunk.length;
      if (total > BODY_LIMIT) {
        cleanup();
        request.pause();
        reject(new RequestError(413, 'Request body exceeds 16 KiB'));
      } else chunks.push(chunk);
    };
    request.on('data', onData);
    request.once('end', onEnd);
    request.once('error', onError);
    request.once('aborted', onAborted);
  });
}

async function sendResponse(request, outgoing, response) {
  outgoing.statusCode = response.status;
  for (const [name, value] of response.headers) {
    if (name !== 'set-cookie') outgoing.setHeader(name, value);
  }
  const cookies = response.headers.getSetCookie();
  if (cookies.length) outgoing.setHeader('Set-Cookie', cookies);
  if (request.method === 'HEAD' || !response.body) {
    if (response.body) await response.body.cancel();
    outgoing.end();
    return;
  }
  await pipeline(Readable.fromWeb(response.body), outgoing);
}

export async function createApplication({ env: source = process.env, database, assetsRoot = DEFAULT_ASSETS, logger = console } = {}) {
  const configuration = loadConfiguration(source);
  let db = database;
  let closed = false;
  let env;
  try {
    db ||= createPostgresDatabase(source.DATABASE_URL);
    env = {
      DB: db,
      NEBO_BOOTSTRAP_ADMIN_JSON: source.NEBO_BOOTSTRAP_ADMIN_JSON,
      ASSETS: await createAssetBinding(assetsRoot),
    };
    await ensureDatabase(env);
  } catch {
    if (db) await Promise.resolve().then(() => db.close()).catch(() => {});
    throw new Error('Application initialization failed; check database and bootstrap configuration');
  }
  async function handler(request, response) {
    try {
      if (closed) throw new RequestError(503, 'Service unavailable');
      const url = requestUrl(request, configuration);
      if (url.pathname === '/healthz') {
        if (!['GET', 'HEAD'].includes(request.method)) return await sendResponse(request, response, new Response(null, { status: 405, headers: { Allow: 'GET, HEAD', 'Cache-Control': 'no-store' } }));
        // Startup already initialized the schema. Probes only query readiness.
        await db.prepare('SELECT 1 AS ready').first();
        return await sendResponse(request, response, new Response('ok', { headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } }));
      }
      const body = await readBody(request);
      if (['GET', 'HEAD'].includes(request.method) && body.length) throw new RequestError(400, 'This method does not accept a request body');
      const adapted = new Request(url, {
        method: request.method,
        headers: requestHeaders(request, configuration),
        ...(!['GET', 'HEAD'].includes(request.method) && body.length ? { body } : {}),
      });
      await sendResponse(request, response, await worker.fetch(adapted, env));
    } catch (error) {
      if (response.headersSent || response.destroyed) { response.destroy(); return; }
      const status = error instanceof RequestError ? error.status : 503;
      if (!(error instanceof RequestError)) logger.error('Request failed: service unavailable.');
      // Close rejected requests without draining an unbounded attacker body.
      response.setHeader('Connection', 'close');
      response.once('finish', () => request.destroy());
      try { await sendResponse(request, response, errorResponse(status, error instanceof RequestError ? error.message : 'Service unavailable')); }
      catch { response.destroy(); }
    }
  }
  async function close() {
    if (closed) return;
    closed = true;
    await db.close();
  }
  return { handler, close, database: db, env, configuration };
}

export async function createServer(options = {}) {
  const application = await createApplication(options);
  const server = http.createServer({ requestTimeout: 30_000, headersTimeout: 10_000, maxHeaderSize: 16 * 1024 }, application.handler);
  server.keepAliveTimeout = 5_000;
  let closing;
  function close() {
    if (!closing) closing = (async () => {
      if (server.listening) {
        const deadline = setTimeout(() => server.closeAllConnections(), 10_000);
        deadline.unref();
        try { await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
        finally { clearTimeout(deadline); }
      }
      await application.close();
    })();
    return closing;
  }
  return { server, close, application };
}

async function main() {
  let instance;
  try {
    instance = await createServer();
    await new Promise((resolve, reject) => {
      instance.server.once('error', reject);
      instance.server.listen(instance.application.configuration.port, '0.0.0.0', resolve);
    });
    console.log('NEBO HTTP service is ready.');
    const shutdown = async () => {
      try { await instance.close(); } catch { console.error('Service shutdown failed.'); process.exitCode = 1; }
    };
    process.once('SIGTERM', shutdown);
    process.once('SIGINT', shutdown);
  } catch {
    console.error('Service startup failed: check runtime configuration and database availability.');
    if (instance) await instance.close().catch(() => {});
    process.exitCode = 1;
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) await main();
