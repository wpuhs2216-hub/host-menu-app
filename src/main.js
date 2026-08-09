// メインビューワー
// 実行環境を html に付与（Capacitor アプリ vs ブラウザ）
const IS_CAPACITOR = !!(globalThis.Capacitor && globalThis.Capacitor.isNativePlatform && globalThis.Capacitor.isNativePlatform());
document.documentElement.classList.add(IS_CAPACITOR ? 'env-app' : 'env-web');

// APK 版: メニュー画面に到達した時点で admin セッションを破棄
// （管理画面 → メニューに戻ったら毎回パスワード入力を要求）
// ※店舗の固定（host-menu-store-id）は別キーなので維持される
if (IS_CAPACITOR) {
  try { localStorage.removeItem('host-menu-admin-session'); } catch { /* ignore */ }
}

import { loadData, saveData, saveOrder, generateId, loadSettings, frameSrc } from './store.js';
import { getImage, getAllImages, migrateFromLocalStorage } from './imageDB.js';
import { initialSync, startRealtime, stopRealtime, forcePull, syncOrderInsert } from './sync.js';
import * as dlg from './dialog.js';
import { scheduleStartupCheck } from './updateCheck.js';
import { ensureStoreFixed } from './storeLogin.js';
import { logoutStore, getStoreName, getStoreId } from './storeContext.js';
import { getSeatOptions, getColorLabel, pullStoreSettings, applyMenuFont } from './storeSettings.js';
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

// 選択リセット: 全クリア + 黄色に戻す + 席もクリア
function resetSelection() {
  checkedCasts.clear();
  applyPickColor('yellow');
  setCurrentSeat('');
  updateConfirmBtn();
  render();
}
document.getElementById('reset-btn')?.addEventListener('click', resetSelection);

// === 席選択 ===
// 卓番リストは店舗設定（storeSettings）から取得する
let currentSeat = '';                  // '' or 'A' or ... or 任意文字列(other)

function setCurrentSeat(seat) {
  currentSeat = seat || '';
  const btn = document.getElementById('seat-btn');
  if (btn) {
    btn.textContent = currentSeat ? `席：${currentSeat}` : '席：未選択';
    btn.classList.toggle('seat-selected', !!currentSeat);
  }
}

async function openSeatPicker() {
  // 「未選択 / 卓番リスト / その他(自由入力) / 解除」を縦リストで表示
  return new Promise((resolve) => {
    // ダイアログホストを利用（dialog.js の代替実装）
    const seatOptions = getSeatOptions();
    const root = document.createElement('div');
    root.className = 'seat-picker-host';
    root.innerHTML = `
      <div class="seat-picker-backdrop">
        <div class="seat-picker-box">
          <h3 class="seat-picker-title">席を選択</h3>
          <div class="seat-options">
            ${seatOptions.map((s, i) => `<button class="seat-option ${currentSeat === s ? 'active' : ''}" data-seat-index="${i}">${escapeHtml(s)}</button>`).join('')}
            <button class="seat-option seat-other" data-action="other">その他…</button>
          </div>
          <div class="seat-picker-actions">
            <button class="btn btn-secondary" data-action="clear">未選択にする</button>
            <button class="btn btn-secondary" data-action="cancel">キャンセル</button>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(root);
    const finish = (val) => { root.remove(); resolve(val); };
    root.addEventListener('click', async (e) => {
      const btn = e.target.closest('button');
      if (!btn) {
        if (e.target.classList.contains('seat-picker-backdrop')) finish(undefined);
        return;
      }
      if (btn.dataset.seatIndex !== undefined) return finish(seatOptions[Number(btn.dataset.seatIndex)] || '');
      if (btn.dataset.action === 'clear') return finish('');
      if (btn.dataset.action === 'cancel') return finish(undefined);
      if (btn.dataset.action === 'other') {
        root.remove();
        const v = await dlg.prompt('席番号（自由入力）', currentSeat || '', { title: '席を入力' });
        if (v === null) return resolve(undefined);
        return resolve(v.trim());
      }
    });
  });
}

document.getElementById('seat-btn')?.addEventListener('click', async () => {
  const v = await openSeatPicker();
  if (v === undefined) return; // キャンセル
  setCurrentSeat(v);
});

// 初期描画
setCurrentSeat('');

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
const fsThumbs = document.getElementById('fs-thumbs');
const confirmBtn = document.getElementById('confirm-btn');
const confirmCount = document.getElementById('confirm-count');
const fsConfirmBtn = document.getElementById('fs-confirm-btn');
const fsConfirmCount = document.getElementById('fs-confirm-count');
const orderModal = document.getElementById('order-modal');
const orderCastList = document.getElementById('order-cast-list');
const headerLogo = document.getElementById('header-logo');

// キャスト判定（nameがあればキャスト）
function isCast(item) { return !!item.name; }

// 選択不可パネル（拡大・スワイプ対象から除外する）
function isLockedItem(item) { return isCast(item) && item.selectable === false; }

// start から dir 方向で最初の「拡大可能（選択不可でない）」インデックスを返す。無ければ -1
function findViewableIndex(start, dir) {
  for (let i = start; i >= 0 && i < visibleItems.length; i += dir) {
    if (!isLockedItem(visibleItems[i])) return i;
  }
  return -1;
}

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

// 色ラベルは店舗設定（storeSettings.getColorLabel）から取得する
// 色ピッカーの各ボタン下にラベル（壁側/通路側など）を表示
function applyColorPickerLabels() {
  document.querySelectorAll('#color-picker .color-btn').forEach((btn) => {
    const c = btn.dataset.color;
    if (!c) return;
    const label = getColorLabel(c);
    btn.title = label;
    btn.setAttribute('aria-label', label);
    const labelEl = btn.parentElement?.querySelector('.color-btn-label');
    if (labelEl) labelEl.textContent = label;
  });
}
applyColorPickerLabels();
// キャッシュ済みフォントを即適用（クラウド取得前でも反映）
applyMenuFont();

// 「壁側 で選択中」のバッジ列をパネル左上に表示
// 選択があるパネルには常に表示する（一覧でどの色ラベルか一目で分かるように）
function updateSelectingBadges(el, id) {
  let host = el.querySelector('.selecting-badges');
  if (!host) {
    host = document.createElement('div');
    host.className = 'selecting-badges';
    el.appendChild(host);
  }
  const colors = getColorsArr(id);
  if (colors.length === 0) { host.innerHTML = ''; return; }
  const sorted = COLOR_ORDER.filter((c) => colors.includes(c));
  host.innerHTML = sorted.map((c) =>
    `<span class="selecting-badge color-${c}">${escapeHtml(getColorLabel(c))} で選択中</span>`
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

// === 同意書ボタン（設定でオンの時だけメニューに出す） ===
function initConsentEntry() {
  const btn = document.getElementById('consent-entry');
  if (!btn) return;
  if (!loadSettings().consentMenuButton) {
    btn.style.display = 'none';
    return;
  }
  btn.style.display = '';
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    try {
      const mod = await import('./consent.js');
      // メニュー画面からの署名は本番運用の記録として残す（設定画面からのものはテスト扱い）
      await mod.openConsentDialog({ isTest: false });
    } catch (err) {
      dlg.alert(`同意書画面を開けませんでした。\n${err?.message || err}`, { title: 'エラー' });
    } finally {
      btn.disabled = false;
    }
  });
}

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
      el.innerHTML = `<img class="panel-image" src="${img}" alt="${escapeHtml(item.name || item.label)}" style="object-position:${posX}% ${posY}%;transform-origin:${posX}% ${posY}%;transform:scale(${scale / 100})" />`;
    } else {
      el.innerHTML = `<div class="placeholder">♠</div>`;
    }

    // サムネフレーム（金/銀/銅）
    if (frameSrc(item.frame)) {
      el.innerHTML += `<img class="panel-frame" src="${frameSrc(item.frame)}" alt="" />`;
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

    // タップで全画面表示（選択不可パネルは拡大しない）
    if (!locked) {
      el.addEventListener('click', () => openFullscreen(i));
    }
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
  // ボタン数字は「色の合計数」: 1キャストが2色なら2、3色なら3とカウント
  let totalSelections = 0;
  for (const s of checkedCasts.values()) totalSelections += s.size;
  const count = totalSelections;
  // 選択あり/なし状態を body に反映（CSS でピッカー・リセットボタンの表示制御）
  document.body.classList.toggle('has-selection', count > 0);
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
        <span class="order-color-label">${escapeHtml(getColorLabel(g.color))} グループ（${g.casts.length}名）</span>
      </div>
      <div class="order-group-casts">
        ${g.casts.map((c) => `<div class="order-cast-tag color-${g.color}"><span class="tag-title">${escapeHtml(c.title || '')}</span> ${escapeHtml(c.name)}</div>`).join('')}
      </div>
      <div class="order-group-fields">
        <input type="text" class="og-seat" placeholder="席番号" value="${escapeHtml(currentSeat || '')}" />
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

  const isPreview = document.body.classList.contains('is-preview');
  const source = isPreview ? 'preview' : 'main';
  groups.forEach((g) => {
    const el = [...groupEls].find((x) => x.dataset.color === g.color);
    // スキップ時 or モーダル要素が無いときは、ヘッダで選択した席をそのまま使う
    const seat = (skip || !el) ? (currentSeat || '') : (el.querySelector('.og-seat')?.value || '').trim();
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
      source,
    };
    saveOrder(order);                       // ローカルにも保存（オフラインキャッシュ）
    syncOrderInsert(order, source).catch(() => {});  // Supabase へ送信（プレビュー含む全送信）
  });

  checkedCasts.clear();
  applyPickColor('yellow');
  setCurrentSeat('');
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

document.getElementById('order-submit').addEventListener('click', async () => {
  submitOrder();
  await dlg.alert('送信しました', { title: '完了', okLabel: 'OK' });
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

// 全画面で表示する画像リスト（メイン + 追加画像）を組み立てる
let fsImages = [];
let fsImgIndex = 0;

function fsImageList(item) {
  const list = [];
  if (imageCache[item.id]) list.push({ key: item.id, src: imageCache[item.id] });
  for (const e of (item.extraImages || [])) {
    const src = imageCache[e.key];
    if (src) list.push({ key: e.key, src });
  }
  return list;
}

function renderFsImage() {
  resetZoom();
  if (fsImages.length > 0) {
    fsImage.src = fsImages[fsImgIndex]?.src || fsImages[0].src;
    fsImage.style.display = 'block';
    fsPlaceholder.style.display = 'none';
  } else {
    fsImage.style.display = 'none';
    fsPlaceholder.style.display = 'flex';
  }
}

function renderFsThumbs() {
  if (!fsThumbs) return;
  if (fsImages.length <= 1) { fsThumbs.style.display = 'none'; fsThumbs.innerHTML = ''; return; }
  fsThumbs.style.display = 'flex';
  fsThumbs.innerHTML = fsImages.map((im, i) =>
    `<button class="fs-thumb ${i === fsImgIndex ? 'active' : ''}" data-thumb-index="${i}"><img src="${im.src}" alt="" /></button>`
  ).join('');
}

fsThumbs?.addEventListener('click', (e) => {
  const btn = e.target.closest('.fs-thumb');
  if (!btn) return;
  e.stopPropagation();
  fsImgIndex = Number(btn.dataset.thumbIndex) || 0;
  renderFsImage();
  fsThumbs.querySelectorAll('.fs-thumb').forEach((b, i) => b.classList.toggle('active', i === fsImgIndex));
});

function showCurrentItem() {
  const item = visibleItems[currentIndex];
  if (!item) return;

  fsImages = fsImageList(item);
  fsImgIndex = 0;
  renderFsImage();
  renderFsThumbs();

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
// 注意: リスナーは input ではなく label に付ける。input の click を preventDefault すると
// ブラウザがイベント処理後に checked を巻き戻し、ハンドラ内の代入が消えるため
fsCheckbox.addEventListener('click', (e) => {
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
  resetZoom();
  fullscreen.classList.remove('active');
}

fsClose.addEventListener('click', closeFullscreen);

fullscreen.addEventListener('click', (e) => {
  if (e.target === fullscreen) closeFullscreen();
});

// === ピンチズーム ===
// transform は translate → scale の順（origin は画像中央）。
// 画面座標 = 画像中央 + translate + scale × 画像内オフセット の関係を使って焦点を維持する
let zoomScale = 1;
let zoomX = 0;
let zoomY = 0;
let pinching = false;
let pinchStartDist = 0;
let pinchStartScale = 1;
let pinchStartMid = { x: 0, y: 0 };
let pinchStartZoom = { x: 0, y: 0 };
let panning = false;
let panStart = { x: 0, y: 0, zx: 0, zy: 0 };
let lastTapTime = 0;
let lastTapPos = { x: 0, y: 0 };

const ZOOM_MAX = 4;

function applyZoom() {
  fsImage.style.transform = (zoomScale === 1 && zoomX === 0 && zoomY === 0)
    ? '' : `translate(${zoomX}px, ${zoomY}px) scale(${zoomScale})`;
}

function resetZoom() {
  fsImage.style.transition = '';
  resetZoomKeepTransition();
}

function resetZoomKeepTransition() {
  zoomScale = 1;
  zoomX = 0;
  zoomY = 0;
  applyZoom();
}

// 画像が画面外に飛ばないよう translate をクランプ（余白が出る軸は中央固定）
function clampZoomPan() {
  const rect = fsSwipeArea.getBoundingClientRect();
  const maxX = Math.max(0, (fsImage.clientWidth * zoomScale - rect.width) / 2);
  const maxY = Math.max(0, (fsImage.clientHeight * zoomScale - rect.height) / 2);
  zoomX = Math.min(maxX, Math.max(-maxX, zoomX));
  zoomY = Math.min(maxY, Math.max(-maxY, zoomY));
}

function touchDist(touches) {
  const dx = touches[0].clientX - touches[1].clientX;
  const dy = touches[0].clientY - touches[1].clientY;
  return Math.hypot(dx, dy);
}

// コンテナ中央を原点としたタッチ座標
function relPoint(clientX, clientY) {
  const rect = fsSwipeArea.getBoundingClientRect();
  return { x: clientX - rect.left - rect.width / 2, y: clientY - rect.top - rect.height / 2 };
}

function touchMid(touches) {
  return relPoint(
    (touches[0].clientX + touches[1].clientX) / 2,
    (touches[0].clientY + touches[1].clientY) / 2
  );
}

// スワイプ操作
let touchStartX = 0;
let touchStartY = 0;
let touchDeltaX = 0;
let swiping = false;

fsSwipeArea.addEventListener('touchstart', (e) => {
  if (e.touches.length >= 2) {
    // ピンチ開始（スワイプ中だったら位置を戻す）
    swiping = false;
    panning = false;
    fsSwipeArea.style.transition = 'none';
    fsSwipeArea.style.transform = '';
    fsImage.style.transition = '';
    pinching = true;
    pinchStartDist = touchDist(e.touches);
    pinchStartScale = zoomScale;
    pinchStartMid = touchMid(e.touches);
    pinchStartZoom = { x: zoomX, y: zoomY };
    return;
  }
  if (zoomScale > 1) {
    // 拡大中は1本指でパン
    panning = true;
    panStart = { x: e.touches[0].clientX, y: e.touches[0].clientY, zx: zoomX, zy: zoomY };
    return;
  }
  touchStartX = e.touches[0].clientX;
  touchStartY = e.touches[0].clientY;
  touchDeltaX = 0;
  swiping = true;
}, { passive: true });

fsSwipeArea.addEventListener('touchmove', (e) => {
  if (pinching && e.touches.length >= 2) {
    e.preventDefault();
    const s = Math.min(ZOOM_MAX, Math.max(1, pinchStartScale * (touchDist(e.touches) / pinchStartDist)));
    const mid = touchMid(e.touches);
    // ピンチ開始時に中点が指していた画像上の点を、移動後の中点に一致させ続ける
    zoomX = mid.x - (pinchStartMid.x - pinchStartZoom.x) * (s / pinchStartScale);
    zoomY = mid.y - (pinchStartMid.y - pinchStartZoom.y) * (s / pinchStartScale);
    zoomScale = s;
    clampZoomPan();
    applyZoom();
    return;
  }
  if (panning && e.touches.length === 1) {
    e.preventDefault();
    zoomX = panStart.zx + (e.touches[0].clientX - panStart.x);
    zoomY = panStart.zy + (e.touches[0].clientY - panStart.y);
    clampZoomPan();
    applyZoom();
    return;
  }
  if (!swiping) return;
  touchDeltaX = e.touches[0].clientX - touchStartX;
  const deltaY = Math.abs(e.touches[0].clientY - touchStartY);
  if (deltaY > Math.abs(touchDeltaX)) { swiping = false; return; }
  fsSwipeArea.style.transform = `translateX(${touchDeltaX}px)`;
}, { passive: false });

fsSwipeArea.addEventListener('touchend', (e) => {
  if (pinching) {
    if (e.touches.length >= 2) return;
    pinching = false;
    if (zoomScale <= 1.01) {
      resetZoom();
    } else if (e.touches.length === 1) {
      // 残った指でそのままパンに移行
      panning = true;
      panStart = { x: e.touches[0].clientX, y: e.touches[0].clientY, zx: zoomX, zy: zoomY };
    }
    return;
  }
  if (panning) {
    if (e.touches.length === 0) panning = false;
    // 拡大中でも動いていないタップはダブルタップ判定（等倍へ戻す）
    if (e.changedTouches.length === 1) {
      const t = e.changedTouches[0];
      const moved = Math.hypot(t.clientX - panStart.x, t.clientY - panStart.y);
      if (moved < 10) {
        const now = Date.now();
        const nearLast = Math.hypot(t.clientX - lastTapPos.x, t.clientY - lastTapPos.y) < 40;
        if (now - lastTapTime < 300 && nearLast) {
          lastTapTime = 0;
          fsImage.style.transition = 'transform 0.2s ease';
          resetZoomKeepTransition();
          setTimeout(() => { fsImage.style.transition = ''; }, 200);
          return;
        }
        lastTapTime = now;
        lastTapPos = { x: t.clientX, y: t.clientY };
      }
    }
    return;
  }

  // ダブルタップで拡大⇔等倍（ほぼ動いていないタップのみ対象）
  if (swiping && Math.abs(touchDeltaX) < 10 && e.changedTouches.length === 1) {
    const t = e.changedTouches[0];
    const now = Date.now();
    const nearLast = Math.hypot(t.clientX - lastTapPos.x, t.clientY - lastTapPos.y) < 40;
    if (now - lastTapTime < 300 && nearLast) {
      lastTapTime = 0;
      swiping = false;
      fsSwipeArea.style.transform = '';
      fsImage.style.transition = 'transform 0.2s ease';
      if (zoomScale > 1) {
        zoomScale = 1;
        zoomX = 0;
        zoomY = 0;
      } else {
        const p = relPoint(t.clientX, t.clientY);
        zoomScale = 2.5;
        zoomX = p.x * (1 - zoomScale);
        zoomY = p.y * (1 - zoomScale);
        clampZoomPan();
      }
      applyZoom();
      setTimeout(() => { fsImage.style.transition = ''; }, 200);
      return;
    }
    lastTapTime = now;
    lastTapPos = { x: t.clientX, y: t.clientY };
  }

  if (!swiping) {
    fsSwipeArea.style.transform = '';
    return;
  }
  swiping = false;

  const threshold = 60;
  // 選択不可パネルはスキップして次/前の拡大可能パネルへ
  const nextIdx = touchDeltaX < -threshold ? findViewableIndex(currentIndex + 1, +1) : -1;
  const prevIdx = touchDeltaX > threshold ? findViewableIndex(currentIndex - 1, -1) : -1;
  if (nextIdx !== -1) {
    fsSwipeArea.style.transition = 'transform 0.2s ease';
    fsSwipeArea.style.transform = 'translateX(-100%)';
    setTimeout(() => {
      currentIndex = nextIdx;
      showCurrentItem();
      fsSwipeArea.style.transition = 'none';
      fsSwipeArea.style.transform = '';
    }, 200);
  } else if (prevIdx !== -1) {
    fsSwipeArea.style.transition = 'transform 0.2s ease';
    fsSwipeArea.style.transform = 'translateX(100%)';
    setTimeout(() => {
      currentIndex = prevIdx;
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
  if (e.key === 'ArrowLeft') {
    const p = findViewableIndex(currentIndex - 1, -1);
    if (p !== -1) { currentIndex = p; showCurrentItem(); }
  }
  if (e.key === 'ArrowRight') {
    const n = findViewableIndex(currentIndex + 1, +1);
    if (n !== -1) { currentIndex = n; showCurrentItem(); }
  }
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
  // 店舗が未固定なら、まずパスワードで店舗を固定する（固定されるまでここで待つ）
  await ensureStoreFixed();
  // ヘッダーのブランディング: GENTLY DIVA のみロゴ画像、他店舗は店舗名テキスト
  if (headerLogo && getStoreId() !== 'gently-diva') {
    headerLogo.innerHTML = '';
    const span = document.createElement('span');
    span.className = 'header-store-name';
    span.textContent = getStoreName();
    headerLogo.appendChild(span);
  }
  // 店舗設定（卓番・色ラベル）をクラウドから取得して反映（失敗時はローカルキャッシュで継続）
  try {
    await pullStoreSettings();
  } catch (e) {
    console.warn('店舗設定取得失敗（キャッシュ継続）', e);
  }
  applyColorPickerLabels();
  applyMenuFont();
  initConsentEntry();
  await render();
  try {
    await initialSync();
    await render();
  } catch (e) {
    console.warn('initialSync 失敗（オフライン継続）', e);
  }
  startRealtime(async () => { await render(); });
  // 確定前のチェック状態は端末ローカルのみで管理する（複数端末で干渉させないため）
  // 起動時自動アップデートチェック（APK アップデートはアプリ版のみ）
  if (IS_CAPACITOR) scheduleStartupCheck();
})();

// === 復帰時の自動同期（ロック解除/アプリ切替戻り） ===
// 画面が見える状態に戻った際にクラウドから最新を引いて反映し、Realtime を貼り直す
let resyncInFlight = false;
async function resyncFromCloud({ silent = true } = {}) {
  if (resyncInFlight) return;
  resyncInFlight = true;
  try {
    try { await pullStoreSettings(); applyColorPickerLabels(); applyMenuFont(); } catch { /* 設定取得失敗は無視 */ }
    await forcePull();
    await render();
    stopRealtime();
    startRealtime(async () => { await render(); });
    if (!silent) {
      await dlg.alert('送信しました', { title: '完了', okLabel: 'OK' });
    }
  } catch (e) {
    console.warn('再同期失敗', e);
    if (!silent) {
      await dlg.alert('同期に失敗しました\n' + (e?.message || e), { title: 'エラー', okLabel: 'OK' });
    }
  } finally {
    resyncInFlight = false;
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    resyncFromCloud({ silent: true });
  }
});
window.addEventListener('pageshow', () => { resyncFromCloud({ silent: true }); });

// Capacitor の App プラグインがあれば resume イベントでも同期
if (IS_CAPACITOR) {
  try {
    const App = globalThis.Capacitor?.Plugins?.App;
    if (App?.addListener) {
      App.addListener('appStateChange', ({ isActive }) => {
        if (isActive) resyncFromCloud({ silent: true });
      });
      App.addListener('resume', () => { resyncFromCloud({ silent: true }); });
    }
  } catch { /* ignore */ }
}

// === 店舗ロゴ：手動同期ボタン ===
if (headerLogo) {
  headerLogo.style.cursor = 'pointer';
  headerLogo.addEventListener('click', async () => {
    const ok = await dlg.confirm('クラウドから最新データを取得しますか？', {
      title: '同期',
      okLabel: '送信',
      cancelLabel: 'キャンセル',
    });
    if (!ok) return;
    await resyncFromCloud({ silent: false });
  });

  // ロゴ長押し（800ms）で店舗ログアウト（＝店舗切り替え）
  let logoLongPressTimer = null;
  let logoLongPressed = false;
  const startLogoPress = () => {
    logoLongPressed = false;
    logoLongPressTimer = setTimeout(async () => {
      logoLongPressed = true;
      const ok = await dlg.confirm(
        `この端末（${getStoreName()}）からログアウトして店舗を切り替えますか？`,
        { title: '店舗ログアウト', okLabel: 'ログアウト', cancelLabel: 'キャンセル' }
      );
      if (!ok) return;
      logoutStore();
      window.location.reload();
    }, 800);
  };
  const cancelLogoPress = () => {
    if (logoLongPressTimer) { clearTimeout(logoLongPressTimer); logoLongPressTimer = null; }
  };
  headerLogo.addEventListener('touchstart', startLogoPress, { passive: true });
  headerLogo.addEventListener('touchend', cancelLogoPress);
  headerLogo.addEventListener('touchmove', cancelLogoPress, { passive: true });
  headerLogo.addEventListener('mousedown', startLogoPress);
  headerLogo.addEventListener('mouseup', cancelLogoPress);
  headerLogo.addEventListener('mouseleave', cancelLogoPress);
  // 長押し成立時はクリック（同期確認）を抑制
  headerLogo.addEventListener('click', (e) => {
    if (logoLongPressed) { e.stopImmediatePropagation(); e.preventDefault(); logoLongPressed = false; }
  }, true);
}
