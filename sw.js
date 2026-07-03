const CACHE_NAME = 'ps-house-cache-v3';
const URLS_TO_CACHE = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.json'
];

// Install: cache the core app files
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(URLS_TO_CACHE);
    })
  );
  self.skipWaiting();
});

// Activate: clean up old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.filter((key) => key !== CACHE_NAME)
            .map((key) => caches.delete(key))
      );
    })
  );
  self.clients.claim();
});

// Fetch: serve from cache first for the app shell.
// For Google Apps Script sync calls (different origin), always go to network.
self.addEventListener('fetch', (event) => {
  const url = event.request.url;

  // Never intercept calls to script.google.com (sync/PIN check) — always real network
  if (url.includes('script.google.com')) {
    return; // let browser handle it normally
  }

  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      if (cachedResponse) {
        // Serve cached version immediately, refresh cache in background
        fetch(event.request).then((networkResponse) => {
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, networkResponse.clone());
          });
        }).catch(() => {});
        return cachedResponse;
      }
      // Not cached yet — fetch from network and cache it
      return fetch(event.request).then((networkResponse) => {
        return caches.open(CACHE_NAME).then((cache) => {
          cache.put(event.request, networkResponse.clone());
          return networkResponse;
        });
      }).catch(() => {
        // Offline and not cached — nothing we can do for this resource
        return new Response('Offline and resource not cached.', {
          status: 503,
          statusText: 'Offline'
        });
      });
    })
  );
});
