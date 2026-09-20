'use strict';

// Change this version whenever any precached application code changes.
const CACHE_NAME = 'nebo-app-v8';
const OWNED_CACHE = /^nebo-app-v\d+$/;
const ROOT = new URL('./', self.location.href);
const INDEX = new URL('index.html', ROOT).href;
const STATIC_FILES = [
  'index.html', 'app.js?v=8', 'theme.js?v=8', 'styles.css?v=8',
  'codec-worker.js', 'secure-worker.js', 'portable-png.js', 'identity-store.js',
  'bundle.js', 'contact-store.js', 'install.js', 'cover-planner.js', 'manifest.webmanifest',
  'assets/nebo-logo-original.png', 'assets/nebo-symbol.svg',
  'assets/mountain.png', 'assets/coast.png', 'assets/aurora.png', 'assets/nebula.png',
  'assets/documento-ejemplo.pdf',
];
const ALLOWED = new Set(STATIC_FILES.map(path => new URL(path, ROOT).href));

self.addEventListener('install', event => {
  // addAll uses one atomic cache batch: a failed essential fetch aborts installation.
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll([...ALLOWED].map(url => new Request(url, { cache: 'reload', credentials: 'same-origin' })));
  })());
  // Deliberately no skipWaiting: never replace the worker under an active conversion.
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) {
      if (name !== CACHE_NAME && OWNED_CACHE.test(name)) await caches.delete(name);
    }
  })());
  // Deliberately no clients.claim: existing pages keep their current application version.
});

function isAppNavigation(url) {
  const correctPath = url.pathname === ROOT.pathname || url.pathname === new URL('index.html', ROOT).pathname;
  return correctPath && (url.search === '' || url.search === '?modo=recibir');
}

async function navigation(request) {
  const cache = await caches.open(CACHE_NAME);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3500);
  try {
    const response = await fetch(request, { signal: controller.signal });
    if (!response.ok || response.type === 'opaque') throw new Error('Navigation unavailable');
    // Keep the offline document coherent with this version's cached scripts.
    const html = await response.clone().text();
    if (['app.js?v=8', 'theme.js?v=8', 'styles.css?v=8'].every(path => html.includes(path))) {
      await cache.put(INDEX, response.clone());
    }
    return response;
  } catch {
    return await cache.match(INDEX) || new Response('NEBO no está guardado para abrirse sin conexión. Vuelve a conectarte y recarga la página.',
      { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  } finally { clearTimeout(timer); }
}

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== ROOT.origin || !['http:', 'https:'].includes(url.protocol)) return;
  if (request.mode === 'navigate' && isAppNavigation(url)) {
    event.respondWith(navigation(request)); return;
  }
  if (!ALLOWED.has(url.href)) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(url.href);
    if (cached) return cached;
    // Only exact static URLs can enter this cache. No user files, tokens, or keys.
    const response = await fetch(request);
    if (response.ok && response.type !== 'opaque') await cache.put(url.href, response.clone());
    return response;
  })());
});
