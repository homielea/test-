// Service worker — offline cache for the Mariñeiro Pescador study app.
// Bump CACHE version whenever assets change to force an update.
const CACHE = 'marinheiro-v1';
const ASSETS = [
  './',
  './index.html',
  './css/style.css',
  './js/app.js',
  './data/questions.json',
  './data/knots.json',
  './manifest.webmanifest',
  './assets/icons/icon-192.png',
  './assets/icons/icon-512.png',
  './assets/knots/as_de_guia.png',
  './assets/knots/as_de_guia_dobre.png',
  './assets/knots/ballestrinque.png',
  './assets/knots/ballestrinque_dobre.png',
  './assets/knots/chairo_llano.png',
  './assets/knots/dobre_lasca.png',
  './assets/knots/malla_cote.png',
  './assets/knots/margarita.png',
  './assets/knots/pescador.png',
  './assets/knots/tecedor.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Cache-first: works fully offline once installed.
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    caches.match(e.request).then((hit) =>
      hit || fetch(e.request).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
        return res;
      }).catch(() => caches.match('./index.html'))
    )
  );
});
