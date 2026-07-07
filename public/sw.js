const CACHE_NAME = 'dp-athlete-v15';
const APP_SHELL = [
  '/index.html', '/styles.css?v=15', '/config.js',
  '/dp_logo_inline.png',
  '/dual_performance_one_line_filled_logo_black_preview.png',
  '/dp_baby_blue_transparent_512x512.png'
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(APP_SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key)))));
  self.clients.claim();
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;

  // Navigations: stale-while-revalidate — serve the cached shell instantly and
  // refresh it in the background. New deploys land on the next visit
  // (bump CACHE_NAME + ?v= when shipping changes).
  if (request.mode === 'navigate') {
    event.respondWith(caches.match('/index.html').then(cached => {
      const network = fetch(request).then(response => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put('/index.html', copy));
        }
        return response;
      }).catch(() => cached);
      return cached || network;
    }));
    return;
  }

  event.respondWith(caches.match(request).then(cached => cached || fetch(request).then(response => {
    if (response.ok) caches.open(CACHE_NAME).then(cache => cache.put(request, response.clone()));
    return response;
  })));
});
