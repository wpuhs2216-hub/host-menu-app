// 端末ロック認証（テンキー / 9点パターン）
// - スタッフ以外に操作させたくない場面（同意書の完了画面を閉じる・パネル送信）で使う
// - パターン未設定なら「テンキーで店舗パスワード」、設定済みなら「9点パターン」で解錠する
// - パターンは端末ごとの設定（localStorage）。管理画面から登録・解除する

import './lockAuth.css';
import { getStorePassword } from './storeContext.js';
import { loadSettings, saveSettings } from './store.js';

// パターンは "0-1-2-5-8" の形（左上=0 … 右下=8）で保存する
export function getLockPattern() {
  return loadSettings().lockPattern || '';
}

export function hasLockPattern() {
  return !!getLockPattern();
}

export function setLockPattern(pattern) {
  const s = loadSettings();
  s.lockPattern = pattern || '';
  saveSettings(s);
}

export function clearLockPattern() {
  setLockPattern('');
}

// パターンの最低点数（これ未満は簡単すぎるので登録させない）
export const MIN_PATTERN_POINTS = 4;

function buildOverlay(inner) {
  const overlay = document.createElement('div');
  overlay.className = 'lock-overlay';
  overlay.innerHTML = `<div class="lock-box" role="dialog" aria-modal="true">${inner}</div>`;
  document.body.appendChild(overlay);
  return overlay;
}

function shake(box) {
  box.classList.remove('lock-shake');
  void box.offsetWidth;          // アニメーションを再生し直すための強制リフロー
  box.classList.add('lock-shake');
}

// === テンキー ===
// verify(入力値) が true を返したら解錠。cancelable=false ならキャンセルを出さない
export function openKeypad({ title, message, verify, okLabel = 'OK', cancelable = true }) {
  return new Promise((resolve) => {
    const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];
    const overlay = buildOverlay(`
      <h3 class="lock-title">${title}</h3>
      ${message ? `<p class="lock-msg">${message}</p>` : ''}
      <div class="lock-dots" id="lock-dots"></div>
      <div class="lock-keys">
        ${keys.map((k) => `<button type="button" class="lock-key" data-key="${k}">${k}</button>`).join('')}
        <button type="button" class="lock-key lock-key-sub" id="lock-back">⌫</button>
        <button type="button" class="lock-key" data-key="0">0</button>
        <button type="button" class="lock-key lock-key-ok" id="lock-ok">${okLabel}</button>
      </div>
      ${cancelable ? '<button type="button" class="lock-cancel" id="lock-cancel">キャンセル</button>' : ''}
    `);
    const box = overlay.querySelector('.lock-box');
    const dotsEl = overlay.querySelector('#lock-dots');
    let buf = '';

    const renderDots = () => {
      dotsEl.innerHTML = buf ? [...buf].map(() => '<span class="lock-dot filled"></span>').join('') : '<span class="lock-dot-empty">パスワードを入力</span>';
    };
    renderDots();

    const close = (ok) => { overlay.remove(); resolve(ok); };

    const submit = async () => {
      if (!buf) return;
      if (await verify(buf)) { close(true); return; }
      buf = '';
      renderDots();
      shake(box);
    };

    overlay.addEventListener('click', (e) => {
      const key = e.target.closest('.lock-key')?.dataset.key;
      if (key != null) {
        if (buf.length < 12) { buf += key; renderDots(); }
        return;
      }
      if (e.target.closest('#lock-back')) { buf = buf.slice(0, -1); renderDots(); return; }
      if (e.target.closest('#lock-ok')) { submit(); return; }
      if (e.target.closest('#lock-cancel')) close(false);
    });
  });
}

// === 9点パターン ===
// onDone(pattern) が false を返した場合は入力欄をリセットして続行する（登録の1回目→2回目で使う）
function openPatternInput({ title, message, verify, fallbackLabel = '' }) {
  return new Promise((resolve) => {
    const overlay = buildOverlay(`
      <h3 class="lock-title">${title}</h3>
      <p class="lock-msg" id="lock-msg">${message || ''}</p>
      <div class="lock-pattern" id="lock-pattern">
        <svg class="lock-lines" id="lock-lines" viewBox="0 0 300 300" preserveAspectRatio="none">
          <polyline id="lock-poly" points="" />
        </svg>
        ${Array.from({ length: 9 }, (_, i) => `<div class="lock-node" data-node="${i}"><span></span></div>`).join('')}
      </div>
      ${fallbackLabel ? `<button type="button" class="lock-fallback" id="lock-fallback">${fallbackLabel}</button>` : ''}
      <button type="button" class="lock-cancel" id="lock-cancel">キャンセル</button>
    `);
    const box = overlay.querySelector('.lock-box');
    const pad = overlay.querySelector('#lock-pattern');
    const poly = overlay.querySelector('#lock-poly');
    const msgEl = overlay.querySelector('#lock-msg');
    const nodes = [...overlay.querySelectorAll('.lock-node')];

    let picked = [];
    let drawing = false;

    const close = (ok) => {
      window.removeEventListener('pointerup', onUp);
      overlay.remove();
      resolve(ok);
    };

    // 点の中心座標（viewBox 300x300 に正規化）
    const nodeCenter = (i) => ({ x: (i % 3) * 100 + 50, y: Math.floor(i / 3) * 100 + 50 });

    const redraw = (cursor) => {
      const pts = picked.map(nodeCenter).map((p) => `${p.x},${p.y}`);
      if (cursor) pts.push(`${cursor.x},${cursor.y}`);
      poly.setAttribute('points', pts.join(' '));
      nodes.forEach((n, i) => n.classList.toggle('on', picked.includes(i)));
    };

    const reset = () => { picked = []; redraw(); };

    // 通過した点を拾う（間に挟まった未選択の点も Android と同じように拾う）
    const addNode = (i) => {
      if (picked.includes(i)) return;
      const prev = picked[picked.length - 1];
      if (prev != null) {
        const mid = (prev + i) / 2;
        const sameRow = Math.floor(prev / 3) === Math.floor(i / 3);
        const sameCol = prev % 3 === i % 3;
        const diagonal = Math.abs(prev % 3 - i % 3) === 2 && Math.abs(Math.floor(prev / 3) - Math.floor(i / 3)) === 2;
        if ((sameRow || sameCol || diagonal) && Number.isInteger(mid) && !picked.includes(mid)) picked.push(mid);
      }
      picked.push(i);
    };

    // 座標 → 点のインデックス（少し広めに当たり判定を取る）
    const hitNode = (clientX, clientY) => {
      const r = pad.getBoundingClientRect();
      const x = ((clientX - r.left) / r.width) * 300;
      const y = ((clientY - r.top) / r.height) * 300;
      for (let i = 0; i < 9; i++) {
        const c = nodeCenter(i);
        if (Math.hypot(x - c.x, y - c.y) <= 38) return i;
      }
      return null;
    };

    const toLocal = (e) => {
      const r = pad.getBoundingClientRect();
      return { x: ((e.clientX - r.left) / r.width) * 300, y: ((e.clientY - r.top) / r.height) * 300 };
    };

    pad.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      drawing = true;
      picked = [];
      const i = hitNode(e.clientX, e.clientY);
      if (i != null) addNode(i);
      redraw(toLocal(e));
    });

    pad.addEventListener('pointermove', (e) => {
      if (!drawing) return;
      e.preventDefault();
      const i = hitNode(e.clientX, e.clientY);
      if (i != null) addNode(i);
      redraw(picked.length ? toLocal(e) : null);
    });

    const onUp = async () => {
      if (!drawing) return;
      drawing = false;
      redraw();
      if (picked.length === 0) return;
      const result = await verify(picked.join('-'), { setMessage: (t) => { msgEl.textContent = t; } });
      if (result === true) { close(true); return; }
      // 'again' は「1回目を受け付けたので、もう一度なぞって」の意味（誤りではないので揺らさない）
      if (result === 'again') { setTimeout(reset, 220); return; }
      shake(box);
      setTimeout(reset, 220);
    };
    window.addEventListener('pointerup', onUp);

    overlay.querySelector('#lock-cancel').addEventListener('click', () => close(false));
    overlay.querySelector('#lock-fallback')?.addEventListener('click', () => close('fallback'));
  });
}

// === 解錠（呼び出し側はこれだけ使う） ===
// パターン設定済み → パターン入力 / 未設定 → テンキーで店舗パスワード
export async function requireUnlock({ title = 'スタッフ確認', message = '', allowPassword = false } = {}) {
  const pattern = getLockPattern();
  const expected = getStorePassword();
  if (pattern) {
    // allowPassword: パターンを忘れても店舗パスワードで入れる逃げ道を出す（管理画面ログイン用）
    const r = await openPatternInput({
      title,
      message: message || 'パターンをなぞってください',
      verify: (input) => input === pattern,
      fallbackLabel: (allowPassword && expected) ? '店舗パスワードで入る' : '',
    });
    if (r !== 'fallback') return r === true;
  }
  if (!expected) return true;                    // 店舗未固定など、照合できない時は素通し
  return openKeypad({
    title,
    message: message || 'スタッフの方が店舗パスワードを入力してください。',
    verify: (v) => v === expected,
  });
}

// === パターンの登録（管理画面から呼ぶ。2回なぞって一致したら保存） ===
export function openPatternSetup() {
  let first = '';
  return openPatternInput({
    title: 'パターンを登録',
    message: `${MIN_PATTERN_POINTS}点以上をなぞってください`,
    verify: (input, { setMessage }) => {
      if (!first) {
        if (input.split('-').length < MIN_PATTERN_POINTS) {
          setMessage(`${MIN_PATTERN_POINTS}点以上つなげてください`);
          return false;
        }
        first = input;
        setMessage('確認のため、もう一度同じパターンをなぞってください');
        return 'again';
      }
      if (input !== first) {
        first = '';
        setMessage(`一致しません。もう一度、${MIN_PATTERN_POINTS}点以上をなぞってください`);
        return false;
      }
      setLockPattern(input);
      return true;
    },
  });
}
