// オフラインでも、2回目からは一瞬で開くように画面の部品を端末に保存する
const CACHE = 'flick-v1';
const SHELL = ['/', '/index.html', '/style.css', '/app.js', '/icon.svg', '/manifest.webmanifest'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// 画面の部品：まず保存分を返し、裏で新しいものに入れ替える（stale-while-revalidate）
// /api と /auth は必ずネットへ
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/auth/')) return;
  const key = e.request.mode === 'navigate' ? '/' : e.request;
  e.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(key);
      const fresh = fetch(e.request)
        .then((res) => { if (res.ok && res.type === 'basic') cache.put(key, res.clone()); return res; })
        .catch(() => cached);
      return cached || fresh;
    })
  );
});
