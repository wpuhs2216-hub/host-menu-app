// 店舗コンテキスト（マルチ店舗対応・ハードコード版）
// - 店舗一覧はこのファイルの STORES に直書きする（アプリからは追加できない）
// - 起動時にパスワードを入力すると、一致した店舗が端末に固定される
// - 「ログアウト」で固定を解除すると、別店舗のパスワードで切り替え可能
// - 店舗パスワードは管理画面（admin）のゲートも兼ねる（統一）

// ★店舗の追加はここに行を足してアプリを再リリースする。
//   id は DB の store_id（panels.store_id 等）と一致させること。既存店舗は 'gently-diva'。
export const STORES = [
  { id: 'gently-diva', name: 'GENTLY DIVA', password: '2020' },
  { id: 'dears-lucia', name: "Dear's Lucia", password: '12345' },
  { id: 'dears-bachelor', name: "Dear's BACHELOR", password: '54321' },
  { id: 'dears-osaka', name: "Dear's大阪", password: '11111' },
  { id: 'gently', name: 'GENTLY', password: '22222' },
  { id: 'gently-greed', name: 'GENTLY GREED', password: '33333' },
  // 動作確認用。新機能の検証は実店舗ではなく必ずこの店舗で行う
  { id: 'test-store', name: 'テスト店舗', password: '00000' },
];

const STORE_ID_KEY = 'host-menu-store-id';
const STORE_NAME_KEY = 'host-menu-store-name';
const DATA_KEY = 'host-menu-data';            // パネルのローカルキャッシュ（店舗依存）
const ADMIN_SESSION_KEY = 'host-menu-admin-session';
const STORE_SETTINGS_CACHE_KEY = 'host-menu-store-settings'; // 店舗設定キャッシュ（storeSettings.js と同じキー）

// 端末に固定された店舗ID。未固定なら ''（空＝どのデータにも一致しない安全側）
export function getStoreId() {
  return localStorage.getItem(STORE_ID_KEY) || '';
}

export function getStoreName() {
  return localStorage.getItem(STORE_NAME_KEY) || '';
}

// 端末が店舗を固定済みか
export function isStoreFixed() {
  return !!localStorage.getItem(STORE_ID_KEY);
}

// パスワードから店舗を特定（一致する STORES 要素 or null）
export function resolveStoreByPassword(pw) {
  if (!pw) return null;
  return STORES.find((s) => s.password === pw) || null;
}

export function getStoreById(id) {
  return STORES.find((s) => s.id === id) || null;
}

// 固定中の店舗のパスワード（admin ゲート照合用）
export function getStorePassword() {
  const s = getStoreById(getStoreId());
  return s ? s.password : '';
}

// 店舗を固定する
export function fixStore(id, name) {
  if (!id) return;
  localStorage.setItem(STORE_ID_KEY, id);
  localStorage.setItem(STORE_NAME_KEY, name || id);
}

// ログアウト（店舗固定を解除）。別店舗のデータが残らないよう
// パネルのローカルキャッシュと admin セッションも破棄する。
export function logoutStore() {
  try { localStorage.removeItem(STORE_ID_KEY); } catch { /* ignore */ }
  try { localStorage.removeItem(STORE_NAME_KEY); } catch { /* ignore */ }
  try { localStorage.removeItem(DATA_KEY); } catch { /* ignore */ }
  try { localStorage.removeItem(ADMIN_SESSION_KEY); } catch { /* ignore */ }
  try { localStorage.removeItem(STORE_SETTINGS_CACHE_KEY); } catch { /* ignore */ }
}
