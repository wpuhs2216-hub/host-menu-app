// 起動時自動アップデートチェック（GitHub Releases 連携）
// - 起動後 3秒 遅延（UI 描画ブロック防止）
// - 6時間キャッシュ（lastUpdateCheckAt）
// - 新版検知でトースト表示。「更新する」「閉じる」「このバージョン無視」

import * as dlg from './dialog.js';

const APP_VERSION = (typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '0.0.0');
const REPO = 'wpuhs2216-hub/host-menu-app';
const RELEASES_URL = `https://api.github.com/repos/${REPO}/releases/latest`;
const STORAGE_KEY = 'host-menu-update-check';
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6時間

function parseVersion(s) {
  if (!s) return [0, 0, 0];
  const m = String(s).replace(/^v/i, '').match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  if (!m) return [0, 0, 0];
  return [Number(m[1] || 0), Number(m[2] || 0), Number(m[3] || 0)];
}
function isNewer(latest, current) {
  const a = parseVersion(latest);
  const b = parseVersion(current);
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i] > 0;
  }
  return false;
}

function loadCache() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}
function saveCache(obj) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(obj)); } catch { /* ignore */ }
}

function showUpdateBanner({ latest, url }) {
  // 既存があれば消す
  const existing = document.querySelector('.update-banner');
  if (existing) existing.remove();

  const el = document.createElement('div');
  el.className = 'update-banner';
  el.innerHTML = `
    <div class="ub-text">新しいバージョン <strong>v${latest}</strong> が公開されました</div>
    <div class="ub-actions">
      <button class="btn btn-primary ub-update">更新する</button>
      <button class="btn btn-secondary ub-skip">このバージョン無視</button>
      <button class="ub-close" aria-label="閉じる">×</button>
    </div>
  `;
  document.body.appendChild(el);
  setTimeout(() => el.classList.add('show'), 30);

  el.querySelector('.ub-update').addEventListener('click', () => {
    try { window.open(url, '_system'); } catch { window.open(url, '_blank'); }
  });
  el.querySelector('.ub-skip').addEventListener('click', () => {
    const cache = loadCache();
    cache.skipVersion = latest;
    saveCache(cache);
    el.classList.remove('show');
    setTimeout(() => el.remove(), 300);
  });
  el.querySelector('.ub-close').addEventListener('click', () => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 300);
  });
}

async function check({ force = false } = {}) {
  const cache = loadCache();
  const now = Date.now();
  if (!force && cache.lastUpdateCheckAt && (now - cache.lastUpdateCheckAt) < CACHE_TTL_MS) {
    return null;
  }
  cache.lastUpdateCheckAt = now;
  saveCache(cache);

  let data;
  try {
    const res = await fetch(RELEASES_URL, {
      headers: { 'Accept': 'application/vnd.github+json' },
      cache: 'no-store',
    });
    if (!res.ok) return null;
    data = await res.json();
  } catch { return null; }

  const latestTag = data.tag_name || '';
  const latest = parseVersion(latestTag).join('.');
  if (!isNewer(latestTag, APP_VERSION)) return null;

  // 「このバージョン無視」設定済みならスキップ
  if (cache.skipVersion && cache.skipVersion === latest) return null;

  const apkAsset = (data.assets || []).find((a) => a.name && a.name.endsWith('.apk'));
  const url = apkAsset ? apkAsset.browser_download_url : data.html_url;
  showUpdateBanner({ latest, url });
  return { latest, url };
}

// 起動後 3秒 遅延でチェック（idle なら更に良い）
export function scheduleStartupCheck() {
  const run = () => check().catch(() => {});
  if ('requestIdleCallback' in window) {
    setTimeout(() => requestIdleCallback(run, { timeout: 5000 }), 3000);
  } else {
    setTimeout(run, 3000);
  }
}

// 手動チェック（admin ボタン用）：キャッシュ無視
export async function manualCheck() {
  const cache = loadCache();
  // 手動時は skipVersion も解除して通知
  delete cache.skipVersion;
  saveCache(cache);
  const r = await check({ force: true });
  if (!r) {
    dlg.toast(`最新版です（v${APP_VERSION}）`, { type: 'info' });
  }
  return r;
}
