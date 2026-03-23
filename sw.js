const CACHE_NAME = 'onelist-2026-03-23 11:50';
const SHELL_FILES = ['/', '/index.html', '/manifest.json', '/icon-192.png', '/icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(SHELL_FILES))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  // Cache-first for versioned CDN assets (Firebase SDK, DOMPurify, marked)
  if (e.request.url.includes('gstatic.com/firebasejs') || e.request.url.includes('cdn.jsdelivr.net/npm/')) {
    e.respondWith(
      caches.match(e.request).then(r => r || fetch(e.request).then(resp => {
        const clone = resp.clone();
        caches.open(CACHE_NAME).then(c => c.put(e.request, clone));
        return resp;
      }))
    );
    return;
  }
  // Network-first for app shell only (fall back to cache when offline)
  const shellUrls = SHELL_FILES.map(f => new URL(f, self.location).href);
  if (!shellUrls.includes(e.request.url)) return;
  e.respondWith(
    fetch(e.request).then(resp => {
      const clone = resp.clone();
      caches.open(CACHE_NAME).then(c => c.put(e.request, clone));
      return resp;
    }).catch(() => caches.match(e.request))
  );
});
