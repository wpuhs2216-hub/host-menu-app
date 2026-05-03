const CACHE_NAME = 'gently-diva-v2';
const ASSETS = [
  '/',
  '/index.html',
  '/admin.html',
  '/icon-192.png',
  '/icon-512.png',
];

// インストール時にキャッシュ
self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      Promise.all(ASSETS.map((url) => cache.add(url).catch(() => null)))
    )
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
  if (!e.request.url.startsWith(self.location.origin)) return;
  if (e.request.method !== 'GET') return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        try {
          const clone = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(e.request, clone)).catch(() => {});
        } catch { /* ignore */ }
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});

// === Web Push ===
self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = { title: 'GENTLY DIVA', body: event.data ? event.data.text() : '新規通知' };
  }
  const title = payload.title || 'GENTLY DIVA';
  const options = {
    body: payload.body || '',
    icon: payload.icon || '/icon-192.png',
    badge: '/icon-192.png',
    tag: payload.tag || undefined,
    data: { url: payload.url || '/admin.html', orderId: payload.orderId },
    requireInteraction: false,
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || '/admin.html';
  event.waitUntil((async () => {
    const allClients = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    // 既に開いているタブがあればフォーカス
    for (const c of allClients) {
      if (c.url.includes('admin.html') || c.url.endsWith('/')) {
        return c.focus();
      }
    }
    if (clients.openWindow) return clients.openWindow(targetUrl);
  })());
});
