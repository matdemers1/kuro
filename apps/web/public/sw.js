// Kurō's service worker (KURO-REQ-019): the app opens instantly and works read-only offline.
//  - The app shell and hashed assets: cache-first.
//  - Up Next, Library, Show and session reads: network-first, falling back to the last copy.
//  - Anything that changes data is never cached and never replayed.
const VERSION = 'kuro-v1';
const SHELL = ['/', '/manifest.webmanifest', '/icons/icon-192.png'];
const READS = [/^\/api\/up-next$/, /^\/api\/shows(\/[^/]+)?$/, /^\/api\/crunchyroll$/, /^\/api\/sync$/, /^\/auth\/session$/];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});

async function networkFirst(request, fallbackKey) {
  const cache = await caches.open(VERSION);
  try {
    const response = await fetch(request);
    if (response.ok) await cache.put(fallbackKey ?? request, response.clone());
    return response;
  } catch {
    const cached = await cache.match(fallbackKey ?? request);
    if (cached) return cached;
    throw new Error('offline and not cached');
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(VERSION);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) await cache.put(request, response.clone());
  return response;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (request.mode === 'navigate') {
    event.respondWith(networkFirst(request, '/'));
    return;
  }
  if (url.pathname.startsWith('/assets/') || url.pathname.startsWith('/icons/')) {
    event.respondWith(cacheFirst(request));
    return;
  }
  if (READS.some((re) => re.test(url.pathname))) event.respondWith(networkFirst(request));
});
