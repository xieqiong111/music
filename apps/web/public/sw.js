const CACHE_PREFIX = 'playlist-exporter-static-';
const CACHE_NAME = CACHE_PREFIX + 'v1';

const isStaticRequest = request => {
  if (request.method !== 'GET') return false;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return false;
  if (url.pathname.startsWith('/api/') || url.pathname === '/healthz') return false;
  if (request.headers.has('authorization') || request.headers.has('cookie')) return false;
  return url.pathname === '/' ||
    url.pathname === '/index.html' ||
    url.pathname === '/manifest.webmanifest' ||
    url.pathname === '/sw.js' ||
    url.pathname.startsWith('/assets/') ||
    url.pathname.startsWith('/icons/');
};

self.addEventListener('install', event => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names
      .filter(name => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME)
      .map(name => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  if (!isStaticRequest(event.request)) return;
  event.respondWith((async () => {
    const cached = await caches.match(event.request);
    if (cached !== undefined) return cached;
    const response = await fetch(event.request);
    if (response.ok && response.type === 'basic') {
      const cache = await caches.open(CACHE_NAME);
      await cache.put(event.request, response.clone());
    }
    return response;
  })());
});
