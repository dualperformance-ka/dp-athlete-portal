const CACHE_NAME = 'dp-athlete-v25';
const APP_SHELL = [
  '/index.html', '/styles.css?v=17', '/config.js',
  '/app.js', '/login.js', '/icons.css?v=1',
  '/dual_performance_one_line_filled_logo_black_preview.png',
  '/dp_baby_blue_transparent_512x512.png'
];

self.addEventListener('install', event => {
  // Cache files individually: one missing file must never block the install
  // (cache.addAll is all-or-nothing and a single 404 bricks the service worker).
  event.waitUntil(caches.open(CACHE_NAME).then(cache =>
    Promise.allSettled(APP_SHELL.map(url => cache.add(url)))
  ));
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

// ── PUSH REMINDERS ───────────────────────────────────────────────────────────
self.addEventListener('push', event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) {}
  const title = data.title || 'Dual Performance';
  event.waitUntil(self.registration.showNotification(title, {
    body: data.body || '',
    icon: '/dp_baby_blue_transparent_512x512.png',
    badge: '/dp_baby_blue_transparent_512x512.png',
    tag: data.tag || 'dp-reminder',
    data: { url: data.url || '/' }
  }));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const client of list) {
      if ('focus' in client) { client.navigate(url); return client.focus(); }
    }
    return clients.openWindow(url);
  }));
});
