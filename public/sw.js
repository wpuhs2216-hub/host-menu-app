const CACHE_NAME = 'gently-diva-v1';
const ASSETS = [
  '/',
  '/index.html',
  '/admin.html',
  '/src/style.css',
  '/src/admin.css',
  '/src/main.js',
  '/src/admin.js',
  '/src/store.js',
  '/src/imageDB.js',
  '/icon-192.png',
  '/icon-512.png',
];

// インストール時にキャッシュ
self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

// 古いキャッシュを削除
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// ネットワーク優先、フォールバックでキャッシュ
self.addEventListener('fetch', (e) => {
  // Googleフォント等の外部リソースはスキップ
  if (!e.request.url.startsWith(self.location.origin)) return;

  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const clone = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(e.request, clone));
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
