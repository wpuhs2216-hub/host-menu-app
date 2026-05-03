// メインビューワー
// 実行環境を html に付与（Capacitor アプリ vs ブラウザ）
const IS_CAPACITOR = !!(globalThis.Capacitor && globalThis.Capacitor.isNativePlatform && globalThis.Capacitor.isNativePlatform());
document.documentElement.classList.add(IS_CAPACITOR ? 'env-app' : 'env-web');

import { loadData, saveData, saveOrder, generateId, loadSettings } from './store.js';
import { getImage, getAllImages, migrateFromLocalStorage } from './imageDB.js';
import { initialSync, startRealtime } from './sync.js';
import * as dlg from './dialog.js';
import { scheduleStartupCheck } from './updateCheck.js';
// 注意: 確定前のキャスト選択（チェック状態）は端末ローカル運用とし、
// selections テーブル同期は main 側では使わない（複数端末で選択が干渉しないように）

// 色 → CSS カラー
const COLOR_HEX = { yellow: '#d4af37', red: '#e26d6d', blue: '#6da5e2', green: '#6ad080' };
const COLOR_ORDER = ['yellow', 'red', 'blue', 'green'];

// 色集合から枠の box-shadow を組み立てる
function buildBoxShadow(colors) {
  if (!colors || colors.length === 0) return '';
  // 表示順を固定して安定させる
  const sorted = COLOR_ORDER.filter((c) => colors.includes(c));
  const map = sorted.map((c) => COLOR_HEX[c]);
  if (map.length === 1) {
    return `inset 0 0 0 4px ${map[0]}`;
  }
  if (map.length === 2) {
    // 上下2分割
    return `inset 0 4px 0 0 ${map[0]}, inset 0 -4px 0 0 ${map[1]}, inset 4px 0 0 0 ${map[0]}, inset -4px 0 0 0 ${map[1]}`;
  }
  if (map.length === 3) {
    return `inset 0 4px 0 0 ${map[0]}, inset 4px 0 0 0 ${map[1]}, inset -4px 0 0 0 ${map[1]}, inset 0 -4px 0 0 ${map[2]}`;
  }
  // 4色: 4辺それぞれ別色
  return `inset 0 4px 0 0 ${map[0]}, inset -4px 0 0 0 ${map[1]}, inset 0 -4px 0 0 ${map[2]}, inset 4px 0 0 0 ${map[3]}`;
}

// === カラーピッカー ===
let pickColor = 'yellow';
const COLOR_VALID = ['yellow', 'red', 'blue', 'green'];

function applyPickColor(c) {
  pickColor = COLOR_VALID.includes(c) ? c : 'yellow';
  // ピッカーボタンの active 切替（DOM のみ参照）
  document.querySelectorAll('.color-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.color === pickColor);
  });
}

// チェックボックスの再計算は、初期化が終わった後に呼ぶ別関数として分離（TDZ 回避）
function refreshAllCheckboxes() {
  document.querySelectorAll('.host-panel').forEach((panel) => {
    const input = panel.querySelector('.cast-checkbox input');
    if (!input) return;
    const id = input.dataset.id;
    const cb = panel.querySelector('.cast-checkbox');
    applyCheckboxStyle(cb, id);
    // バッジ表示条件もピッカー色に依存するため再描画
    updateSelectingBadges(panel, id);
  });
  const fsCb = document.getElementById('fs-checkbox');
  if (fsCb && visibleItems && visibleItems[currentIndex]) {
    applyCheckboxStyle(fsCb, visibleItems[currentIndex].id);
  }
}

// 初期 active 表示だけを最初にやる（DOM のみ参照）
applyPickColor('yellow');

document.getElementById('color-picker')?.addEventListener('click', (e) => {
  const btn = e.target.closest('.color-btn');
  if (!btn || !btn.dataset.color) return;
  applyPickColor(btn.dataset.color);
  refreshAllCheckboxes();
});

const grid = document.getElementById('grid');
const fullscreen = document.getElementById('fullscreen');
const fsImage = document.getElementById('fs-image');
const fsPlaceholder = document.getElementById('fs-placeholder');
const fsTitle = document.getElementById('fs-title');
const fsName = document.getElementById('fs-name');
const fsClose = document.getElementById('fs-close');
const fsCounter = document.getElementById('fs-counter');
const fsSwipeArea = document.getElementById('fs-swipe-area');
const fsNewBadge = document.getElementById('fs-new-badge');
const fsCheckbox = document.getElementById('fs-checkbox');
const fsCheckInput = document.getElementById('fs-check-input');
const confirmBtn = document.getElementById('confirm-btn');
const confirmCount = document.getElementById('confirm-count');
const fsConfirmBtn = document.getElementById('fs-confirm-btn');
const fsConfirmCount = document.getElementById('fs-confirm-count');
const orderModal = document.getElementById('order-modal');
const orderCastList = document.getElementById('order-cast-list');
const headerLogo = document.getElementById('header-logo');

// キャスト判定（nameがあればキャスト）
function isCast(item) { return !!item.name; }

// ルビ付きHTML生成
function rubyHtml(name, ruby) {
  const escaped = escapeHtml(name);
  if (ruby) {
    return `<ruby>${escaped}<rp>(</rp><rt>${escapeHtml(ruby)}</rt><rp>)</rp></ruby>`;
  }
  return escaped;
}

// フォントサイズ設定をCSS変数に反映
function applyFontSettings() {
  const s = loadSettings();
  const root = document.documentElement;
  root.style.setProperty('--name-font-size', s.nameFontSize + 'px');
  root.style.setProperty('--title-font-size', s.titleFontSize + 'px');
  root.style.setProperty('--fs-name-font-size', s.fsNameFontSize + 'px');
  root.style.setProperty('--fs-title-font-size', s.fsTitleFontSize + 'px');
}

// 表示中のアイテム一覧とインデックス
let visibleItems = [];
let currentIndex = 0;

// 画像キャッシュ（id → base64）
let imageCache = {};

// チェック状態（キャストID → 色集合 Set<string>）
const checkedCasts = new Map();
const COLOR_CLASSES = ['color-yellow', 'color-red', 'color-blue', 'color-green', 'color-mixed'];

function getColorsArr(id) {
  const s = checkedCasts.get(id);
  return s ? [...s] : [];
}

function applyPanelStyle(el, id) {
  const colors = getColorsArr(id);
  el.classList.remove(...COLOR_CLASSES);
  // 色バッジを更新
  updateSelectingBadges(el, id);
  if (colors.length === 0) {
    el.classList.remove('checked');
    el.style.boxShadow = '';
    return;
  }
  el.classList.add('checked');
  if (colors.length === 1) {
    el.classList.add(`color-${colors[0]}`);
  } else {
    el.classList.add('color-mixed');
  }
  el.style.boxShadow = buildBoxShadow(colors);
}

const COLOR_LABEL_EN = { yellow: 'Yellow', red: 'Red', blue: 'Blue', green: 'Green' };

// 「Yellow で選択中」のバッジ列をパネル左上に表示
// 表示条件: 複数色 または 現在のピッカーと違う色1つ で選択中の場合のみ
function updateSelectingBadges(el, id) {
  let host = el.querySelector('.selecting-badges');
  if (!host) {
    host = document.createElement('div');
    host.className = 'selecting-badges';
    el.appendChild(host);
  }
  const colors = getColorsArr(id);
  // 単色かつ現在のピッカー色と一致 → 表示しない（通常運用で邪魔にならないように）
  const onlyCurrent = colors.length === 1 && colors[0] === pickColor;
  if (colors.length === 0 || onlyCurrent) { host.innerHTML = ''; return; }
  const sorted = COLOR_ORDER.filter((c) => colors.includes(c));
  host.innerHTML = sorted.map((c) =>
    `<span class="selecting-badge color-${c}">${COLOR_LABEL_EN[c]} で選択中</span>`
  ).join('');
}

function applyCheckboxStyle(cb, id) {
  if (!cb) return;
  const colors = getColorsArr(id);
  const input = cb.querySelector('input');
  // チェック状態は「現在の pickColor がそのキャストに含まれているか」
  const checkedNow = colors.includes(pickColor);
  if (input) input.checked = checkedNow;
  cb.classList.remove(...COLOR_CLASSES);
  // チェックボックスのマーク色は常に現在の pickColor（次の選択色を予告）
  cb.classList.add(`color-${pickColor}`);
}

// === 時計表示 ===
const headerClock = document.getElementById('header-clock');
const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];

function updateClock() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  const w = WEEKDAYS[now.getDay()];
  const h = String(now.getHours()).padStart(2, '0');
  const min = String(now.getMinutes()).padStart(2, '0');
  headerClock.textContent = `${y}/${m}/${d}(${w}) ${h}:${min}`;
}
updateClock();
setInterval(updateClock, 1000);

// === 管理画面への隠しアクセス（時計3回タップ） ===
let tapCount = 0;
let tapTimer = null;
headerClock.addEventListener('click', () => {
  tapCount++;
  clearTimeout(tapTimer);
  if (tapCount >= 3) {
    tapCount = 0;
    window.location.href = 'admin.html';
  } else {
    tapTimer = setTimeout(() => { tapCount = 0; }, 1000);
  }
});

// === メイン描画（非同期：IndexedDBから画像読み込み） ===

async function render() {
  applyFontSettings();
  const data = loadData();

  // 旧データの画像をIndexedDBに移行
  const migrated = await migrateFromLocalStorage(data.items);
  if (migrated) saveData(data);

  // 画像を一括読み込み
  imageCache = await getAllImages();

  grid.innerHTML = '';

  visibleItems = data.items
    .filter((item) => item.visible !== false)
    .sort((a, b) => a.order - b.order);

  visibleItems.forEach((item, i) => {
    const el = document.createElement('div');
    el.className = `host-panel placeholder-bg-${i % 9}`;
    applyPanelStyle(el, item.id);

    const img = imageCache[item.id] || '';
    if (img) {
      const posX = item.imgX ?? 50;
      const posY = item.imgY ?? 50;
      const scale = item.imgScale ?? 100;
      el.innerHTML = `<img class="panel-image" src="${img}" alt="${escapeHtml(item.name || item.label)}" style="object-position:${posX}% ${posY}%;transform:scale(${scale / 100})" />`;
    } else {
      el.innerHTML = `<div class="placeholder">♠</div>`;
    }

    // NEWバッジ
    if (item.isNewFace) {
      el.innerHTML += `<div class="new-badge">NEW</div>`;
    }

    // オーバーレイ（テキストがある場合のみ）
    const hasOverlay = item.name || item.title || item.label;
    if (hasOverlay) {
      const overlayHtml = item.name
        ? `<div class="host-title">${escapeHtml(item.title)}</div>
           <div class="host-name">${rubyHtml(item.name, item.ruby)}</div>`
        : `<div class="host-name label-only">${escapeHtml(item.label)}</div>`;
      el.innerHTML += `<div class="overlay">${overlayHtml}</div>`;
    }

    // 選択不可のキャストはグレーアウト
    const locked = isCast(item) && item.selectable === false;
    if (locked) {
      el.classList.add('panel-locked');
    }

    // キャストパネルのみチェックボックス（選択不可でなければ）
    if (isCast(item) && !locked) {
      const cb = document.createElement('label');
      cb.className = 'cast-checkbox';
      cb.innerHTML = `<input type="checkbox" data-id="${item.id}" /><span class="cb-mark"></span>`;
      applyCheckboxStyle(cb, item.id);
      cb.addEventListener('click', (e) => {
        e.stopPropagation();
        // 自前 toggle: input の自動 toggle を打ち消して、現在の pickColor を加減算する
        e.preventDefault();
        togglePickColor(item.id);
        applyPanelStyle(el, item.id);
        applyCheckboxStyle(cb, item.id);
      });
      el.appendChild(cb);
    }

    // タップで全画面表示
    el.addEventListener('click', () => openFullscreen(i));
    grid.appendChild(el);
  });
}

// pickColor で id の色を toggle（含まれていれば外す、なければ追加）
// 端末ローカルのみ（クラウド同期しない）
function togglePickColor(id) {
  let s = checkedCasts.get(id);
  if (!s) { s = new Set(); checkedCasts.set(id, s); }
  if (s.has(pickColor)) {
    s.delete(pickColor);
    if (s.size === 0) checkedCasts.delete(id);
  } else {
    s.add(pickColor);
  }
  updateConfirmBtn();
}

// === 確定ボタン制御 ===

// 色ピッカーの各ボタンに「その色で選択中の人数」を表示
function updateColorCounts() {
  const counts = { yellow: 0, red: 0, blue: 0, green: 0 };
  for (const s of checkedCasts.values()) {
    for (const c of s) if (c in counts) counts[c]++;
  }
  for (const c of COLOR_ORDER) {
    const el = document.querySelector(`[data-color-count="${c}"]`);
    if (!el) continue;
    el.textContent = counts[c];
    el.classList.toggle('zero', counts[c] === 0);
  }
}

function updateConfirmBtn() {
  updateColorCounts();
  const count = checkedCasts.size;
  // 全キャストの色集合を統合して、1色なら該当色、2色以上は mixed
  const distinctColors = new Set();
  for (const s of checkedCasts.values()) for (const c of s) distinctColors.add(c);
  let stateColor = null;
  if (distinctColors.size === 1) stateColor = [...distinctColors][0];
  else if (distinctColors.size >= 2) stateColor = 'mixed';

  for (const btn of [confirmBtn, fsConfirmBtn]) {
    if (!btn) continue;
    btn.classList.remove(...COLOR_CLASSES, 'color-mixed');
    if (stateColor) btn.classList.add(`color-${stateColor}`);
  }

  if (count > 0) {
    confirmCount.textContent = count;
    confirmBtn.style.display = 'flex';
    fsConfirmCount.textContent = count;
    fsConfirmBtn.style.display = 'flex';
  } else {
    confirmBtn.style.display = 'none';
    fsConfirmBtn.style.display = 'none';
  }
}

// 色ごとにキャストをグルーピング
function groupCastsByColor() {
  const data = loadData();
  const byColor = new Map(); // color -> [{id,name,title}, ...]
  for (const [id, set] of checkedCasts.entries()) {
    const item = data.items.find((x) => x.id === id);
    if (!item) continue;
    for (const c of set) {
      if (!byColor.has(c)) byColor.set(c, []);
      byColor.get(c).push({ id: item.id, name: item.name, title: item.title });
    }
  }
  // 色順を固定
  const ordered = [];
  for (const c of COLOR_ORDER) {
    if (byColor.has(c)) ordered.push({ color: c, casts: byColor.get(c) });
  }
  return ordered;
}

const COLOR_LABEL = COLOR_LABEL_EN;

function openOrderModal() {
  const groups = groupCastsByColor();
  if (groups.length === 0) return;

  const settings = loadSettings();
  const skip = !!settings.skipOrderInput;
  if (skip) {
    // 入力スキップ ON: モーダル出さず即送信（後から admin で編集可能）
    submitOrder();
    return;
  }

  orderCastList.innerHTML = groups.map((g) => `
    <div class="order-color-group color-${g.color}" data-color="${g.color}">
      <div class="order-group-header">
        <span class="order-color-badge color-${g.color}"></span>
        <span class="order-color-label">${COLOR_LABEL[g.color]} グループ（${g.casts.length}名）</span>
      </div>
      <div class="order-group-casts">
        ${g.casts.map((c) => `<div class="order-cast-tag color-${g.color}"><span class="tag-title">${escapeHtml(c.title || '')}</span> ${escapeHtml(c.name)}</div>`).join('')}
      </div>
      <div class="order-group-fields">
        <input type="text" class="og-seat" placeholder="席番号" />
        <input type="text" class="og-name" placeholder="お客様名" />
        <textarea class="og-memo" placeholder="メモ（任意）" rows="2"></textarea>
      </div>
    </div>
  `).join('');

  orderModal.classList.add('active');
}

function submitOrder() {
  const groups = groupCastsByColor();
  if (groups.length === 0) return;

  const settings = loadSettings();
  const skip = !!settings.skipOrderInput;
  const groupEls = orderCastList.querySelectorAll('.order-color-group');
  const now = new Date().toISOString();

  groups.forEach((g) => {
    const el = [...groupEls].find((x) => x.dataset.color === g.color);
    const seat = (skip || !el) ? '' : (el.querySelector('.og-seat')?.value || '').trim();
    const name = (skip || !el) ? '' : (el.querySelector('.og-name')?.value || '').trim();
    const memo = (skip || !el) ? '' : (el.querySelector('.og-memo')?.value || '').trim();

    const order = {
      id: generateId(),
      seat,
      customerName: name,
      memo,
      color: g.color,
      casts: g.casts.map((c) => ({ ...c, color: g.color })),
      createdAt: now,
    };
    saveOrder(order);
  });

  checkedCasts.clear();
  updateConfirmBtn();
  orderModal.classList.remove('active');
  render();
}

confirmBtn.addEventListener('click', openOrderModal);
fsConfirmBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  openOrderModal();
});

// === 確定モーダル ===

document.getElementById('order-submit').addEventListener('click', () => {
  submitOrder();
  dlg.toast('送信しました', { type: 'success' });
});

document.getElementById('order-cancel').addEventListener('click', () => {
  orderModal.classList.remove('active');
});

orderModal.addEventListener('click', (e) => {
  if (e.target === orderModal) orderModal.classList.remove('active');
});

// === 全画面表示（スワイプ＋チェック対応） ===

function openFullscreen(index) {
  currentIndex = index;
  showCurrentItem();
  fullscreen.classList.add('active');
}

function showCurrentItem() {
  const item = visibleItems[currentIndex];
  if (!item) return;

  const img = imageCache[item.id] || '';
  if (img) {
    fsImage.src = img;
    fsImage.style.display = 'block';
    fsPlaceholder.style.display = 'none';
  } else {
    fsImage.style.display = 'none';
    fsPlaceholder.style.display = 'flex';
  }

  fsTitle.textContent = item.title || '';
  if (item.name && item.ruby) {
    fsName.innerHTML = rubyHtml(item.name, item.ruby);
  } else {
    fsName.textContent = item.name || item.label || '';
  }
  fsNewBadge.style.display = item.isNewFace ? 'inline-block' : 'none';
  fsCounter.textContent = '';

  // 矢印ボタンは廃止、スワイプとキーボードで移動

  // 全画面チェックボックス（キャストかつ選択可のみ）
  if (isCast(item) && item.selectable !== false) {
    fsCheckbox.style.display = 'flex';
    applyCheckboxStyle(fsCheckbox, item.id);
  } else {
    fsCheckbox.style.display = 'none';
  }
}

// 全画面チェックボックスの変更（自前 toggle）
fsCheckInput.addEventListener('click', (e) => {
  const item = visibleItems[currentIndex];
  if (!item) return;
  e.preventDefault();
  togglePickColor(item.id);
  applyCheckboxStyle(fsCheckbox, item.id);
  syncGridCheckbox(item.id);
});

function syncGridCheckbox(id) {
  const gridCb = grid.querySelector(`input[data-id="${id}"]`);
  if (!gridCb) return;
  const panel = gridCb.closest('.host-panel');
  const cb = gridCb.closest('.cast-checkbox');
  applyPanelStyle(panel, id);
  applyCheckboxStyle(cb, id);
}

function closeFullscreen() {
  fullscreen.classList.remove('active');
}

fsClose.addEventListener('click', closeFullscreen);

fullscreen.addEventListener('click', (e) => {
  if (e.target === fullscreen) closeFullscreen();
});

// スワイプ操作
let touchStartX = 0;
let touchStartY = 0;
let touchDeltaX = 0;
let swiping = false;

fsSwipeArea.addEventListener('touchstart', (e) => {
  touchStartX = e.touches[0].clientX;
  touchStartY = e.touches[0].clientY;
  touchDeltaX = 0;
  swiping = true;
}, { passive: true });

fsSwipeArea.addEventListener('touchmove', (e) => {
  if (!swiping) return;
  touchDeltaX = e.touches[0].clientX - touchStartX;
  const deltaY = Math.abs(e.touches[0].clientY - touchStartY);
  if (deltaY > Math.abs(touchDeltaX)) { swiping = false; return; }
  fsSwipeArea.style.transform = `translateX(${touchDeltaX}px)`;
}, { passive: true });

fsSwipeArea.addEventListener('touchend', () => {
  if (!swiping) {
    fsSwipeArea.style.transform = '';
    return;
  }
  swiping = false;

  const threshold = 60;
  if (touchDeltaX < -threshold && currentIndex < visibleItems.length - 1) {
    fsSwipeArea.style.transition = 'transform 0.2s ease';
    fsSwipeArea.style.transform = 'translateX(-100%)';
    setTimeout(() => {
      currentIndex++;
      showCurrentItem();
      fsSwipeArea.style.transition = 'none';
      fsSwipeArea.style.transform = '';
    }, 200);
  } else if (touchDeltaX > threshold && currentIndex > 0) {
    fsSwipeArea.style.transition = 'transform 0.2s ease';
    fsSwipeArea.style.transform = 'translateX(100%)';
    setTimeout(() => {
      currentIndex--;
      showCurrentItem();
      fsSwipeArea.style.transition = 'none';
      fsSwipeArea.style.transform = '';
    }, 200);
  } else {
    fsSwipeArea.style.transition = 'transform 0.2s ease';
    fsSwipeArea.style.transform = '';
    setTimeout(() => { fsSwipeArea.style.transition = 'none'; }, 200);
  }
}, { passive: true });

// キーボード操作（PC用）
document.addEventListener('keydown', (e) => {
  if (!fullscreen.classList.contains('active')) return;
  if (e.key === 'ArrowLeft' && currentIndex > 0) { currentIndex--; showCurrentItem(); }
  if (e.key === 'ArrowRight' && currentIndex < visibleItems.length - 1) { currentIndex++; showCurrentItem(); }
  if (e.key === 'Escape') closeFullscreen();
});

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// === 戻るボタン制御 ===
// 全画面・モーダルが開いていれば閉じる、メイン画面では何もしない（アプリ終了防止）
history.pushState(null, '', location.href);
window.addEventListener('popstate', () => {
  if (orderModal.classList.contains('active')) {
    orderModal.classList.remove('active');
  } else if (fullscreen.classList.contains('active')) {
    closeFullscreen();
  }
  history.pushState(null, '', location.href);
});

// 起動時にクラウドから最新を取得 → 反映 → リアルタイム購読
(async () => {
  await render();
  try {
    await initialSync();
    await render();
  } catch (e) {
    console.warn('initialSync 失敗（オフライン継続）', e);
  }
  startRealtime(async () => { await render(); });
  // 確定前のチェック状態は端末ローカルのみで管理する（複数端末で干渉させないため）
  // 起動時自動アップデートチェック（3秒遅延・6時間キャッシュ・新版があればバナー表示）
  scheduleStartupCheck();
})();
