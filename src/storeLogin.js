// 起動時の店舗ログイン（パスワードで店舗を固定）
// menu（index）と admin の両方から呼ぶ共通ゲート。
// 既に固定済みなら即解決。未固定ならフルスクリーンのパスワード画面を出す。

import { isStoreFixed, resolveStoreByPassword, fixStore, getStoreName, getStoreId } from './storeContext.js';

const ADMIN_SESSION_KEY = 'host-menu-admin-session';

function buildOverlay() {
  const el = document.createElement('div');
  el.className = 'store-login-overlay';
  el.innerHTML = `
    <div class="store-login-box">
      <div class="store-login-appname">Vパネル</div>
      <h2 class="store-login-title">店舗パスワード</h2>
      <p class="store-login-desc">この端末を使用する店舗のパスワードを入力してください</p>
      <input class="store-login-input" type="password" inputmode="numeric"
             autocomplete="off" placeholder="パスワード" />
      <div class="store-login-error"></div>
      <button class="store-login-submit" type="button">ログイン</button>
    </div>
  `;
  return el;
}

// 店舗が固定されるまで待つ。
// opts.grantAdmin: true なら、ログイン成功時に admin セッションも張る（admin 画面で二度打ち回避）
export function ensureStoreFixed({ grantAdmin = false } = {}) {
  if (isStoreFixed()) {
    return Promise.resolve({ id: getStoreId(), name: getStoreName() });
  }

  return new Promise((resolve) => {
    const el = buildOverlay();
    document.body.appendChild(el);

    const input = el.querySelector('.store-login-input');
    const errorEl = el.querySelector('.store-login-error');
    const submitBtn = el.querySelector('.store-login-submit');

    const tryLogin = () => {
      const store = resolveStoreByPassword(input.value);
      if (!store) {
        errorEl.textContent = 'パスワードが違います';
        input.value = '';
        input.focus();
        return;
      }
      fixStore(store.id, store.name);
      // 統一: 店舗PW＝admin ゲート。admin 画面から呼ばれた場合はセッションも張る
      if (grantAdmin) {
        try {
          localStorage.setItem(ADMIN_SESSION_KEY, JSON.stringify({
            lastLoginAt: Date.now(),
            pw: store.password,
          }));
        } catch { /* ignore */ }
      }
      el.remove();
      resolve({ id: store.id, name: store.name });
    };

    submitBtn.addEventListener('click', tryLogin);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') tryLogin(); });
    setTimeout(() => input.focus(), 50);
  });
}
