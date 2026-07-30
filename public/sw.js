const CACHE_NAME = 'dp-athlete-v90'; // v90: theme-matched rest timer for indoor and outdoor modes
const APP_SHELL = [
  '/index.html', '/styles.css?v=88', '/desktop.css?v=3', '/config.js',
  '/js/01-core.js?v=86',
  '/js/02-login-goals.js?v=84',
  '/js/03-nav-nudges.js?v=85',
  '/js/04-checkin.js?v=84',
  '/js/05-handbook.js?v=80',
  '/js/06-nutrition.js?v=83',
  '/js/07-progress.js?v=85',
  '/js/08-training.js?v=89',
  '/js/09-logging.js?v=88',
  '/accessibility.js?v=1',
  '/js/10-boot.js?v=86',
  '/login.js?v=47', '/icons.css?v=3',
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

  // App shell (page navigations + HTML/CSS/JS): NETWORK-FIRST.
  // Always fetch fresh when online so a new deploy shows immediately; fall
  // back to cache only when offline. This is what stops the portal from
  // getting stuck on a stale styles.css after a deploy.
  const isShell = request.mode === 'navigate' ||
    url.pathname === '/' ||
    /\.(?:html|css|js)$/.test(url.pathname);

  if (isShell) {
    const cacheKey = request.mode === 'navigate' ? '/index.html' : request;
    event.respondWith(
      fetch(request).then(response => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(cacheKey, copy));
        }
        return response;
      }).catch(() => caches.match(cacheKey))
    );
    return;
  }

  // Everything else (images, fonts, icons): cache-first — they're versioned
  // or immutable, so serving from cache is fine and fast.
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
