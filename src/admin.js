// 管理者画面（統一型）
// 実行環境を html に付与（Capacitor アプリ vs ブラウザ）
const IS_CAPACITOR = !!(globalThis.Capacitor && globalThis.Capacitor.isNativePlatform && globalThis.Capacitor.isNativePlatform());
document.documentElement.classList.add(IS_CAPACITOR ? 'env-app' : 'env-web');

import { loadData, saveData, resetData, fileToBase64, generateId, loadOrders, deleteOrder, clearOrders, updateOrder, loadSettings, saveSettings, exportAllData, importAllData, getAdminPw, setAdminPw } from './store.js';
import { saveImage, getImage, deleteImage, getAllImages, clearImages, migrateFromLocalStorage } from './imageDB.js';
import { compressImage, dataUrlByteSize } from './imageCompress.js';
import * as dlg from './dialog.js';
import { scheduleStartupCheck, manualCheck } from './updateCheck.js';
import {
  initialSync, startRealtime, subscribeStatus, forcePull, forcePush,
  syncSavePanel, syncDeletePanel, syncBulkUpdateOrder, syncPatchPanel,
  cloudBackup, cloudBackupList, cloudBackupRestore, cloudBackupDelete,
  loadOrdersCloud, startOrdersRealtime, syncOrderUpdate, syncOrderDelete, syncOrdersClear,
  getDeviceName, setDeviceName, getSelfDeviceId,
  syncPushSubscriptionUpsert, syncPushSubscriptionDelete,
} from './sync.js';

const VAPID_PUBLIC_KEY = 'BKHpYZP-AyaG1CZOrG8I2nqL7dWZM1jiy6GHH1MBEl7e8RYbu1maw5TmkBkMZ5xxbmEZ0UMdEIYklFSMXL_wbd0';
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

// === パスワード認証（30日ログイン保持） ===

const pwScreen = document.getElementById('pw-screen');
const adminBody = document.getElementById('admin-body');
const pwInput = document.getElementById('pw-input');
const pwSubmit = document.getElementById('pw-submit');
const pwError = document.getElementById('pw-error');

const SESSION_KEY = 'host-menu-admin-session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30日

function isLoggedIn() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return false;
    const obj = JSON.parse(raw);
    if (!obj || !obj.lastLoginAt) return false;
    const age = Date.now() - obj.lastLoginAt;
    if (age < 0 || age > SESSION_TTL_MS) return false;
    // パスワードが変わっていたら無効化
    if (obj.pw && obj.pw !== getAdminPw()) return false;
    return true;
  } catch { return false; }
}

function setLoggedIn() {
  localStorage.setItem(SESSION_KEY, JSON.stringify({
    lastLoginAt: Date.now(),
    pw: getAdminPw(),
  }));
}

function logout() {
  localStorage.removeItem(SESSION_KEY);
  window.location.reload();
}

function enterAdmin() {
  pwScreen.style.display = 'none';
  adminBody.style.display = 'block';
  pwError.textContent = '';
  init();
}

function doLogin() {
  if (pwInput.value === getAdminPw()) {
    setLoggedIn();
    enterAdmin();
  } else {
    pwError.textContent = 'パスワードが違います';
    pwInput.value = '';
    pwInput.focus();
  }
}

pwSubmit.addEventListener('click', doLogin);
pwInput.addEventListener('keydown', async (e) => { if (e.key === 'Enter') doLogin(); });
document.getElementById('pw-cancel').addEventListener('click', async () => {
  window.location.href = './';
});

// 既ログインなら自動で admin に入る、未ログインならパスワード画面を表示
// queueMicrotask で遅延し、ファイル末尾の let/const 宣言（data 等）が評価された後に enterAdmin を呼ぶ（TDZ 回避）
if (isLoggedIn()) {
  queueMicrotask(() => enterAdmin());
} else {
  pwInput.focus();
}

// === 時計表示 ===
const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];
function updateAdminClock() {
  const el = document.getElementById('admin-clock');
  if (!el) return;
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  const w = WEEKDAYS[now.getDay()];
  const h = String(now.getHours()).padStart(2, '0');
  const min = String(now.getMinutes()).padStart(2, '0');
  el.textContent = `${y}/${m}/${d}(${w}) ${h}:${min}`;
}
updateAdminClock();
setInterval(updateAdminClock, 1000);

// === ここから管理画面本体 ===

let data = loadData();

const itemList = document.getElementById('item-list');

// タッチドラッグ並べ替え状態
let touchDragEl = null;
let touchDragId = null;
let touchStartY = 0;
let touchClone = null;
let touchCloneStartTop = 0;
let touchLongPressTimer = null;

// 新人表示/非表示トグル
const btnToggleNew = document.getElementById('btn-toggle-new');
btnToggleNew.addEventListener('click', async () => {
  const newFaces = data.items.filter((item) => item.isNewFace);
  if (newFaces.length === 0) return;
  const allHidden = newFaces.every((item) => item.visible === false);
  newFaces.forEach((item) => { item.visible = allHidden; });
  saveData(data);
  updateNewFaceBtn();
  renderList();
});

function updateNewFaceBtn() {
  const newFaces = data.items.filter((item) => item.isNewFace);
  const allHidden = newFaces.length > 0 && newFaces.every((item) => item.visible === false);
  btnToggleNew.textContent = allHidden ? '新人を表示' : '新人を非表示';
  btnToggleNew.classList.toggle('active', allHidden);
}

// === 描画 ===

// 画像キャッシュ（初回ロード後はキャッシュを使い回す）
let imagesCached = null;

async function loadImagesCache(force = false) {
  if (!imagesCached || force) {
    imagesCached = await getAllImages();
  }
  return imagesCached;
}

async function renderList() {
  const scrollY = window.scrollY;
  const items = data.items.sort((a, b) => a.order - b.order);
  const images = await loadImagesCache();

  // DocumentFragmentで裏側構築→一括差し替え
  const fragment = document.createDocumentFragment();
  items.forEach((item) => {
    const el = createSortableItem(item, images[item.id] || '');
    fragment.appendChild(el);
  });
  itemList.replaceChildren(fragment);

  requestAnimationFrame(() => { window.scrollTo(0, scrollY); });
}

function createSortableItem(item, imageSrc) {
  const el = document.createElement('div');
  el.className = 'sortable-item';
  el.dataset.id = item.id;

  const displayName = item.name || item.label || '（未設定）';
  const displaySub = item.name ? item.title : '';
  const newTag = item.isNewFace ? '<span class="admin-new-tag">NEW</span>' : '';

  el.innerHTML = `
    <div class="reorder-btns">
      <button class="btn-move btn-move-up" title="上へ">▲</button>
      <button class="btn-move btn-move-down" title="下へ">▼</button>
    </div>
    <div class="item-thumb"></div>
    <div class="item-info">
      <div class="info-name">${escapeHtml(displayName)} ${newTag}</div>
      ${displaySub ? `<div class="info-title">${escapeHtml(displaySub)}</div>` : ''}
    </div>
    <div class="item-actions">
      ${item.name ? `<button class="btn-icon btn-selectable ${item.selectable === false ? 'locked' : ''}" title="選択不可切替">${item.selectable === false ? '🚫' : '✓'}</button>` : ''}
      <button class="btn-icon btn-visible" title="表示切替">${item.visible === false ? '👁‍🗨' : '👁'}</button>
      <button class="btn-icon btn-edit" title="編集">✎</button>
      <button class="btn-icon danger btn-delete" title="削除">✕</button>
    </div>
  `;

  if (item.visible === false) el.classList.add('hidden-item');
  if (item.name && item.selectable === false) el.classList.add('locked-item');

  // 選択不可トグル
  const selectableBtn = el.querySelector('.btn-selectable');
  if (selectableBtn) {
    selectableBtn.addEventListener('click', async () => {
      item.selectable = item.selectable === false ? true : false;
      saveData(data);
      syncPatchPanel(item.id, { selectable: item.selectable }).catch(() => {});
      renderList();
    });
  }

  // 表示/非表示トグル
  el.querySelector('.btn-visible').addEventListener('click', async () => {
    item.visible = item.visible === false ? true : false;
    saveData(data);
    syncPatchPanel(item.id, { visible: item.visible }).catch(() => {});
    renderList();
  });

  // サムネイル（表示範囲設定を反映）
  const thumb = el.querySelector('.item-thumb');
  if (imageSrc) {
    const px = item.imgX ?? 50;
    const py = item.imgY ?? 50;
    const sc = item.imgScale ?? 100;
    thumb.innerHTML = `<img src="${imageSrc}" alt="" style="object-position:${px}% ${py}%;transform:scale(${sc / 100})" />`;
  } else {
    thumb.innerHTML = `<div class="thumb-placeholder">♠</div>`;
  }

  // タッチドラッグ初期化
  initTouchDrag(el, item.id);

  // 上下移動ボタン
  el.querySelector('.btn-move-up').addEventListener('click', async () => {
    moveItem(item.id, -1);
  });
  el.querySelector('.btn-move-down').addEventListener('click', async () => {
    moveItem(item.id, 1);
  });

  // 編集ボタン
  el.querySelector('.btn-edit').addEventListener('click', async () => openModal(item));

  // 削除ボタン
  el.querySelector('.btn-delete').addEventListener('click', async () => {
    const label = item.name || item.label || '（未設定）';
    if (!await dlg.confirm(`「${label}」を削除しますか？`)) return;
    await deleteImage(item.id);
    imagesCached = null;
    data.items = data.items.filter((x) => x.id !== item.id);
    saveData(data);
    syncDeletePanel(item.id).catch(() => {});
    renderList();
  });

  return el;
}

// === 並び替え ===

function moveItem(id, direction) {
  const sorted = data.items.sort((a, b) => a.order - b.order);
  const idx = sorted.findIndex((x) => x.id === id);
  if (idx === -1) return;
  const targetIdx = idx + direction;
  if (targetIdx < 0 || targetIdx >= sorted.length) return;

  // swap order
  const tmp = sorted[idx].order;
  sorted[idx].order = sorted[targetIdx].order;
  sorted[targetIdx].order = tmp;

  saveData(data);
  syncBulkUpdateOrder([sorted[idx], sorted[targetIdx]]).catch(() => {});
  renderList();
}

// === タッチドラッグ並べ替え ===

function initTouchDrag(el, itemId) {
  el.addEventListener('touchstart', async (e) => {
    // ボタン類のタッチは無視
    if (e.target.closest('.item-actions, .reorder-btns')) return;

    touchStartY = e.touches[0].clientY;

    touchLongPressTimer = setTimeout(() => {
      // ロングプレス成立 → ドラッグ開始
      touchDragEl = el;
      touchDragId = itemId;
      el.classList.add('dragging');

      // クローン作成
      const rect = el.getBoundingClientRect();
      touchClone = el.cloneNode(true);
      touchClone.classList.add('drag-clone');
      touchClone.style.position = 'fixed';
      touchClone.style.left = rect.left + 'px';
      touchClone.style.top = rect.top + 'px';
      touchClone.style.width = rect.width + 'px';
      touchClone.style.zIndex = '1000';
      touchClone.style.pointerEvents = 'none';
      touchCloneStartTop = rect.top;
      document.body.appendChild(touchClone);

      // 触覚フィードバック
      if (navigator.vibrate) navigator.vibrate(30);
    }, 400);
  }, { passive: true });
}

document.addEventListener('touchmove', async (e) => {
  if (!touchDragEl) {
    // ロングプレス前に指が動いたらキャンセル
    if (touchLongPressTimer) {
      clearTimeout(touchLongPressTimer);
      touchLongPressTimer = null;
    }
    return;
  }
  e.preventDefault();

  const touch = e.touches[0];
  const dy = touch.clientY - touchStartY;

  // クローンを移動
  if (touchClone) {
    touchClone.style.top = (touchCloneStartTop + dy) + 'px';
  }

  // ドラッグ先の要素を検出
  if (touchClone) touchClone.style.display = 'none';
  const target = document.elementFromPoint(touch.clientX, touch.clientY);
  if (touchClone) touchClone.style.display = '';

  // drag-overクラスを更新
  itemList.querySelectorAll('.drag-over').forEach((x) => x.classList.remove('drag-over'));
  if (target) {
    const overItem = target.closest('.sortable-item');
    if (overItem && overItem !== touchDragEl) {
      overItem.classList.add('drag-over');
    }
  }
}, { passive: false });

document.addEventListener('touchend', async () => {
  if (touchLongPressTimer) {
    clearTimeout(touchLongPressTimer);
    touchLongPressTimer = null;
  }

  if (!touchDragEl) return;

  // ドロップ先を確定
  const overItem = itemList.querySelector('.drag-over');
  if (overItem) {
    const fromId = touchDragId;
    const toId = overItem.dataset.id;
    reorderItem(fromId, toId);
  }

  // クリーンアップ
  touchDragEl.classList.remove('dragging');
  itemList.querySelectorAll('.drag-over').forEach((x) => x.classList.remove('drag-over'));
  if (touchClone) {
    touchClone.remove();
    touchClone = null;
  }
  touchDragEl = null;
  touchDragId = null;
});

function reorderItem(fromId, toId) {
  const sorted = data.items.sort((a, b) => a.order - b.order);
  const fromIdx = sorted.findIndex((x) => x.id === fromId);
  const toIdx = sorted.findIndex((x) => x.id === toId);
  if (fromIdx === -1 || toIdx === -1) return;

  // 移動先に挿入
  const [item] = sorted.splice(fromIdx, 1);
  sorted.splice(toIdx, 0, item);

  // order値を振り直し
  sorted.forEach((x, i) => { x.order = i; });

  saveData(data);
  syncBulkUpdateOrder(sorted).catch(() => {});
  renderList();
}

// === 編集モーダル ===

const editModal = document.getElementById('edit-modal');
const modalTitle = document.getElementById('modal-title');
const editId = document.getElementById('edit-id');
const editName = document.getElementById('edit-name');
const editRuby = document.getElementById('edit-ruby');
const editTitle = document.getElementById('edit-title');
const editLabel = document.getElementById('edit-label');
const editNewFace = document.getElementById('edit-newface');
const editImage = document.getElementById('edit-image');
const uploadText = document.getElementById('upload-text');
const uploadPreview = document.getElementById('upload-preview');
const imgPosGroup = document.getElementById('img-pos-group');
const imgPosPreview = document.getElementById('img-pos-preview');
const imgPosPreviewImg = document.getElementById('img-pos-preview-img');
const editImgX = document.getElementById('edit-img-x');
const editImgY = document.getElementById('edit-img-y');
const editImgScale = document.getElementById('edit-img-scale');
let pendingImage = null;

// プレビュー更新
function updateImgPosPreview() {
  const x = editImgX.value;
  const y = editImgY.value;
  const scale = editImgScale.value;
  imgPosPreviewImg.style.objectPosition = `${x}% ${y}%`;
  imgPosPreviewImg.style.transform = `scale(${scale / 100})`;
}
editImgX.addEventListener('input', updateImgPosPreview);
editImgY.addEventListener('input', updateImgPosPreview);
editImgScale.addEventListener('input', updateImgPosPreview);

async function openModal(item = null) {
  if (item) {
    modalTitle.textContent = 'パネル編集';
    editId.value = item.id;
    editName.value = item.name || '';
    editRuby.value = item.ruby || '';
    editTitle.value = item.title || '';
    editLabel.value = item.label || '';
    editNewFace.checked = !!item.isNewFace;

    const img = await getImage(item.id);
    pendingImage = img || null;
    editImgX.value = item.imgX ?? 50;
    editImgY.value = item.imgY ?? 50;
    editImgScale.value = item.imgScale ?? 100;
    if (img) {
      uploadPreview.src = img;
      uploadPreview.style.display = 'block';
      uploadText.style.display = 'none';
      imgPosGroup.style.display = 'block';
      imgPosPreviewImg.src = img;
      updateImgPosPreview();
    } else {
      uploadPreview.style.display = 'none';
      uploadText.style.display = 'block';
      uploadText.textContent = 'タップして画像を選択';
      imgPosGroup.style.display = 'none';
    }
  } else {
    modalTitle.textContent = 'パネル追加';
    editId.value = '';
    editName.value = '';
    editRuby.value = '';
    editTitle.value = '';
    editLabel.value = '';
    editNewFace.checked = false;
    pendingImage = null;
    editImgX.value = 50;
    editImgY.value = 50;
    editImgScale.value = 100;
    uploadPreview.style.display = 'none';
    uploadText.style.display = 'block';
    uploadText.textContent = 'タップして画像を選択';
    imgPosGroup.style.display = 'none';
  }
  editImage.value = '';
  editModal.classList.add('active');
}

editImage.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  uploadText.textContent = '画像を圧縮中…';
  uploadText.style.display = 'block';
  uploadPreview.style.display = 'none';
  try {
    // File を直接 Canvas に通して圧縮（メモリ効率◎）
    pendingImage = await compressImage(file);
  } catch (err) {
    // 失敗時は無加工 base64 へフォールバック
    pendingImage = await fileToBase64(file);
  }
  uploadPreview.src = pendingImage;
  uploadPreview.style.display = 'block';
  uploadText.style.display = 'none';
  imgPosGroup.style.display = 'block';
  imgPosPreviewImg.src = pendingImage;
  updateImgPosPreview();
});

document.getElementById('modal-save').addEventListener('click', async () => {
  const name = editName.value.trim();
  const ruby = editRuby.value.trim();
  const title = editTitle.value.trim();
  const label = editLabel.value.trim();
  const isNewFace = editNewFace.checked;
  const imgX = Number(editImgX.value);
  const imgY = Number(editImgY.value);
  const imgScale = Number(editImgScale.value);

  const id = editId.value;
  let savedItem = null;
  let imageForSync = null;
  if (id) {
    const item = data.items.find((x) => x.id === id);
    if (item) {
      item.name = name;
      item.ruby = ruby;
      item.title = title;
      item.label = label;
      item.isNewFace = isNewFace;
      item.imgX = imgX;
      item.imgY = imgY;
      item.imgScale = imgScale;
      if (pendingImage) {
        await saveImage(id, pendingImage);
        imagesCached = null;
        item.hasImage = true;
        imageForSync = pendingImage;
      }
      savedItem = item;
    }
  } else {
    const newId = generateId();
    if (pendingImage) {
      await saveImage(newId, pendingImage);
      imagesCached = null;
      imageForSync = pendingImage;
    }
    savedItem = {
      id: newId,
      name, ruby, title, label,
      hasImage: !!pendingImage,
      imgX, imgY, imgScale,
      image: '',
      order: data.items.length,
      visible: true,
      isNewFace,
      selectable: true,
    };
    data.items.push(savedItem);
  }

  saveData(data);
  if (savedItem) {
    syncSavePanel(savedItem, imageForSync).catch(() => {});
  }
  editModal.classList.remove('active');
  renderList();
});

document.getElementById('modal-cancel').addEventListener('click', async () => {
  editModal.classList.remove('active');
});

// === 新規追加ボタン ===

document.getElementById('btn-add').addEventListener('click', async () => openModal());

// === データリセット ===

document.getElementById('btn-reset').addEventListener('click', async () => {
  const pw = await dlg.prompt('データリセットにはパスワードが必要です');
  if (pw === null) return;
  if (pw !== getAdminPw()) { dlg.alert('パスワードが違います'); return; }
  if (!await dlg.confirm('全データを初期状態にリセットしますか？')) return;
  await clearImages();
  imagesCached = null;
  data = resetData();
  saveData(data);
  renderList();
});

// === モーダル外クリックで閉じる ===

editModal.addEventListener('click', async (e) => {
  if (e.target === editModal) editModal.classList.remove('active');
});

// === 初回ピックアップ履歴 ===

const orderList = document.getElementById('order-list');

// クラウド注文キャッシュ（Realtime で更新）
let cloudOrdersCache = [];

async function refreshOrdersFromCloud() {
  cloudOrdersCache = await loadOrdersCloud();
  renderOrders();
}

function renderOrders() {
  const orders = cloudOrdersCache.length > 0 ? cloudOrdersCache : loadOrders();
  if (orders.length === 0) {
    orderList.innerHTML = '<div class="empty-msg">履歴はありません</div>';
    return;
  }

  const VALID_COLORS = ['yellow', 'red', 'blue', 'green'];

  orderList.innerHTML = orders
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .map((o) => {
      const time = new Date(o.createdAt).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
      const castNames = o.casts.map((c) => {
        const cc = VALID_COLORS.includes(c.color) ? c.color : 'yellow';
        return `<span class="order-tag color-${cc}">
          <span class="order-color-badge color-${cc}"></span>${escapeHtml(c.name)}
        </span>`;
      }).join('');
      const color = (o.color === 'mixed' || VALID_COLORS.includes(o.color)) ? o.color : 'yellow';
      const memo = o.memo ? `<div class="order-memo">${escapeHtml(o.memo)}</div>` : '';
      const dev = o.deviceName ? `<span class="order-device">${escapeHtml(o.deviceName)}</span>` : '';
      const src = o.source === 'preview' ? '<span class="order-src-preview">PREVIEW</span>' : '';
      return `
        <div class="order-card color-${color}" data-id="${o.id}">
          <div class="order-card-header">
            <div class="order-meta">
              <span class="order-color-badge color-${color}"></span>
              <span class="order-seat">席: ${escapeHtml(o.seat || '-')}</span>
              <span class="order-customer">${escapeHtml(o.customerName || '-')}</span>
              ${dev}${src}
            </div>
            <span class="order-time">${time}</span>
          </div>
          <div class="order-casts">${castNames}</div>
          ${memo}
          <div class="order-card-actions">
            <button class="btn-icon order-edit" title="編集">✎</button>
            <button class="btn-icon danger order-delete" title="削除">✕</button>
          </div>
        </div>
      `;
    })
    .join('');

  orderList.querySelectorAll('.order-delete').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const card = btn.closest('.order-card');
      if (!await dlg.confirm('この履歴を削除しますか？')) return;
      const id = card.dataset.id;
      deleteOrder(id);
      cloudOrdersCache = cloudOrdersCache.filter((o) => o.id !== id);
      renderOrders();
      syncOrderDelete(id).catch(() => {});
    });
  });

  orderList.querySelectorAll('.order-edit').forEach((btn) => {
    btn.addEventListener('click', () => {
      const card = btn.closest('.order-card');
      openOrderEditModal(card.dataset.id);
    });
  });
}

// 履歴編集モーダル: 席選択リスト+お客様名+メモ+色選択リストを一括表示
const ORDER_SEAT_OPTIONS = ['A', 'B-1', 'B-2', 'C-1', 'C-2', 'D', 'E-1', 'E-2', 'E-3'];
const ORDER_COLOR_OPTIONS = [
  { v: 'yellow', label: 'Yellow' },
  { v: 'red',    label: 'Red' },
  { v: 'blue',   label: 'Blue' },
  { v: 'green',  label: 'Green' },
];

function openOrderEditModal(id) {
  const current = (cloudOrdersCache.find((o) => o.id === id)) || loadOrders().find((o) => o.id === id);
  if (!current) return;

  const isStandardSeat = ORDER_SEAT_OPTIONS.includes(current.seat || '');
  const seatInit = isStandardSeat ? current.seat : (current.seat ? 'other' : '');
  const otherInit = (isStandardSeat || !current.seat) ? '' : current.seat;
  const colorInit = ORDER_COLOR_OPTIONS.some((c) => c.v === current.color) ? current.color : 'yellow';

  const root = document.createElement('div');
  root.className = 'app-dialog-host';
  root.style.display = 'block';
  root.innerHTML = `
    <div class="app-dialog-backdrop"><div class="app-dialog-box order-edit-box">
      <h3 class="app-dialog-title">履歴を編集</h3>

      <div class="form-group">
        <label>席番</label>
        <select id="ed-seat" class="app-dialog-input">
          <option value="">未選択</option>
          ${ORDER_SEAT_OPTIONS.map((s) => `<option value="${s}" ${s === seatInit ? 'selected' : ''}>${s}</option>`).join('')}
          <option value="other" ${seatInit === 'other' ? 'selected' : ''}>その他（自由入力）</option>
        </select>
        <input id="ed-seat-other" class="app-dialog-input" placeholder="席番号を入力" style="display:${seatInit === 'other' ? 'block' : 'none'};margin-top:6px" value="${escapeHtml(otherInit)}" />
      </div>

      <div class="form-group">
        <label>お客様名</label>
        <input id="ed-name" class="app-dialog-input" value="${escapeHtml(current.customerName || '')}" />
      </div>

      <div class="form-group">
        <label>メモ</label>
        <textarea id="ed-memo" class="app-dialog-input" rows="3">${escapeHtml(current.memo || '')}</textarea>
      </div>

      <div class="form-group">
        <label>色</label>
        <select id="ed-color" class="app-dialog-input">
          ${ORDER_COLOR_OPTIONS.map((c) => `<option value="${c.v}" ${c.v === colorInit ? 'selected' : ''}>${c.label}</option>`).join('')}
        </select>
      </div>

      <div class="app-dialog-actions">
        <button class="btn btn-secondary" id="ed-cancel">キャンセル</button>
        <button class="btn btn-primary" id="ed-save">保存</button>
      </div>
    </div></div>
  `;
  document.body.appendChild(root);

  const seatSel = root.querySelector('#ed-seat');
  const seatOther = root.querySelector('#ed-seat-other');
  seatSel.addEventListener('change', () => {
    seatOther.style.display = seatSel.value === 'other' ? 'block' : 'none';
    if (seatSel.value === 'other') seatOther.focus();
  });

  const close = () => root.remove();
  root.querySelector('#ed-cancel').addEventListener('click', close);
  root.querySelector('.app-dialog-backdrop').addEventListener('click', (e) => {
    if (e.target.classList.contains('app-dialog-backdrop')) close();
  });
  document.addEventListener('keydown', function onKey(e) {
    if (!root.isConnected) { document.removeEventListener('keydown', onKey); return; }
    if (e.key === 'Escape') { document.removeEventListener('keydown', onKey); close(); }
  });

  root.querySelector('#ed-save').addEventListener('click', () => {
    const seatVal = seatSel.value === 'other' ? seatOther.value.trim() : seatSel.value;
    const patch = {
      seat: seatVal,
      customerName: root.querySelector('#ed-name').value.trim(),
      memo: root.querySelector('#ed-memo').value.trim(),
      color: root.querySelector('#ed-color').value,
    };
    updateOrder(id, patch);
    const c = cloudOrdersCache.find((o) => o.id === id);
    if (c) Object.assign(c, patch);
    renderOrders();
    syncOrderUpdate(id, patch).catch(() => {});
    close();
  });
}

document.getElementById('btn-clear-orders').addEventListener('click', async () => {
  if (!await dlg.confirm('全ての履歴を削除しますか？\n（クラウドの注文履歴も削除されます）', { danger: true })) return;
  clearOrders();
  cloudOrdersCache = [];
  renderOrders();
  syncOrdersClear().catch(() => {});
});

// === バックアップ/復元 ===

document.getElementById('btn-export').addEventListener('click', async () => {
  const backup = exportAllData();
  backup.images = await getAllImages();
  const filename = `gently-diva-backup-${new Date().toISOString().slice(0, 10)}.json`;
  const blob = new Blob([JSON.stringify(backup)], { type: 'application/json' });

  // 1) navigator.share に files を渡せるか実際にチェック
  let file = null;
  try { file = new File([blob], filename, { type: 'application/json' }); } catch { /* ignore */ }
  if (file && typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] }) && navigator.share) {
    try {
      await navigator.share({ files: [file], title: filename });
      return;
    } catch (err) {
      if (err && err.name === 'AbortError') return;
      // それ以外はフォールバックに進む
    }
  }

  // 2) <a download> + クリック（PCブラウザで動く）
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.target = '_blank';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    // ダウンロードがブロックされる Android WebView 対策で、ついでに新しいタブで開いて長押し保存できるようにする
    setTimeout(() => {
      try { window.open(url, '_system'); } catch { /* ignore */ }
    }, 200);
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  dlg.alert('バックアップを作成しました。\nうまく保存できない場合は「クラウドバックアップ」を使ってください。');
});

document.getElementById('btn-import').addEventListener('click', async () => {
  document.getElementById('import-file').click();
});

document.getElementById('import-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    const backup = JSON.parse(text);
    if (!await dlg.confirm('現在のデータを上書きします。よろしいですか？')) return;

    // 画像を復元
    if (backup.images) {
      await clearImages();
      imagesCached = null;
      for (const [id, img] of Object.entries(backup.images)) {
        await saveImage(id, img);
      }
      delete backup.images;
    }

    importAllData(backup);
    data = loadData();
    renderList();
    renderOrders();
    updateNewFaceBtn();
    dlg.alert('復元しました');
  } catch (err) {
    dlg.alert('ファイルの読み込みに失敗しました');
  }
  e.target.value = '';
});

// === パスワード変更 ===

document.getElementById('btn-change-pw').addEventListener('click', async () => {
  const current = await dlg.prompt('現在のパスワード');
  if (current === null) return;
  if (current !== getAdminPw()) { dlg.alert('パスワードが違います'); return; }
  const newPw = await dlg.prompt('新しいパスワード');
  if (newPw === null || newPw === '') { dlg.alert('パスワードを入力してください'); return; }
  const confirm2 = await dlg.prompt('新しいパスワード（確認）');
  if (newPw !== confirm2) { dlg.alert('パスワードが一致しません'); return; }
  setAdminPw(newPw);
  dlg.alert('パスワードを変更しました');
});

// === 画像軽量化（一括圧縮） ===

const btnOptimizeImages = document.getElementById('btn-optimize-images');
const optimizeStatus = document.getElementById('optimize-status');

function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

async function optimizeAllImages() {
  if (!await dlg.confirm('全ての画像を軽量化（再圧縮）します。元の高画質に戻すには再アップロードが必要です。続行しますか？')) return;

  btnOptimizeImages.disabled = true;
  optimizeStatus.textContent = '読み込み中…';
  optimizeStatus.style.display = 'block';

  try {
    const all = await getAllImages();
    const ids = Object.keys(all);
    if (ids.length === 0) {
      optimizeStatus.textContent = '画像がありません';
      btnOptimizeImages.disabled = false;
      return;
    }

    let beforeTotal = 0;
    let afterTotal = 0;
    let skipped = 0;

    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      const src = all[id];
      optimizeStatus.textContent = `処理中… ${i + 1} / ${ids.length}`;
      const before = dataUrlByteSize(src);
      beforeTotal += before;

      let compressed;
      try {
        compressed = await compressImage(src);
      } catch (e) {
        compressed = src;
      }

      const after = dataUrlByteSize(compressed);
      afterTotal += after;

      if (after < before) {
        await saveImage(id, compressed);
      } else {
        skipped++;
      }

      // UI を詰まらせないため毎フレーム譲る
      await new Promise((r) => requestAnimationFrame(r));
    }

    imagesCached = null;
    const saved = beforeTotal - afterTotal;
    const pct = beforeTotal > 0 ? Math.round((saved / beforeTotal) * 100) : 0;
    optimizeStatus.textContent =
      `完了：${ids.length}件中 ${ids.length - skipped}件を圧縮（${fmtBytes(beforeTotal)} → ${fmtBytes(afterTotal)} / -${pct}%）`;
    await renderList();
  } catch (e) {
    optimizeStatus.textContent = `エラー: ${e.message || e}`;
  } finally {
    btnOptimizeImages.disabled = false;
  }
}

if (btnOptimizeImages) {
  btnOptimizeImages.addEventListener('click', optimizeAllImages);
}

// === アプリアップデート確認 ===

const btnCheckUpdate = document.getElementById('btn-check-update');
const updateStatus = document.getElementById('update-status');
const APP_VERSION = (typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '0.0.0');
const GH_RELEASES_URL = 'https://api.github.com/repos/wpuhs2216-hub/host-menu-app/releases/latest';

// "v1.2.3" や "1.2.3" を [1,2,3] に変換
function parseVersion(s) {
  if (!s) return [0, 0, 0];
  const m = String(s).replace(/^v/i, '').match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  if (!m) return [0, 0, 0];
  return [Number(m[1] || 0), Number(m[2] || 0), Number(m[3] || 0)];
}

function compareVersions(a, b) {
  const va = parseVersion(a);
  const vb = parseVersion(b);
  for (let i = 0; i < 3; i++) {
    if (va[i] !== vb[i]) return va[i] - vb[i];
  }
  return 0;
}

async function checkForUpdate() {
  btnCheckUpdate.disabled = true;
  updateStatus.textContent = '確認中…';
  updateStatus.style.display = 'block';

  try {
    const res = await fetch(GH_RELEASES_URL, {
      headers: { 'Accept': 'application/vnd.github+json' },
      cache: 'no-store',
    });
    if (!res.ok) {
      if (res.status === 404) {
        updateStatus.textContent = `現在: v${APP_VERSION}（公開リリースなし）`;
        return;
      }
      throw new Error(`HTTP ${res.status}`);
    }
    const data = await res.json();
    const latestTag = data.tag_name || '';
    const latest = parseVersion(latestTag).join('.');

    if (compareVersions(latestTag, APP_VERSION) > 0) {
      const apkAsset = (data.assets || []).find((a) => a.name && a.name.endsWith('.apk'));
      const url = apkAsset ? apkAsset.browser_download_url : data.html_url;
      updateStatus.innerHTML = `新しいバージョンがあります: <strong>v${latest}</strong>（現在 v${APP_VERSION}）`;
      if (apkAsset) {
        if (await dlg.confirm(`新しいバージョン v${latest} があります。ダウンロードページを開きますか？\n\nダウンロード後、通知をタップしてインストールしてください。`)) {
          // Capacitor / Android WebView から外部ブラウザで開く
          window.open(url, '_system');
        }
      } else {
        if (await dlg.confirm(`新しいバージョン v${latest} があります。リリースページを開きますか？`)) {
          window.open(url, '_system');
        }
      }
    } else {
      updateStatus.textContent = `最新版です（v${APP_VERSION}）`;
    }
  } catch (e) {
    updateStatus.textContent = `確認失敗: ${e.message || e}`;
  } finally {
    btnCheckUpdate.disabled = false;
  }
}

if (btnCheckUpdate) {
  btnCheckUpdate.addEventListener('click', () => manualCheck());
}

// バージョン表示
const versionLabel = document.getElementById('app-version');
if (versionLabel) versionLabel.textContent = `v${APP_VERSION}`;

// === フォントサイズ設定 ===

const fsSliders = {
  name: document.getElementById('fs-name'),
  title: document.getElementById('fs-title'),
  fsName: document.getElementById('fs-fs-name'),
  fsTitle: document.getElementById('fs-fs-title'),
};
const fsVals = {
  name: document.getElementById('fs-name-val'),
  title: document.getElementById('fs-title-val'),
  fsName: document.getElementById('fs-fs-name-val'),
  fsTitle: document.getElementById('fs-fs-title-val'),
};
const settingsKeyMap = {
  name: 'nameFontSize',
  title: 'titleFontSize',
  fsName: 'fsNameFontSize',
  fsTitle: 'fsTitleFontSize',
};

function initFontSettings() {
  const s = loadSettings();
  fsSliders.name.value = s.nameFontSize;
  fsSliders.title.value = s.titleFontSize;
  fsSliders.fsName.value = s.fsNameFontSize;
  fsSliders.fsTitle.value = s.fsTitleFontSize;
  Object.keys(fsVals).forEach((k) => { fsVals[k].textContent = fsSliders[k].value + 'px'; });

  // スキップ設定
  const skipCb = document.getElementById('setting-skip-order-input');
  if (skipCb) {
    skipCb.checked = !!s.skipOrderInput;
    skipCb.addEventListener('change', async () => {
      const cur = loadSettings();
      cur.skipOrderInput = skipCb.checked;
      saveSettings(cur);
    });
  }

  // 端末名
  const dnInput = document.getElementById('setting-device-name');
  if (dnInput) {
    dnInput.value = getDeviceName();
    const persist = () => setDeviceName(dnInput.value.trim());
    dnInput.addEventListener('change', persist);
    dnInput.addEventListener('blur', persist);
  }
}

Object.keys(fsSliders).forEach((key) => {
  fsSliders[key].addEventListener('input', async () => {
    fsVals[key].textContent = fsSliders[key].value + 'px';
    const s = loadSettings();
    s[settingsKeyMap[key]] = Number(fsSliders[key].value);
    saveSettings(s);
  });
});

// === ユーティリティ ===

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// === 戻るボタン制御（メイン画面に戻る） ===
history.pushState(null, '', location.href);
window.addEventListener('popstate', async () => {
  if (editModal.classList.contains('active')) {
    editModal.classList.remove('active');
    history.pushState(null, '', location.href);
  } else {
    window.location.href = '/';
  }
});

// === 同期ステータス UI ===
const syncStatusEl = document.getElementById('sync-status');
const btnResync = document.getElementById('btn-resync');
const btnPushAll = document.getElementById('btn-push-all');

function renderSyncStatus(s) {
  if (!syncStatusEl) return;
  const map = {
    idle:      { text: '同期: 未接続', cls: 'sync-idle' },
    syncing:   { text: `同期: ${s.message || '処理中…'}`, cls: 'sync-syncing' },
    connected: { text: '同期: 接続中 ✓', cls: 'sync-ok' },
    error:     { text: `同期エラー: ${s.message || '不明'}`, cls: 'sync-error' },
  };
  const m = map[s.state] || map.idle;
  syncStatusEl.textContent = m.text;
  syncStatusEl.className = `sync-status ${m.cls}`;
}
subscribeStatus(renderSyncStatus);

const btnLogout = document.getElementById('btn-logout');
if (btnLogout) {
  btnLogout.addEventListener('click', async () => {
    if (await dlg.confirm('ログアウトしますか？')) logout();
  });
}

if (btnResync) {
  btnResync.addEventListener('click', async () => {
    btnResync.disabled = true;
    try {
      await forcePull();
      data = loadData();
      imagesCached = null;
      renderList();
      updateNewFaceBtn();
    } catch (e) {
      dlg.alert('再同期に失敗しました: ' + (e.message || e));
    } finally {
      btnResync.disabled = false;
    }
  });
}

if (btnPushAll) {
  btnPushAll.addEventListener('click', async () => {
    if (!await dlg.confirm('このタブレットのデータでクラウドを上書きします。よろしいですか？')) return;
    btnPushAll.disabled = true;
    try {
      await forcePush();
      dlg.alert('送信しました');
    } catch (e) {
      dlg.alert('送信に失敗しました: ' + (e.message || e));
    } finally {
      btnPushAll.disabled = false;
    }
  });
}

// === クラウドバックアップ UI ===

const btnCloudBackup = document.getElementById('btn-cloud-backup');
const btnCloudBackupList = document.getElementById('btn-cloud-backup-list');
const cloudBackupListEl = document.getElementById('cloud-backup-list');

function fmtDate(iso) {
  try {
    const d = new Date(iso);
    return `${d.getFullYear()}/${String(d.getMonth()+1).padStart(2,'0')}/${String(d.getDate()).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
  } catch { return iso; }
}

function fmtKB(n) {
  if (n == null) return '';
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

if (btnCloudBackup) {
  btnCloudBackup.addEventListener('click', async () => {
    const label = await dlg.prompt('メモ（任意・例: 5/3 リニューアル前）', '');
    if (label === null) return;
    btnCloudBackup.disabled = true;
    try {
      const r = await cloudBackup(label);
      dlg.alert(`クラウドにバックアップしました\n${r.filename.split('/').pop()}\nサイズ: ${fmtKB(r.size)}`);
      await renderCloudBackupList();
    } catch (e) {
      dlg.alert('クラウドバックアップに失敗しました: ' + (e.message || e));
    } finally {
      btnCloudBackup.disabled = false;
    }
  });
}

async function renderCloudBackupList() {
  if (!cloudBackupListEl) return;
  cloudBackupListEl.style.display = 'block';
  cloudBackupListEl.innerHTML = '<div class="empty-msg">読み込み中…</div>';
  try {
    const list = await cloudBackupList();
    if (list.length === 0) {
      cloudBackupListEl.innerHTML = '<div class="empty-msg">クラウドバックアップはまだありません</div>';
      return;
    }
    cloudBackupListEl.innerHTML = list.map((f) => {
      const created = f.created_at || (f.metadata && f.metadata.lastModified) || '';
      const size = f.metadata && f.metadata.size;
      return `
        <div class="cloud-backup-item" data-name="${f.name}">
          <div class="cb-meta">
            <span class="cb-date">${fmtDate(created)}</span>
            <span class="cb-size">${fmtKB(size)}</span>
          </div>
          <div class="cb-actions">
            <button class="btn btn-secondary cb-restore">復元</button>
            <button class="btn-icon danger cb-delete" title="削除">✕</button>
          </div>
        </div>
      `;
    }).join('');

    cloudBackupListEl.querySelectorAll('.cb-restore').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const name = btn.closest('.cloud-backup-item').dataset.name;
        if (!await dlg.confirm(`このバックアップで全データを上書き復元します。\n${name}\nよろしいですか？`)) return;
        btn.disabled = true;
        try {
          await cloudBackupRestore(name);
          data = loadData();
          imagesCached = null;
          renderList();
          renderOrders();
          updateNewFaceBtn();
          initFontSettings();
          dlg.alert('復元しました。「この端末で上書き」を押すとクラウド同期にも反映されます。');
        } catch (e) {
          dlg.alert('復元に失敗: ' + (e.message || e));
        } finally {
          btn.disabled = false;
        }
      });
    });

    cloudBackupListEl.querySelectorAll('.cb-delete').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const name = btn.closest('.cloud-backup-item').dataset.name;
        if (!await dlg.confirm(`削除します: ${name}`)) return;
        try {
          await cloudBackupDelete(name);
          await renderCloudBackupList();
        } catch (e) {
          dlg.alert('削除に失敗: ' + (e.message || e));
        }
      });
    });
  } catch (e) {
    cloudBackupListEl.innerHTML = `<div class="empty-msg">取得失敗: ${e.message || e}</div>`;
  }
}

if (btnCloudBackupList) {
  btnCloudBackupList.addEventListener('click', async () => {
    if (cloudBackupListEl.style.display === 'none' || !cloudBackupListEl.style.display) {
      renderCloudBackupList();
    } else {
      cloudBackupListEl.style.display = 'none';
    }
  });
}

// === ブラウザ通知 ===
const NOTIFY_KEY = 'host-menu-notify-enabled';
const NOTIFY_COLOR_LABEL = { yellow: 'Yellow', red: 'Red', blue: 'Blue', green: 'Green' };
const btnToggleNotify = document.getElementById('btn-toggle-notify');

function notifySupported() {
  // Capacitor アプリ版は Web Push に対応しないので無効化
  if (IS_CAPACITOR) return false;
  return typeof Notification !== 'undefined';
}

function notifyEnabled() {
  return notifySupported()
    && Notification.permission === 'granted'
    && localStorage.getItem(NOTIFY_KEY) === '1';
}

function updateNotifyBtn() {
  if (!btnToggleNotify) return;
  if (!notifySupported()) {
    btnToggleNotify.textContent = '通知 非対応';
    btnToggleNotify.disabled = true;
    return;
  }
  if (notifyEnabled()) {
    btnToggleNotify.textContent = '通知 ON';
    btnToggleNotify.style.background = 'rgba(106, 208, 128, 0.18)';
    btnToggleNotify.style.color = '#6ad080';
    btnToggleNotify.style.borderColor = 'rgba(106, 208, 128, 0.5)';
  } else {
    btnToggleNotify.textContent = '通知 OFF';
    btnToggleNotify.style.background = '';
    btnToggleNotify.style.color = '';
    btnToggleNotify.style.borderColor = '';
  }
}
updateNotifyBtn();

async function ensurePushSubscription() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return null;
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
    });
  }
  await syncPushSubscriptionUpsert(sub);
  return sub;
}

async function removePushSubscription() {
  if (!('serviceWorker' in navigator)) return;
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) {
      await syncPushSubscriptionDelete(sub.endpoint);
      await sub.unsubscribe();
    }
  } catch (e) { console.warn('unsubscribe 失敗', e); }
}

if (btnToggleNotify && !IS_CAPACITOR) {
  btnToggleNotify.addEventListener('click', async () => {
    if (!notifySupported()) return;
    if (notifyEnabled()) {
      localStorage.setItem(NOTIFY_KEY, '0');
      await removePushSubscription();
      updateNotifyBtn();
      return;
    }
    if (Notification.permission === 'denied') {
      await dlg.alert('ブラウザ設定で通知が拒否されています。\nアドレスバー左の鍵アイコンから通知を「許可」に変更してください。');
      return;
    }
    let perm = Notification.permission;
    if (perm !== 'granted') perm = await Notification.requestPermission();
    if (perm === 'granted') {
      localStorage.setItem(NOTIFY_KEY, '1');
      try { await ensurePushSubscription(); } catch (e) { console.warn('push 購読失敗', e); }
      updateNotifyBtn();
      try { new Notification('GENTLY DIVA', { body: '通知が有効になりました（バックグラウンドでも届きます）', icon: './icon-192.png' }); } catch { /* ignore */ }
    } else {
      updateNotifyBtn();
      dlg.alert('通知が許可されませんでした');
    }
  });
}

function fireNotification(o) {
  if (!notifyEnabled()) return;
  const colorLabel = NOTIFY_COLOR_LABEL[o.color] || '';
  const seat = o.seat ? `席 ${o.seat}` : '席未選択';
  const dev = o.deviceName ? `[${o.deviceName}] ` : '';
  const src = o.source === 'preview' ? '（プレビュー）' : '';
  const title = `${dev}${seat}${src ? ' ' + src : ''}`.trim();
  const castNames = (o.casts || []).map((c) => c.name).join(', ');
  const body = `${colorLabel}${o.customerName ? ' / ' + o.customerName : ''}\n${castNames}`;
  try {
    const n = new Notification(title || 'GENTLY DIVA', { body, icon: './icon-192.png', tag: o.id });
    n.onclick = () => { window.focus(); n.close(); };
  } catch { /* ignore */ }
}

// === 初期化 ===

async function init() {
  // 旧データの画像をIndexedDBに移行
  const migrated = await migrateFromLocalStorage(data.items);
  if (migrated) saveData(data);

  initFontSettings();
  renderOrders();
  renderList();
  updateNewFaceBtn();

  // クラウド注文を取得 + Realtime 購読
  refreshOrdersFromCloud().catch(() => {});
  startOrdersRealtime({
    onInsert: (o) => {
      // 既存にあれば差し替え、無ければ先頭に追加
      const idx = cloudOrdersCache.findIndex((x) => x.id === o.id);
      if (idx >= 0) cloudOrdersCache[idx] = o; else cloudOrdersCache.unshift(o);
      renderOrders();
      // 自端末で送ったものは通知しない（重複抑制）
      if (o.deviceId !== getSelfDeviceId()) fireNotification(o);
    },
    onUpdate: (o) => {
      const idx = cloudOrdersCache.findIndex((x) => x.id === o.id);
      if (idx >= 0) cloudOrdersCache[idx] = o;
      renderOrders();
    },
    onDelete: (id) => {
      cloudOrdersCache = cloudOrdersCache.filter((x) => x.id !== id);
      renderOrders();
    },
  });

  // クラウド同期を開始（失敗しても admin の編集は続行可能）
  try {
    await initialSync();
    data = loadData();
    imagesCached = null;
    renderList();
    updateNewFaceBtn();
  } catch (e) {
    console.warn('initialSync 失敗', e);
  }
  startRealtime(async () => {
    data = loadData();
    imagesCached = null;
    renderList();
    updateNewFaceBtn();
  });

  // 通知ボタンの状態を最新化（permission が変わっている場合に追従）
  updateNotifyBtn();

  // 起動時自動アップデートチェック（APK アップデートはアプリ版のみ）
  if (IS_CAPACITOR) scheduleStartupCheck();
}
