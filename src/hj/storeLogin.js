// ハジメル向けの差し替え部品（2026-09-12）。起動時の合言葉の画面 ＋ ハジメルからの入り口。
//
// 元と同じ見た目・同じ関数（ensureStoreFixed）。違うのは照合の先だけ ──
// 元は直書きの一覧、こちらはハジメルの口（POST /_h/app/board/login）。
// 通れば合鍵が Cookie で端末に残り、店の名前が返る。
//
// ハジメルの設定画面から開かれた時（`?hj=<1 回きりの鍵>`）は、合言葉を打たずに入る。
// 管理画面（admin.html）では、この設定画面の中に「ハジメル」の欄を足す（合言葉を決める・端末を外す）。
// ⚠ 元の admin.html / admin.js は 1 文字も直さない。欄は起動後に差し込む。

import { isStoreFixed, fixStore, rememberPin, getStoreName, getStoreId } from './storeContext.js';

const ADMIN_SESSION_KEY = 'host-menu-admin-session';
const API = '/_h/app/board';

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

const query = () => { try { return new URLSearchParams(location.search); } catch { return new URLSearchParams(); } };
// 手元（127.0.0.1）では住所に店が入らないので `?s=<店の住所>` で教える。本番は住所で決まる
const devSlug = () => query().get('s') || '';

async function post(path, body) {
  const res = await fetch(`${API}${path}`, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  let json = null; try { json = await res.json(); } catch { /* ignore */ }
  if (!res.ok || !json || json.error) return { ok: false, message: json?.error?.message || `HTTP ${res.status}` };
  return { ok: true, data: json.data };
}

async function loginWith(body) {
  return post('/login', { ...body, name: (navigator.userAgent || '').slice(0, 60), slug: devSlug() });
}

function afterLogin(store, pin, grantAdmin) {
  fixStore(store.id, store.name);
  if (pin) rememberPin(pin);
  if (grantAdmin) {
    try { localStorage.setItem(ADMIN_SESSION_KEY, JSON.stringify({ lastLoginAt: Date.now(), pw: pin || '' })); } catch { /* ignore */ }
  }
}

export function ensureStoreFixed({ grantAdmin = false } = {}) {
  if (grantAdmin) queueMicrotask(injectHajimeruSection);
  // ハジメルの設定画面から来た（1 回きりの鍵）。鍵は住所から消す
  const code = query().get('hj');
  if (code) {
    const q = query(); q.delete('hj');
    try { history.replaceState(null, '', location.pathname + (q.toString() ? `?${q}` : '')); } catch { /* ignore */ }
    return loginWith({ code }).then((r) => {
      if (r.ok) { afterLogin(r.data.store, '', grantAdmin); return { id: r.data.store.id, name: r.data.store.name }; }
      return askPin(grantAdmin, r.message);
    });
  }
  if (isStoreFixed()) {
    return Promise.resolve({ id: getStoreId(), name: getStoreName() });
  }
  return askPin(grantAdmin);
}

function askPin(grantAdmin, firstError = '') {
  return new Promise((resolve) => {
    const el = buildOverlay();
    document.body.appendChild(el);
    const input = el.querySelector('.store-login-input');
    const errorEl = el.querySelector('.store-login-error');
    const submitBtn = el.querySelector('.store-login-submit');
    if (firstError) errorEl.textContent = firstError;
    let busy = false;
    const tryLogin = async () => {
      if (busy) return;
      const pin = input.value;
      if (!pin) return;
      busy = true; submitBtn.disabled = true; errorEl.textContent = '';
      const r = await loginWith({ pin });
      busy = false; submitBtn.disabled = false;
      if (!r.ok) { errorEl.textContent = r.message || 'パスワードが違います'; input.value = ''; input.focus(); return; }
      afterLogin(r.data.store, pin, grantAdmin);
      el.remove();
      resolve({ id: r.data.store.id, name: r.data.store.name });
    };
    submitBtn.addEventListener('click', tryLogin);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') tryLogin(); });
    setTimeout(() => input.focus(), 50);
  });
}

// === 管理画面に足す「ハジメル」の欄（合言葉を決める・入っている端末） ===
// 元の「店舗設定」の区画の後ろに差し込む。見た目は元の class（section / form-group / btn）をそのまま使う
async function injectHajimeruSection() {
  const anchorBtn = document.getElementById('btn-save-store-settings');
  const anchor = anchorBtn && anchorBtn.closest('.section');
  if (!anchor || document.getElementById('hj-section')) return;
  const sec = document.createElement('div');
  sec.className = 'section';
  sec.id = 'hj-section';
  sec.innerHTML = `
    <div class="section-title"><span>ハジメル（端末の合言葉・入っている端末）</span></div>
    <div class="form-group">
      <label>端末が入る合言葉（4〜8 桁の数字。この店のタブレットは起動時にこれを打つ）</label>
      <div class="toolbar">
        <input type="text" id="hj-pin" inputmode="numeric" maxlength="8" autocomplete="off" placeholder="例: 2020" class="app-dialog-input" style="max-width:12em" />
        <button class="btn btn-primary" id="hj-pin-save">合言葉を決める</button>
        <span id="hj-pin-status" style="align-self:center;font-size:0.85em;opacity:0.7"></span>
      </div>
    </div>
    <div class="form-group">
      <label>入っている端末（外すと、その端末はもう一度合言葉を打つまで板を見られません）</label>
      <div id="hj-devices" style="font-size:0.9em"></div>
    </div>
  `;
  anchor.after(sec);
  const status = sec.querySelector('#hj-pin-status');
  const render = async () => {
    const res = await fetch(`${API}/settings`, { credentials: 'same-origin' });
    let json = null; try { json = await res.json(); } catch { /* ignore */ }
    const box = sec.querySelector('#hj-devices');
    if (!res.ok || !json || json.error) { box.textContent = json?.error?.message || `読めません（HTTP ${res.status}）`; return; }
    status.textContent = json.data.hasPin ? '合言葉は決めてあります' : '⚠ 合言葉がまだ無いので、タブレットは入れません';
    const list = json.data.devices || [];
    box.innerHTML = list.length ? list.map((d) => `
      <div class="toolbar" style="justify-content:space-between;padding:.25em 0;border-bottom:1px solid rgba(255,255,255,.08)">
        <span>${esc(d.name || '（名前なし）')}${d.me ? ' <em style="opacity:.6">（この端末）</em>' : ''} <span style="opacity:.6">最後 ${esc((d.last_seen_at || d.created_at || '').slice(0, 16).replace('T', ' '))}</span></span>
        ${d.me ? '' : `<button class="btn" data-hj-revoke="${esc(d.id)}">外す</button>`}
      </div>`).join('') : '<span style="opacity:.6">まだ端末は入っていません</span>';
    for (const b of box.querySelectorAll('[data-hj-revoke]')) b.addEventListener('click', async () => {
      if (!confirm('この端末を外しますか？')) return;
      const r = await fetch(`${API}/devices/${encodeURIComponent(b.dataset.hjRevoke)}`, { method: 'DELETE', credentials: 'same-origin' });
      let j = null; try { j = await r.json(); } catch { /* ignore */ }
      if (!r.ok || j?.error) alert(j?.error?.message || `外せませんでした（HTTP ${r.status}）`);
      await render();
    });
  };
  sec.querySelector('#hj-pin-save').addEventListener('click', async () => {
    const pin = sec.querySelector('#hj-pin').value.trim();
    if (!/^[0-9]{4,8}$/.test(pin)) { status.textContent = '4〜8 桁の数字にしてください'; return; }
    const res = await fetch(`${API}/settings`, { method: 'PUT', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pin }) });
    let j = null; try { j = await res.json(); } catch { /* ignore */ }
    if (!res.ok || j?.error) { status.textContent = j?.error?.message || `決められませんでした（HTTP ${res.status}）`; return; }
    rememberPin(pin);
    sec.querySelector('#hj-pin').value = '';
    status.textContent = '合言葉を決めました。タブレットはこの合言葉で入れます';
    await render();
  });
  // 合鍵が付いてから読む（ensureStoreFixed の後）
  const wait = setInterval(async () => { if (isStoreFixed()) { clearInterval(wait); await render(); } }, 500);
}

function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
