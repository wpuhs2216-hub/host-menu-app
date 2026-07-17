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

// 通知本文の英語色名（Edge Function が生成）を店舗設定の色ラベル（壁側/通路側など）に書き換える。
// ラベルはページ側（storeSettings.js）が Cache Storage に保存したものを参照する。
const SETTINGS_CACHE = 'hm-store-settings';
const SETTINGS_URL = '/__store-settings';
const COLOR_NAME_EN = { yellow: 'Yellow', red: 'Red', blue: 'Blue', green: 'Green' };

async function applyColorLabels(body) {
  try {
    const cache = await caches.open(SETTINGS_CACHE);
    const res = await cache.match(SETTINGS_URL);
    if (!res) return body;
    const settings = await res.json();
    const labels = settings && settings.colorLabels;
    if (!labels) return body;
    return body.split('\n').map((line) => {
      for (const key of Object.keys(COLOR_NAME_EN)) {
        const en = COLOR_NAME_EN[key];
        const label = (labels[key] || '').trim();
        if (!label || label === en) continue;
        // 本文の色行は「Yellow」単独 or 「Yellow / お客様名」の形式
        if (line === en || line.startsWith(en + ' /')) return label + line.slice(en.length);
      }
      return line;
    }).join('\n');
  } catch {
    return body;
  }
}

self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = { title: 'GENTLY DIVA', body: event.data ? event.data.text() : '新規通知' };
  }
  const title = payload.title || 'GENTLY DIVA';
  event.waitUntil((async () => {
    const body = await applyColorLabels(payload.body || '');
    const options = {
      body,
      icon: payload.icon || '/icon-192.png',
      badge: '/icon-192.png',
      tag: payload.tag || undefined,
      data: { url: payload.url || '/admin.html', orderId: payload.orderId },
      requireInteraction: false,
    };
    await self.registration.showNotification(title, options);
  })());
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
