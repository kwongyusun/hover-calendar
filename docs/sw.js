// Keeps the app working offline: serve saved files straight away, refresh them in the background.
const CACHE = 'hover-calendar-1793603432';
const FILES = ['./', 'index.html', 'styles.css', 'mobile.css', 'config.js', 'themes.js', 'recur.js', 'sync.js', 'cloud.js', 'host.js', 'app.js', 'manifest.webmanifest', 'icon-180.png', 'icon-192.png'];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return; // never cache calendar data
  e.respondWith(caches.open(CACHE).then(async (c) => {
    const hit = await c.match(e.request, { ignoreSearch: true });
    const fresh = fetch(e.request).then((res) => { if (res.ok) c.put(e.request, res.clone()); return res; }).catch(() => hit);
    return hit || fresh;
  }));
});
