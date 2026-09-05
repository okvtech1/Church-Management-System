/* OKV CMS Online — Service Worker
   Caches the app shell (HTML/CSS/JS/icons) so the app opens instantly and
   the UI itself works offline. Actual data comes from Google Sheets via
   Apps Script when online, and from IndexedDB (synced earlier) when not —
   see common.js for the sync engine. Bump CACHE_NAME to force an update. */

const CACHE_NAME = 'okv-cms-online-shell-v4';

const APP_SHELL = [
  './',
  './index.html',
  './app.html',
  './signup.html',
  './reset-password.html',
  './install.html',
  './pricing.html',
  './demo.html',
  './privacy-policy.html',
  './terms-of-service.html',
  './refund-policy.html',
  './manifest.json',
  './common.js',
  './common.css',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-192.png',
  './icons/icon-maskable-512.png',
];

const CDN_ASSETS = [
  'https://cdnjs.cloudflare.com/ajax/libs/twitter-bootstrap/5.3.2/css/bootstrap.min.css',
  'https://cdnjs.cloudflare.com/ajax/libs/bootstrap-icons/1.11.1/font/bootstrap-icons.min.css',
  'https://cdnjs.cloudflare.com/ajax/libs/twitter-bootstrap/5.3.2/js/bootstrap.bundle.min.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      cache.addAll(APP_SHELL).then(() =>
        Promise.all(CDN_ASSETS.map((url) => cache.add(new Request(url, {mode:'cors'})).catch(() => {})))
      )
    )
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  // Never cache API calls to Apps Script — those must always hit the network
  // (or fail, so the app can fall back to IndexedDB) rather than serve stale data.
  if (event.request.url.includes('script.google.com')) return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      const networkFetch = fetch(event.request)
        .then((response) => {
          if (response && response.status === 200) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
          }
          return response;
        })
        .catch(() => cached);
      return cached || networkFetch;
    })
  );
});
