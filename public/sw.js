// Service Worker — caches audio files for offline playback and pre-fetches the queue.

const CACHE = 'v6-audio-v1';
const STATIC = ['/', '/app.js', '/player.js', '/shared.css', '/beep.wav'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(STATIC).catch(() => {})));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // Audio: cache-first, store on miss
  if (url.pathname.startsWith('/audio/')) {
    e.respondWith(
      caches.open(CACHE).then(async cache => {
        const cached = await cache.match(e.request);
        if (cached) return cached;
        const resp = await fetch(e.request);
        if (resp.ok) cache.put(e.request, resp.clone());
        return resp;
      })
    );
    return;
  }

  // API: network-first, no cache fallback (stale data worse than error)
  if (url.pathname.startsWith('/api/')) return;

  // Static assets: cache-first
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request))
  );
});

// Pre-cache audio for upcoming queue items
self.addEventListener('message', e => {
  if (e.data?.type !== 'PRECACHE_AUDIO') return;
  const ids = Array.isArray(e.data.ids) ? e.data.ids : [];
  caches.open(CACHE).then(cache => {
    for (const id of ids) {
      const url = '/audio/' + id + '.m4a';
      cache.match(url).then(cached => {
        if (!cached) {
          fetch(url).then(resp => { if (resp.ok) cache.put(url, resp); }).catch(() => {});
        }
      });
    }
  });
});
