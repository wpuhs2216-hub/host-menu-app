// データ管理（localStorage使用のプロトタイプ版）
// 全アイテム統一型：画像＋源氏名＋役職

const STORAGE_KEY = 'host-menu-data';
const ORDERS_KEY = 'host-menu-orders';
const SETTINGS_KEY = 'host-menu-settings';
const PW_KEY = 'host-menu-admin-pw';
const DEFAULT_PW = '2020';

// 初期サンプルデータ
const DEFAULT_DATA = {
  items: [
    { id: 'item-1', name: '', ruby: '', title: '', image: '', label: '', order: 0, visible: true, isNewFace: false },
    { id: 'item-2', name: '', ruby: '', title: '', image: '', label: '', order: 1, visible: true, isNewFace: false },
    { id: 'item-3', name: '', ruby: '', title: '', image: '', label: '', order: 2, visible: true, isNewFace: false },
    { id: 'item-4', name: '神木祐也', ruby: 'かみきゆうや', title: '取締役', image: '', label: '', order: 3, visible: true, isNewFace: false },
    { id: 'item-5', name: '迅', ruby: 'じん', title: '総支配人', image: '', label: '', order: 4, visible: true, isNewFace: false },
    { id: 'item-6', name: 'ちんす♡こう', ruby: '', title: '主任', image: '', label: '', order: 5, visible: true, isNewFace: false },
    { id: 'item-7', name: 'クロム', ruby: '', title: '副主任', image: '', label: '', order: 6, visible: true, isNewFace: false },
    { id: 'item-8', name: 'スバル', ruby: '', title: '', image: '', label: '', order: 7, visible: true, isNewFace: false },
    { id: 'item-9', name: '琥', ruby: 'こはく', title: '', image: '', label: '', order: 8, visible: true, isNewFace: false },
    { id: 'item-10', name: '寿里', ruby: 'じゅり', title: '', image: '', label: '', order: 9, visible: true, isNewFace: false },
    { id: 'item-11', name: '夏目', ruby: 'なつめ', title: '', image: '', label: '', order: 10, visible: true, isNewFace: false },
    { id: 'item-12', name: '雅', ruby: 'みやび', title: '', image: '', label: '', order: 11, visible: true, isNewFace: false },
    { id: 'item-13', name: '狼恋', ruby: 'ろうれん', title: '', image: '', label: '', order: 12, visible: true, isNewFace: false },
    { id: 'item-14', name: 'はると', ruby: '', title: '', image: '', label: '', order: 13, visible: true, isNewFace: false },
  ],
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

export function clearOrders() {
  localStorage.removeItem(ORDERS_KEY);
}

// === 表示設定 ===

const DEFAULT_SETTINGS = {
  nameFontSize: 20,
  titleFontSize: 13,
  fsNameFontSize: 44,
  fsTitleFontSize: 24,
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
