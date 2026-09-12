// ハジメル向けの差し替え部品（2026-09-12）。店の見分けと合言葉。
//
// 元は店の一覧と合言葉をこのファイルに直書きしていた（STORES）。ハジメル版では
// **店はページの住所で決まり、合言葉はハジメルの棚（board_settings.pin）にある**。
// 端末は合言葉で入ると合鍵（Cookie）をもらい、以後はそれで読み書きする。
// 元と同じ関数名・同じ返り方を保つ（呼び手の main.js / admin.js / lockAuth.js は直さない）。

export const STORES = [];   // ハジメル版では一覧を持たない（店は住所で決まる）

const STORE_ID_KEY = 'host-menu-store-id';
const STORE_NAME_KEY = 'host-menu-store-name';
const PIN_KEY = 'hj-board-pin';                 // 端末に覚えさせた合言葉（管理画面のロックの照合に使う）
const DATA_KEY = 'host-menu-data';
const ADMIN_SESSION_KEY = 'host-menu-admin-session';
const STORE_SETTINGS_CACHE_KEY = 'host-menu-store-settings';

export function getStoreId() { return localStorage.getItem(STORE_ID_KEY) || ''; }
export function getStoreName() { return localStorage.getItem(STORE_NAME_KEY) || ''; }
export function isStoreFixed() { return !!localStorage.getItem(STORE_ID_KEY); }

// 元は同期で店を返していたが、ハジメル版は口に聞かないと分からない。
// ここは null を返し、実際の照合は storeLogin.js（差し替え版）が口に聞く。
export function resolveStoreByPassword(_pw) { return null; }

export function getStoreById(id) {
  if (!id || id !== getStoreId()) return null;
  return { id, name: getStoreName() || id, password: getStorePassword() };
}

export function getStorePassword() { return localStorage.getItem(PIN_KEY) || ''; }
export function rememberPin(pin) { localStorage.setItem(PIN_KEY, pin || ''); }

export function fixStore(id, name) {
  if (!id) return;
  localStorage.setItem(STORE_ID_KEY, id);
  localStorage.setItem(STORE_NAME_KEY, name || id);
}

export function logoutStore() {
  for (const k of [STORE_ID_KEY, STORE_NAME_KEY, PIN_KEY, DATA_KEY, ADMIN_SESSION_KEY, STORE_SETTINGS_CACHE_KEY]) {
    try { localStorage.removeItem(k); } catch { /* ignore */ }
  }
  // 合鍵も止める（返事は待たない）
  try { fetch('/_h/app/board/logout', { method: 'POST', credentials: 'same-origin' }).catch(() => {}); } catch { /* ignore */ }
}
