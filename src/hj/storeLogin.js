// ハジメル向けの差し替え部品（2026-09-12）。起動時の合言葉の画面。
//
// 元と同じ見た目・同じ関数（ensureStoreFixed）。違うのは照合の先だけ ──
// 元は直書きの一覧、こちらはハジメルの口（POST /_h/app/board/login）。
// 通れば合鍵が Cookie で端末に残り、店の名前が返る。

import { isStoreFixed, fixStore, rememberPin, getStoreName, getStoreId } from './storeContext.js';

const ADMIN_SESSION_KEY = 'host-menu-admin-session';

function buildOverlay() {
  const el = document.createElement('div');
  el.className = 'store-login-overlay';
  el.innerHTML = `
    <div class="store-login-box">
      <div class="store-login-appname">初回案内</div>
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

// 手元（127.0.0.1）では住所に店が入らないので `?s=<店の住所>` で教える。本番は住所で決まる
function devSlug() {
  try { return new URLSearchParams(location.search).get('s') || ''; } catch { return ''; }
}

async function loginToHajimeru(pin) {
  const res = await fetch('/_h/app/board/login', {
    method: 'POST', credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pin, name: (navigator.userAgent || '').slice(0, 60), slug: devSlug() }),
  });
  let body = null;
  try { body = await res.json(); } catch { /* ignore */ }
  if (!res.ok || !body || body.error) return { ok: false, message: body?.error?.message || `HTTP ${res.status}` };
  return { ok: true, store: body.data.store };
}

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
    let busy = false;

    const tryLogin = async () => {
      if (busy) return;
      const pin = input.value;
      if (!pin) return;
      busy = true; submitBtn.disabled = true; errorEl.textContent = '';
      const r = await loginToHajimeru(pin);
      busy = false; submitBtn.disabled = false;
      if (!r.ok) {
        errorEl.textContent = r.message || 'パスワードが違います';
        input.value = '';
        input.focus();
        return;
      }
      fixStore(r.store.id, r.store.name);
      rememberPin(pin);
      if (grantAdmin) {
        try { localStorage.setItem(ADMIN_SESSION_KEY, JSON.stringify({ lastLoginAt: Date.now(), pw: pin })); } catch { /* ignore */ }
      }
      el.remove();
      resolve({ id: r.store.id, name: r.store.name });
    };

    submitBtn.addEventListener('click', tryLogin);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') tryLogin(); });
    setTimeout(() => input.focus(), 50);
  });
}
