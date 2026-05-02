// メインビューワー
import { loadData, saveData, saveOrder, generateId, loadSettings } from './store.js';
import { getImage, getAllImages, migrateFromLocalStorage } from './imageDB.js';
import { initialSync, startRealtime } from './sync.js';

const grid = document.getElementById('grid');
const fullscreen = document.getElementById('fullscreen');
const fsImage = document.getElementById('fs-image');
const fsPlaceholder = document.getElementById('fs-placeholder');
const fsTitle = document.getElementById('fs-title');
const fsName = document.getElementById('fs-name');
const fsClose = document.getElementById('fs-close');
const fsPrev = document.getElementById('fs-prev');
const fsNext = document.getElementById('fs-next');
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
const orderSeat = document.getElementById('order-seat');
const orderName = document.getElementById('order-name');
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

// チェック状態（キャストID → boolean）
const checkedCasts = new Map();

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
    window.location.href = '/admin.html';
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
    if (checkedCasts.has(item.id)) el.classList.add('checked');

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
      cb.innerHTML = `<input type="checkbox" data-id="${item.id}" ${checkedCasts.has(item.id) ? 'checked' : ''} /><span class="cb-mark"></span>`;
      cb.addEventListener('click', (e) => e.stopPropagation());
      cb.querySelector('input').addEventListener('change', (e) => {
        toggleCheck(item.id, e.target.checked);
        el.classList.toggle('checked', e.target.checked);
      });
      el.appendChild(cb);
    }

    // タップで全画面表示
    el.addEventListener('click', () => openFullscreen(i));
    grid.appendChild(el);
  });
}

function toggleCheck(id, checked) {
  if (checked) {
    checkedCasts.set(id, true);
  } else {
    checkedCasts.delete(id);
  }
  updateConfirmBtn();
}

// === 確定ボタン制御 ===

function updateConfirmBtn() {
  const count = checkedCasts.size;
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

function openOrderModal() {
  const data = loadData();
  const selected = data.items.filter((item) => checkedCasts.has(item.id));
  orderCastList.innerHTML = selected
    .map((c) => `<div class="order-cast-tag"><span class="tag-title">${escapeHtml(c.title)}</span> ${escapeHtml(c.name)}</div>`)
    .join('');
  orderSeat.value = '';
  orderName.value = '';
  orderModal.classList.add('active');
}

confirmBtn.addEventListener('click', openOrderModal);
fsConfirmBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  openOrderModal();
});

// === 確定モーダル ===

document.getElementById('order-submit').addEventListener('click', () => {
  const seat = orderSeat.value.trim();
  const name = orderName.value.trim();

  const data = loadData();
  const selected = data.items.filter((item) => checkedCasts.has(item.id));

  const order = {
    id: generateId(),
    seat,
    customerName: name,
    casts: selected.map((c) => ({ id: c.id, name: c.name, title: c.title })),
    createdAt: new Date().toISOString(),
  };

  saveOrder(order);
  checkedCasts.clear();
  updateConfirmBtn();
  orderModal.classList.remove('active');
  render();
  alert('送信しました');
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

  // ナビボタンの表示制御
  fsPrev.style.visibility = currentIndex > 0 ? 'visible' : 'hidden';
  fsNext.style.visibility = currentIndex < visibleItems.length - 1 ? 'visible' : 'hidden';

  // 全画面チェックボックス（キャストかつ選択可のみ）
  if (isCast(item) && item.selectable !== false) {
    fsCheckbox.style.display = 'flex';
    fsCheckInput.checked = checkedCasts.has(item.id);
  } else {
    fsCheckbox.style.display = 'none';
  }
}

// 全画面チェックボックスの変更
fsCheckInput.addEventListener('change', () => {
  const item = visibleItems[currentIndex];
  if (!item) return;
  toggleCheck(item.id, fsCheckInput.checked);
  syncGridCheckbox(item.id, fsCheckInput.checked);
});

function syncGridCheckbox(id, checked) {
  const gridCb = grid.querySelector(`input[data-id="${id}"]`);
  if (gridCb) {
    gridCb.checked = checked;
    gridCb.closest('.host-panel').classList.toggle('checked', checked);
  }
}

function closeFullscreen() {
  fullscreen.classList.remove('active');
}

fsClose.addEventListener('click', closeFullscreen);

fullscreen.addEventListener('click', (e) => {
  if (e.target === fullscreen) closeFullscreen();
});

fsPrev.addEventListener('click', (e) => {
  e.stopPropagation();
  if (currentIndex > 0) { currentIndex--; showCurrentItem(); }
});

fsNext.addEventListener('click', (e) => {
  e.stopPropagation();
  if (currentIndex < visibleItems.length - 1) { currentIndex++; showCurrentItem(); }
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
})();
