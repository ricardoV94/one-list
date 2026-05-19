const CACHE_NAME = 'onelist-2026-05-19 12:06';
const SHELL_FILES = ['/', '/index.html', '/manifest.json', '/icon-192.png', '/icon-512.png'];
const CDN_FILES = [
  'https://www.gstatic.com/firebasejs/12.11.0/firebase-app.js',
  'https://www.gstatic.com/firebasejs/12.11.0/firebase-auth.js',
  'https://www.gstatic.com/firebasejs/12.11.0/firebase-firestore.js',
  'https://cdn.jsdelivr.net/npm/dompurify@3.2.5/dist/purify.min.js',
  'https://cdn.jsdelivr.net/npm/marked@15.0.7/marked.min.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(cache =>
      cache.addAll(SHELL_FILES).then(() => cache.addAll(CDN_FILES).catch(() => {}))
    )
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
  if (e.request.url.includes('gstatic.com/firebasejs') || e.request.url.includes('cdn.jsdelivr.net/npm/')) {
    e.respondWith(
      caches.match(e.request).then(r => {
        if (r) return r;
        return fetch(e.request).then(resp => {
          const clone = resp.clone();
          caches.open(CACHE_NAME).then(c => c.put(e.request, clone));
          return resp;
        });
      }).catch(() => caches.match(e.request))
    );
    return;
  }
  const shellUrls = SHELL_FILES.map(f => new URL(f, self.location).href);
  if (!shellUrls.includes(e.request.url)) return;
  e.respondWith(
    caches.match(e.request).then(cached => {
      const net = fetch(e.request).then(resp => {
        const clone = resp.clone();
        caches.open(CACHE_NAME).then(c => c.put(e.request, clone));
        return resp;
      });
      if (cached) {
        net.catch(() => {});
        return cached;
      }
      return net;
    })
  );
});
