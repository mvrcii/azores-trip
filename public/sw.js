// Service worker: app shell from cache (fast launch on weak signal), fresh data when reachable, map tiles kept for offline.
const SHELL = 'shell-__BUILD__';
const DATA = 'data-v1';
const TILES = 'tiles-v1';
const PRECACHE = "__PRECACHE__";
const TILE_LIMIT = 1200;

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(Array.isArray(PRECACHE) ? PRECACHE : ['./']))
    // keep a copy of the data files too, so a first offline launch has an itinerary and a forecast (best effort)
    .then(() => caches.open(DATA).then((c) => Promise.all(['data/itinerary.json', 'weather.json'].map((f) => fetch(f, { cache: 'no-store' }).then((r) => (r.ok ? c.put(new URL(f, self.location).pathname, r) : null)).catch(() => null)))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k.startsWith('shell-') && k !== SHELL).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

async function trim(cache) {
  const keys = await cache.keys();
  if (keys.length > TILE_LIMIT) await Promise.all(keys.slice(0, keys.length - TILE_LIMIT).map((k) => cache.delete(k)));
}

async function tile(req) {
  const cache = await caches.open(TILES);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) { cache.put(req, res.clone()); if (Math.random() < 0.02) trim(cache); } // never keep error tiles
  return res;
}

// Fresh copy when the network answers in time (headers and body), otherwise the last good one.
async function networkFirst(req) {
  const cache = await caches.open(DATA);
  const key = new URL(req.url).pathname;
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 6000);
    const res = await fetch(req.url, { signal: ctl.signal, cache: 'no-store' });
    const body = await res.blob();
    clearTimeout(timer);
    const out = new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
    if (res.ok) cache.put(key, out.clone());
    return out;
  } catch (err) {
    const hit = await cache.match(key);
    if (hit) return hit;
    throw err;
  }
}

// App shell: always from the precache, which is replaced as a whole when a new version installs.
// (Refreshing single files here could pair a new index.html with old, uncached assets.)
async function shell(req, key) {
  const cache = await caches.open(SHELL);
  const hit = await cache.match(key || req, { ignoreSearch: true });
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok && !key) cache.put(req, res.clone());
  return res;
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.hostname === 'tile.openstreetmap.org') return e.respondWith(tile(req));
  if (url.origin !== self.location.origin) return; // weather, routing, radar: the app caches these itself
  if (req.mode === 'navigate') return e.respondWith(shell(req, './'));
  if (/\/(data\/itinerary|weather)\.json$/.test(url.pathname)) return e.respondWith(networkFirst(req));
  e.respondWith(shell(req));
});
