// データ管理（localStorage使用のプロトタイプ版）
// 全アイテム統一型：画像＋源氏名＋役職

const STORAGE_KEY = 'host-menu-data';
const ORDERS_KEY = 'host-menu-orders';
const SETTINGS_KEY = 'host-menu-settings';
const PW_KEY = 'host-menu-admin-pw';
const DEFAULT_PW = '2020';

// 初期データ（新店舗は空から始める。GENTLY DIVA はクラウドのデータを使うため影響なし）
const DEFAULT_DATA = {
  items: [],
};

// データ読み込み
export function loadData() {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved) {
    try {
      const parsed = JSON.parse(saved);
      // 旧データ形式からの移行
      if (parsed.hosts || parsed.infoCards) {
        return migrateData(parsed);
      }
      return parsed;
    } catch {
      return structuredClone(DEFAULT_DATA);
    }
  }
  return structuredClone(DEFAULT_DATA);
}

// 旧データ形式からの移行
function migrateData(old) {
  const items = [];
  let order = 0;
  if (old.infoCards) {
    old.infoCards.sort((a, b) => a.order - b.order).forEach((c) => {
      items.push({ id: c.id, name: '', title: '', image: '', label: c.title, order: order++, visible: true });
    });
  }
  if (old.hosts) {
    old.hosts.sort((a, b) => a.order - b.order).forEach((h) => {
      items.push({ id: h.id, name: h.name, title: h.title, image: h.image || '', label: '', order: order++, visible: h.visible !== false });
    });
  }
  return { items };
}

// データ保存
export function saveData(data) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
}

// データリセット
export function resetData() {
  localStorage.removeItem(STORAGE_KEY);
  return structuredClone(DEFAULT_DATA);
}

// 画像をBase64に変換
export function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// ユニークID生成
export function generateId() {
  return `item-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// === 指名オーダー管理 ===

export function loadOrders() {
  const saved = localStorage.getItem(ORDERS_KEY);
  if (saved) {
    try { return JSON.parse(saved); } catch { return []; }
  }
  return [];
}

export function saveOrder(order) {
  const orders = loadOrders();
  orders.push(order);
  localStorage.setItem(ORDERS_KEY, JSON.stringify(orders));
}

export function deleteOrder(orderId) {
  const orders = loadOrders().filter((o) => o.id !== orderId);
  localStorage.setItem(ORDERS_KEY, JSON.stringify(orders));
}

export function updateOrder(orderId, patch) {
  const orders = loadOrders();
  const idx = orders.findIndex((o) => o.id === orderId);
  if (idx === -1) return null;
  orders[idx] = { ...orders[idx], ...patch };
  localStorage.setItem(ORDERS_KEY, JSON.stringify(orders));
  return orders[idx];
}

export function clearOrders() {
  localStorage.removeItem(ORDERS_KEY);
}

// === 表示設定 ===

const DEFAULT_SETTINGS = {
  nameFontSize: 20,
  titleFontSize: 13,
  fsNameFontSize: 44,
  fsTitleFontSize: 24,
  skipOrderInput: false,
};

export function loadSettings() {
  const saved = localStorage.getItem(SETTINGS_KEY);
  if (saved) {
    try { return { ...DEFAULT_SETTINGS, ...JSON.parse(saved) }; } catch { /* fall through */ }
  }
  return { ...DEFAULT_SETTINGS };
}

export function saveSettings(settings) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

// === バックアップ/復元 ===

export function exportAllData() {
  return {
    items: loadData(),
    orders: loadOrders(),
    settings: loadSettings(),
  };
}

export function importAllData(backup) {
  if (backup.items) saveData(backup.items);
  if (backup.orders) localStorage.setItem(ORDERS_KEY, JSON.stringify(backup.orders));
  if (backup.settings) saveSettings(backup.settings);
}

// === パスワード管理 ===

export function getAdminPw() {
  return localStorage.getItem(PW_KEY) || DEFAULT_PW;
}

export function setAdminPw(newPw) {
  localStorage.setItem(PW_KEY, newPw);
}
