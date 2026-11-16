// KneeAngle - Service Worker: App-Dateien zwischenspeichern, damit die App ohne Internet startet.
// Bei einer neuen App-Version CACHE hochzaehlen.
const CACHE = 'kneeangle-v2.2.0';
const FILES = ['./', 'index.html', 'style.css', 'protocol.js', 'device.js', 'app.js', 'manifest.webmanifest',
  'icons/icon-192.png', 'icons/icon-512.png',
  'fonts/barlow-latin-400-normal.woff2', 'fonts/barlow-latin-600-normal.woff2', 'fonts/barlow-condensed-latin-600-normal.woff2'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then((hit) => hit || fetch(e.request)));
});
