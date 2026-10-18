// オフラインでも開けるように、画面の部品を端末に保存する
// ※ public/ の中身を変えて公開するときは、この版の数字を上げる
const CACHE = 'flick-v2';
const SHELL = ['/', '/style.css', '/app.js', '/icon.svg', '/manifest.webmanifest'];

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

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/auth/')) return;

  // 画面（HTML）：ネット優先。2秒で返ってこない・圏外なら保存分（古い画面が残りにくい）
  if (e.request.mode === 'navigate') {
    e.respondWith((async () => {
      const cache = await caches.open(CACHE);
      const net = fetch(e.request).then((res) => {
        if (res.ok) e.waitUntil(cache.put('/', res.clone()));
        return res;
      });
      e.waitUntil(net.catch(() => {}));
      const timeout = new Promise((r) => setTimeout(r, 2000));
      const first = await Promise.race([net.catch(() => null), timeout]);
      return first || (await cache.match('/')) || net;
    })());
    return;
  }

  // CSS・JS・画像：保存分をすぐ返し、裏で新しいものに入れ替える
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(e.request);
    const fresh = fetch(e.request).then((res) => {
      if (res.ok && res.type === 'basic') return cache.put(e.request, res.clone()).then(() => res);
      return res;
    });
    e.waitUntil(fresh.catch(() => {}));
    return cached || fresh;
  })());
});
