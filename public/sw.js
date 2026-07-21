// Service Worker — caches audio files for offline playback and pre-fetches the queue.

const CACHE = 'v6-audio-v6';
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

  // Audio: range requests must bypass the SW entirely — iOS Safari uses range requests
  // for streaming and caching partial responses (206) causes playback failures.
  // Only serve from cache for full (non-range) requests (e.g. pre-cached offline audio).
  if (url.pathname.startsWith('/audio/')) {
    if (e.request.headers.get('range')) return; // let browser handle range requests directly
    e.respondWith(
      caches.open(CACHE).then(async cache => {
        const cached = await cache.match(e.request);
        if (cached) return cached;
        return fetch(e.request); // don't cache live-streamed audio on the fly
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

// Pre-cache audio for upcoming queue items (full file fetch, stored as 200 for offline use)
self.addEventListener('message', e => {
  if (e.data?.type !== 'PRECACHE_AUDIO') return;
  const ids = Array.isArray(e.data.ids) ? e.data.ids : [];
  caches.open(CACHE).then(cache => {
    for (const id of ids) {
      const url = '/audio/' + id + '.m4a';
      cache.match(url).then(cached => {
        if (!cached) {
          fetch(url).then(resp => { if (resp.status === 200) cache.put(url, resp); }).catch(() => {});
        }
      });
    }
  });
});
