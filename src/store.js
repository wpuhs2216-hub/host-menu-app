// データ管理（localStorage使用のプロトタイプ版）
// 全アイテム統一型：画像＋源氏名＋役職
//
// 設定は二段構え（2026-09-25）:
//   1) 台の上書き（この端末だけ）  2) 店の既定（全台共通）  3) プログラムの既定値
// 上から順に見て、最初に見つかった値が効く。読む側は今までどおり loadSettings() を呼ぶだけでよい。

import { getStoreDeviceDefaults } from './storeSettings.js';

// @ハジメル 札の控え: クラウドの札をこの端末に写した物（画像の本体は別の棚）
const STORAGE_KEY = 'host-menu-data';
// @ハジメル 指名履歴の控え: この端末で出した指名の記録
const ORDERS_KEY = 'host-menu-orders';
// @ハジメル 台の設定: この端末だけの設定（文字の大きさ・鍵・テスト用）
const SETTINGS_KEY = 'host-menu-settings';
// @ハジメル 台の上書き: 店の既定に逆らってこの台だけ変えた設定。{ 設定名: 'on' | 'off' }
const OVERRIDES_KEY = 'host-menu-setting-overrides';
// @ハジメル 上書きの引っ越し済み印: 昔の設定を上書きへ移し終えたかどうか
const OVERRIDES_MIGRATED_KEY = 'host-menu-setting-overrides-migrated';
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

// === サムネフレーム（金/銀/銅） ===
export const FRAME_OPTIONS = [
  { id: 'gold', label: '金' },
  { id: 'silver', label: '銀' },
  { id: 'bronze', label: '銅' },
];

// フレーム画像のパス（無効値は '' を返す）
export function frameSrc(frame) {
  if (!FRAME_OPTIONS.some((f) => f.id === frame)) return '';
  return `${import.meta.env.BASE_URL}frames/${frame}.webp`;
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
  consentTestMode: false,   // デジタル署名（ご新規様同意書）のテストモード
  consentCloudSave: false,  // 署名をクラウドにも保存する（オフ=この端末の中だけ）
  consentAlbumSave: true,   // 署名した書類を端末のアルバム（写真アプリ）にも保存する
  consentMenuButton: false, // メニュー画面に同意書ボタンを表示する
  consentNameField: false,  // 伝票名（ひらがな）の入力欄を表示する
  lockPattern: '',          // 9点パターンロック（空=未設定。設定するとパスワード入力の代わりに使う）
  orderAuth: false,         // パネル送信のときに解錠（パスワード/パターン）を求める
  hideThumbName: false,     // サムネイルに源氏名・役職を出さない（既定は表示。拡大表示には影響しない）
  hideCheckbox: false,      // 選択ボックスを出さない（見せるだけの運用。長押しでチェックはできる）
  hideConfirmBtn: false,    // 確定（送信）ボタンを出さない
  menuSplit: false,         // 最初に「料金システム / ALLCAST / 役職メニュー」の選択画面を出す
};

// 店で既定を決めて、台ごとに上書きできる設定。
// label は管理画面にそのまま出る文言。section は管理画面のどの欄に並べるか。
export const SHARED_SETTINGS = [
  { key: 'menuSplit',         section: 'general', label: '最初にメニュー選択画面を出す（料金システム / ALLCAST / 役職メニュー）' },
  { key: 'skipOrderInput',    section: 'general', label: '確定時に席番・お客様名の入力をスキップ（後から編集可）' },
  { key: 'hideThumbName',     section: 'general', label: 'サムネイルに名前を表示しない（拡大表示には出ます）' },
  { key: 'hideCheckbox',      section: 'general', label: '選択ボックスを表示しない（見せるだけの運用。長押しでチェックはできます）' },
  { key: 'hideConfirmBtn',    section: 'general', label: '確定（送信）ボタンを表示しない' },
  { key: 'orderAuth',         section: 'general', label: 'パネル送信のときにロック解除を求める（お客様の誤送信を防ぐ）' },
  { key: 'consentMenuButton', section: 'consent', label: 'メニュー画面に同意書ボタンを表示する' },
  { key: 'consentNameField',  section: 'consent', label: '伝票名（ひらがな）の入力欄を表示する' },
  { key: 'consentAlbumSave',  section: 'consent', label: '端末のアルバムにも保存する（写真アプリの「同意書」に入ります）' },
  { key: 'consentCloudSave',  section: 'consent', label: 'クラウドにも保存する（オフならこの端末の中だけに保存）' },
];

const SHARED_KEYS = SHARED_SETTINGS.map((x) => x.key);

export function isSharedSetting(key) {
  return SHARED_KEYS.includes(key);
}

// === 台の上書き（'on' / 'off' / 無し＝店にあわせる） ===

function readOverrides() {
  try {
    const raw = JSON.parse(localStorage.getItem(OVERRIDES_KEY) || '{}');
    const out = {};
    for (const k of SHARED_KEYS) {
      if (raw[k] === 'on' || raw[k] === 'off') out[k] = raw[k];
    }
    return out;
  } catch {
    return {};
  }
}

// 昔の設定の引っ越し（1 回だけ）。
// 今その台で「プログラムの既定値と違う状態にしてある」設定だけ、台の上書きとして引き継ぐ。
// 触っていない設定は「店にあわせる」になる。店の既定は最初すべて空なので、引っ越し直後の動きは今までと同じ。
function migrateOverridesOnce() {
  try {
    if (localStorage.getItem(OVERRIDES_MIGRATED_KEY)) return;
    const raw = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
    const overrides = readOverrides();
    for (const k of SHARED_KEYS) {
      if (k in overrides) continue;
      if (!(k in raw)) continue;
      if (!!raw[k] === !!DEFAULT_SETTINGS[k]) continue;   // 既定値のままなら店にあわせる
      overrides[k] = raw[k] ? 'on' : 'off';
    }
    localStorage.setItem(OVERRIDES_KEY, JSON.stringify(overrides));
    localStorage.setItem(OVERRIDES_MIGRATED_KEY, '1');
  } catch { /* 引っ越しに失敗しても既定値で動く */ }
}
migrateOverridesOnce();

// その設定の台の上書き。'' なら「店にあわせる」
export function getSettingOverride(key) {
  return readOverrides()[key] || '';
}

// 台の上書きを決める。'' を渡すと「店にあわせる」に戻る
export function setSettingOverride(key, value) {
  if (!isSharedSetting(key)) return;
  const overrides = readOverrides();
  if (value === 'on' || value === 'off') overrides[key] = value;
  else delete overrides[key];
  localStorage.setItem(OVERRIDES_KEY, JSON.stringify(overrides));
}

// 店の既定値（決まっていなければプログラムの既定値）
export function getStoreDefault(key) {
  let defaults = {};
  try { defaults = getStoreDeviceDefaults() || {}; } catch { /* 取れなければ既定値 */ }
  if (typeof defaults[key] === 'boolean') return defaults[key];
  return !!DEFAULT_SETTINGS[key];
}

// 店の既定値が決められているか（管理画面の表示用）
export function hasStoreDefault(key) {
  try { return typeof (getStoreDeviceDefaults() || {})[key] === 'boolean'; } catch { return false; }
}

// 実際に効く設定を返す。共有できる設定は 台の上書き → 店の既定 → プログラムの既定値 の順で決まる。
// 読む側（メニュー画面・同意書など）は今までどおりこれを呼ぶだけでよい。
export function loadSettings() {
  let local = {};
  const saved = localStorage.getItem(SETTINGS_KEY);
  if (saved) {
    try { local = JSON.parse(saved); } catch { local = {}; }
  }
  const out = { ...DEFAULT_SETTINGS, ...local };
  const overrides = readOverrides();
  for (const key of SHARED_KEYS) {
    const ov = overrides[key];
    out[key] = ov ? ov === 'on' : getStoreDefault(key);
  }
  return out;
}

// 台だけの設定を保存する。
// 共有できる設定はここでは保存しない（setSettingOverride で決める）。
// loadSettings() の戻りをそのまま渡しても、店の既定が台に焼き付かないようにするため。
export function saveSettings(settings) {
  const out = {};
  for (const [k, v] of Object.entries(settings || {})) {
    if (!SHARED_KEYS.includes(k)) out[k] = v;
  }
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(out));
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
