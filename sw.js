const CACHE_NAME = 'onelist-2026-07-11 12:54';
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
      // 'reload' bypasses the browser HTTP cache so a new deploy's shell is cached
      // fresh (not a stale copy the browser held), keeping version updates to ~1-2
      // refreshes. CDN files are immutable, so they stay default.
      cache.addAll(SHELL_FILES.map(u => new Request(u, { cache: 'reload' })))
        .then(() => cache.addAll(CDN_FILES).catch(() => {}))
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
          if (resp.ok) {
            const clone = resp.clone();
            caches.open(CACHE_NAME).then(c => c.put(e.request, clone));
          }
          return resp;
        });
      }).catch(() => caches.match(e.request))
    );
    return;
  }
  // Navigations — even with a query string (?bootdebug, share target) — must serve
  // the cached app shell matched by PATHNAME, or the query misses the cache and
  // index.html is re-downloaded over the network (slow on weak connections).
  const url = new URL(e.request.url);
  const isNav = e.request.mode === 'navigate';
  // Same-origin guard: never serve a cross-origin request from our cache just
  // because its pathname happens to equal a shell entry.
  const isShellAsset = url.origin === self.location.origin && SHELL_FILES.includes(url.pathname);
  if (!isNav && !isShellAsset) return;
  const cacheKey = isNav ? new URL('/', self.location).href
                         : new URL(url.pathname, self.location).href;
  e.respondWith(
    caches.match(cacheKey).then(cached => {
      // Revalidate with 'no-cache' so the background refresh reaches the server and
      // picks up new deploys (a bare-URL default fetch could return the browser's
      // stale HTTP-cached shell, making version updates take many refreshes).
      const net = fetch(new Request(cacheKey, { cache: 'no-cache' })).then(resp => {
        if (resp.ok) {
          const clone = resp.clone();
          caches.open(CACHE_NAME).then(c => c.put(cacheKey, clone));
        }
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
