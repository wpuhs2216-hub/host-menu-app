// 履歴専用ページ
// - 認証必須（admin と同じ 30日セッション）
// - Realtime で新規注文を即時表示
// - Notification API でブラウザ通知

import * as dlg from './dialog.js';
import {
  loadOrdersCloud, startOrdersRealtime,
  syncOrderDelete, syncOrdersClear,
} from './sync.js';

// 環境クラス
const IS_CAPACITOR = !!(globalThis.Capacitor && globalThis.Capacitor.isNativePlatform && globalThis.Capacitor.isNativePlatform());
document.documentElement.classList.add(IS_CAPACITOR ? 'env-app' : 'env-web');

// 認証ガード
{
  const SESSION_KEY = 'host-menu-admin-session';
  const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
  let valid = false;
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (raw) {
      const obj = JSON.parse(raw);
      if (obj && obj.lastLoginAt && (Date.now() - obj.lastLoginAt) < SESSION_TTL_MS) valid = true;
    }
  } catch { /* ignore */ }
  if (!valid) {
    location.replace('./admin.html');
    throw new Error('Auth required');
  }
}

// 自端末 ID（重複通知防止用）
function deviceId() {
  let id = localStorage.getItem('host-menu-device-id');
  if (!id) {
    id = 'd-' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
    localStorage.setItem('host-menu-device-id', id);
  }
  return id;
}
const SELF_ID = deviceId();

const COLOR_LABEL = { yellow: 'Yellow', red: 'Red', blue: 'Blue', green: 'Green' };
const VALID_COLORS = ['yellow', 'red', 'blue', 'green'];

let orders = [];
const listEl = document.getElementById('history-list');
const countEl = document.getElementById('history-count');

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = String(str ?? '');
  return div.innerHTML;
}

function fmtDate(iso) {
  try {
    const d = new Date(iso);
    return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  } catch { return iso; }
}

function render() {
  countEl.textContent = `${orders.length} 件`;
  if (orders.length === 0) {
    listEl.innerHTML = '<div class="empty-msg">履歴はありません</div>';
    return;
  }
  listEl.innerHTML = orders
    .slice()
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .map((o) => {
      const color = VALID_COLORS.includes(o.color) ? o.color : 'yellow';
      const time = fmtDate(o.createdAt);
      const memo = o.memo ? `<div class="order-memo">${escapeHtml(o.memo)}</div>` : '';
      const dev = o.deviceName ? `<span class="order-device">${escapeHtml(o.deviceName)}</span>` : '';
      const src = o.source === 'preview' ? '<span class="order-src-preview">PREVIEW</span>' : '';
      const casts = (o.casts || []).map((c) => {
        const cc = VALID_COLORS.includes(c.color) ? c.color : color;
        return `<span class="order-tag color-${cc}">
          <span class="order-color-badge color-${cc}"></span>${escapeHtml(c.name)}
        </span>`;
      }).join('');
      return `
        <div class="order-card color-${color}" data-id="${o.id}">
          <div class="order-card-header">
            <div class="order-meta">
              <span class="order-color-badge color-${color}"></span>
              <span class="order-seat">席: ${escapeHtml(o.seat || '-')}</span>
              <span class="order-customer">${escapeHtml(o.customerName || '-')}</span>
              ${dev}${src}
            </div>
            <span class="order-time">${time}</span>
          </div>
          <div class="order-casts">${casts}</div>
          ${memo}
          <div class="order-card-actions">
            <button class="btn-icon danger order-delete" title="削除">✕</button>
          </div>
        </div>
      `;
    })
    .join('');

  listEl.querySelectorAll('.order-delete').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const card = btn.closest('.order-card');
      const id = card.dataset.id;
      if (!await dlg.confirm('この履歴を削除しますか？', { danger: true })) return;
      orders = orders.filter((o) => o.id !== id);
      render();
      syncOrderDelete(id).catch(() => {});
    });
  });
}

async function refresh() {
  countEl.textContent = '読み込み中…';
  orders = await loadOrdersCloud();
  render();
}
document.getElementById('btn-refresh')?.addEventListener('click', refresh);

// === Notification API ===

const NOTIFY_KEY = 'host-menu-notify-enabled';
const btnToggleNotify = document.getElementById('btn-toggle-notify');

function notifySupported() {
  return typeof Notification !== 'undefined';
}

function notifyEnabled() {
  return notifySupported()
    && Notification.permission === 'granted'
    && localStorage.getItem(NOTIFY_KEY) === '1';
}

function updateNotifyBtn() {
  if (!notifySupported()) {
    btnToggleNotify.textContent = '通知 非対応';
    btnToggleNotify.disabled = true;
    return;
  }
  if (notifyEnabled()) {
    btnToggleNotify.textContent = '通知 ON';
    btnToggleNotify.classList.add('active');
  } else {
    btnToggleNotify.textContent = '通知 OFF';
    btnToggleNotify.classList.remove('active');
  }
}
updateNotifyBtn();

btnToggleNotify?.addEventListener('click', async () => {
  if (!notifySupported()) return;
  if (notifyEnabled()) {
    localStorage.setItem(NOTIFY_KEY, '0');
    updateNotifyBtn();
    return;
  }
  if (Notification.permission === 'denied') {
    await dlg.alert('ブラウザ設定で通知が拒否されています。\nアドレスバー左の鍵アイコンから通知を「許可」に変更してください。');
    return;
  }
  let perm = Notification.permission;
  if (perm !== 'granted') perm = await Notification.requestPermission();
  if (perm === 'granted') {
    localStorage.setItem(NOTIFY_KEY, '1');
    updateNotifyBtn();
    // テスト通知
    try { new Notification('GENTLY DIVA', { body: '通知が有効になりました', icon: './icon-192.png' }); } catch { /* ignore */ }
  } else {
    updateNotifyBtn();
    dlg.alert('通知が許可されませんでした');
  }
});

function fireNotification(o) {
  if (!notifyEnabled()) return;
  const colorLabel = COLOR_LABEL[o.color] || '';
  const seat = o.seat ? `席 ${o.seat}` : '席未選択';
  const dev = o.deviceName ? `[${o.deviceName}] ` : '';
  const src = o.source === 'preview' ? '（プレビュー）' : '';
  const title = `${dev}${seat} ${src}`.trim();
  const castNames = (o.casts || []).map((c) => c.name).join(', ');
  const body = `${colorLabel}${o.customerName ? ' / ' + o.customerName : ''}\n${castNames}`;
  try {
    const n = new Notification(title || 'GENTLY DIVA', { body, icon: './icon-192.png', tag: o.id });
    n.onclick = () => { window.focus(); n.close(); };
  } catch { /* ignore */ }
}

// === Realtime 購読 ===

startOrdersRealtime({
  onInsert: (o) => {
    if (orders.some((x) => x.id === o.id)) return;
    orders.unshift(o);
    render();
    // 自端末送信は通知しない（重複防止）
    // ※ 自端末判定: row.device_id は loadOrdersCloud から落ちているのでここでは保留、毎回通知
    fireNotification(o);
  },
  onUpdate: (o) => {
    const idx = orders.findIndex((x) => x.id === o.id);
    if (idx >= 0) orders[idx] = o;
    render();
  },
  onDelete: (id) => {
    orders = orders.filter((o) => o.id !== id);
    render();
  },
});

// 初期ロード
refresh();
