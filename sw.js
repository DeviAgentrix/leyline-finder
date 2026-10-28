// Offline support: keeps the app itself, map pieces, fonts and photos on the device.
const SHELL = 'lf-shell-v1';
const TILES = 'lf-tiles';
const FONTS = 'lf-fonts';
const PHOTOS = 'lf-photos';
const ASSETS = [
  './', 'index.html', 'app.css', 'manifest.webmanifest',
  'js/main.js', 'js/data.js', 'js/geo.js', 'js/famous.js', 'js/leys-worker.js',
  'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-180.png',
  'https://unpkg.com/maplibre-gl@5.8.0/dist/maplibre-gl.js',
  'https://unpkg.com/maplibre-gl@5.8.0/dist/maplibre-gl.css',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith('lf-shell-') && k !== SHELL).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

async function cacheFirst(cacheName, req) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok || res.type === 'opaque') cache.put(req, res.clone()).catch(() => {});
  return res;
}
async function networkFirst(cacheName, req) {
  const cache = await caches.open(cacheName);
  try {
    const res = await fetch(req);
    if (res.ok) cache.put(req, res.clone()).catch(() => {});
    return res;
  } catch (err) {
    const hit = await cache.match(req);
    if (hit) return hit;
    throw err;
  }
}
async function staleWhileRevalidate(cacheName, req, event) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req, { ignoreSearch: true });
  const net = fetch(req).then(res => { if (res.ok) cache.put(req, res.clone()).catch(() => {}); return res; });
  if (hit) { event.waitUntil(net.catch(() => {})); return hit; }
  return net;
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (url.origin === self.location.origin || url.hostname === 'unpkg.com') {
    if (req.mode === 'navigate') {
      event.respondWith(networkFirst(SHELL, req).catch(() => caches.match('index.html')));
      return;
    }
    event.respondWith(staleWhileRevalidate(SHELL, req, event));
    return;
  }
  if (url.hostname === 'tiles.openfreemap.org') {
    const isTile = /\/\d+\/\d+\/\d+(\.pbf)?$/.test(url.pathname) || url.pathname.includes('/fonts/') || url.pathname.includes('/sprites/');
    event.respondWith(isTile ? cacheFirst(TILES, req) : networkFirst(TILES, req));
    return;
  }
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    event.respondWith(cacheFirst(FONTS, req));
    return;
  }
  if (url.hostname === 'upload.wikimedia.org' || (url.hostname === 'commons.wikimedia.org' && url.pathname.includes('Special:FilePath'))) {
    event.respondWith(cacheFirst(PHOTOS, req));
  }
});
