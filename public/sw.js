const CACHE_NAME = 'dp-athlete-v50'; // v50: floating calendar day modal + styles.css?v=41
const APP_SHELL = [
  '/index.html', '/styles.css?v=41', '/config.js',
  '/js/01-core.js',
  '/js/02-login-goals.js',
  '/js/03-nav-nudges.js',
  '/js/04-checkin.js',
  '/js/05-handbook.js',
  '/js/06-nutrition.js',
  '/js/07-progress.js',
  '/js/08-training.js',
  '/js/09-logging.js',
  '/js/10-boot.js',
  '/login.js', '/icons.css?v=1',
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
