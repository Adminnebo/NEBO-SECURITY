'use strict';

// Private application v10: every request must reach the hosting access gate.
// This worker intentionally creates no cache and has no offline app fallback.
const PRIVATE_VERSION = 10;
const OWNED_CACHE = /^nebo-app-v\d+$/;
const ROOT = new URL('./', self.location.href);

self.addEventListener('install', event => {
  // Unlike the former offline worker, migrate access policy immediately.
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) {
      if (OWNED_CACHE.test(name)) await caches.delete(name);
    }
    // Claim changes the transport of existing tabs on their next request.
    // It does not erase an old page's already-loaded JavaScript.
    await self.clients.claim();
    for (const client of await self.clients.matchAll({ type: 'window' })) {
      client.postMessage({ type: 'NEBO_PRIVATE_MODE', version: PRIVATE_VERSION });
    }
  })());
});

function unavailable(navigation) {
  const body = navigation
    ? '<!doctype html><html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>NEBO · Conexión necesaria</title><h1>Conéctate para abrir NEBO</h1><p>Necesitas internet para comprobar tu acceso a la aplicación privada.</p><p>Vuelve a conectarte y recarga esta página.</p></html>'
    : 'Conexión necesaria para acceder a NEBO.';
  return new Response(body, { status: 503, headers: {
    'Content-Type': navigation ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  } });
}

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== ROOT.origin || !['http:', 'https:'].includes(url.protocol)) return;
  event.respondWith((async () => {
    try {
      // Preserve redirect mode so navigation redirects can reach the browser.
      // Return denials and server errors unchanged; never substitute app HTML.
      return await fetch(request, { cache: 'no-store' });
    } catch {
      return unavailable(request.mode === 'navigate');
    }
  })());
});
