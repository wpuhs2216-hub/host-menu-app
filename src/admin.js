// 管理者画面（統一型）
import { loadData, saveData, resetData, fileToBase64, generateId, loadOrders, deleteOrder, clearOrders, loadSettings, saveSettings, exportAllData, importAllData, getAdminPw, setAdminPw } from './store.js';
import { saveImage, getImage, deleteImage, getAllImages, clearImages, migrateFromLocalStorage } from './imageDB.js';
import { compressImage, dataUrlByteSize } from './imageCompress.js';
import {
  initialSync, startRealtime, subscribeStatus, forcePull, forcePush,
  syncSavePanel, syncDeletePanel, syncBulkUpdateOrder, syncPatchPanel,
} from './sync.js';

// === パスワード認証 ===

const pwScreen = document.getElementById('pw-screen');
const adminBody = document.getElementById('admin-body');
const pwInput = document.getElementById('pw-input');
const pwSubmit = document.getElementById('pw-submit');
const pwError = document.getElementById('pw-error');

function doLogin() {
  if (pwInput.value === getAdminPw()) {
    pwScreen.style.display = 'none';
    adminBody.style.display = 'block';
    pwError.textContent = '';
    init();
  } else {
    pwError.textContent = 'パスワードが違います';
    pwInput.value = '';
    pwInput.focus();
  }
}

pwSubmit.addEventListener('click', doLogin);
pwInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });
document.getElementById('pw-cancel').addEventListener('click', () => {
  window.location.href = '/';
});
pwInput.focus();

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
btnToggleNew.addEventListener('click', () => {
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
    selectableBtn.addEventListener('click', () => {
      item.selectable = item.selectable === false ? true : false;
      saveData(data);
      syncPatchPanel(item.id, { selectable: item.selectable }).catch(() => {});
      renderList();
    });
  }

  // 表示/非表示トグル
  el.querySelector('.btn-visible').addEventListener('click', () => {
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
  el.querySelector('.btn-move-up').addEventListener('click', () => {
    moveItem(item.id, -1);
  });
  el.querySelector('.btn-move-down').addEventListener('click', () => {
    moveItem(item.id, 1);
  });

  // 編集ボタン
  el.querySelector('.btn-edit').addEventListener('click', () => openModal(item));

  // 削除ボタン
  el.querySelector('.btn-delete').addEventListener('click', async () => {
    const label = item.name || item.label || '（未設定）';
    if (!confirm(`「${label}」を削除しますか？`)) return;
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
  el.addEventListener('touchstart', (e) => {
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

document.addEventListener('touchmove', (e) => {
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

document.addEventListener('touchend', () => {
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

document.getElementById('modal-cancel').addEventListener('click', () => {
  editModal.classList.remove('active');
});

// === 新規追加ボタン ===

document.getElementById('btn-add').addEventListener('click', () => openModal());

// === データリセット ===

document.getElementById('btn-reset').addEventListener('click', async () => {
  const pw = prompt('データリセットにはパスワードが必要です');
  if (pw === null) return;
  if (pw !== getAdminPw()) { alert('パスワードが違います'); return; }
  if (!confirm('全データを初期状態にリセットしますか？')) return;
  await clearImages();
  imagesCached = null;
  data = resetData();
  saveData(data);
  renderList();
});

// === モーダル外クリックで閉じる ===

editModal.addEventListener('click', (e) => {
  if (e.target === editModal) editModal.classList.remove('active');
});

// === 初回ピックアップ履歴 ===

const orderList = document.getElementById('order-list');

function renderOrders() {
  const orders = loadOrders();
  if (orders.length === 0) {
    orderList.innerHTML = '<div class="empty-msg">履歴はありません</div>';
    return;
  }

  orderList.innerHTML = orders
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .map((o) => {
      const time = new Date(o.createdAt).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
      const castNames = o.casts.map((c) => `<span class="order-tag">${escapeHtml(c.name)}</span>`).join('');
      return `
        <div class="order-card" data-id="${o.id}">
          <div class="order-card-header">
            <div class="order-meta">
              <span class="order-seat">席: ${escapeHtml(o.seat || '-')}</span>
              <span class="order-customer">${escapeHtml(o.customerName || '-')}</span>
            </div>
            <span class="order-time">${time}</span>
          </div>
          <div class="order-casts">${castNames}</div>
          <button class="btn-icon danger order-delete" title="削除">✕</button>
        </div>
      `;
    })
    .join('');

  orderList.querySelectorAll('.order-delete').forEach((btn) => {
    btn.addEventListener('click', () => {
      const card = btn.closest('.order-card');
      if (!confirm('この履歴を削除しますか？')) return;
      deleteOrder(card.dataset.id);
      renderOrders();
    });
  });
}

document.getElementById('btn-clear-orders').addEventListener('click', () => {
  if (!confirm('全ての履歴を削除しますか？')) return;
  clearOrders();
  renderOrders();
});

// === バックアップ/復元 ===

document.getElementById('btn-export').addEventListener('click', async () => {
  const backup = exportAllData();
  backup.images = await getAllImages();
  const filename = `gently-diva-backup-${new Date().toISOString().slice(0, 10)}.json`;
  const blob = new Blob([JSON.stringify(backup)], { type: 'application/json' });

  // Android WebViewでは<a download>が動かないため navigator.share() を使用
  if (navigator.canShare) {
    try {
      const file = new File([blob], filename, { type: 'application/json' });
      await navigator.share({ files: [file] });
      return;
    } catch (err) {
      // ユーザーキャンセルは無視
      if (err.name === 'AbortError') return;
    }
  }

  // フォールバック（PCブラウザ等）
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
});

document.getElementById('btn-import').addEventListener('click', () => {
  document.getElementById('import-file').click();
});

document.getElementById('import-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    const backup = JSON.parse(text);
    if (!confirm('現在のデータを上書きします。よろしいですか？')) return;

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
    alert('復元しました');
  } catch (err) {
    alert('ファイルの読み込みに失敗しました');
  }
  e.target.value = '';
});

// === パスワード変更 ===

document.getElementById('btn-change-pw').addEventListener('click', () => {
  const current = prompt('現在のパスワード');
  if (current === null) return;
  if (current !== getAdminPw()) { alert('パスワードが違います'); return; }
  const newPw = prompt('新しいパスワード');
  if (newPw === null || newPw === '') { alert('パスワードを入力してください'); return; }
  const confirm2 = prompt('新しいパスワード（確認）');
  if (newPw !== confirm2) { alert('パスワードが一致しません'); return; }
  setAdminPw(newPw);
  alert('パスワードを変更しました');
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
  if (!confirm('全ての画像を軽量化（再圧縮）します。元の高画質に戻すには再アップロードが必要です。続行しますか？')) return;

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
        if (confirm(`新しいバージョン v${latest} があります。ダウンロードページを開きますか？\n\nダウンロード後、通知をタップしてインストールしてください。`)) {
          // Capacitor / Android WebView から外部ブラウザで開く
          window.open(url, '_system');
        }
      } else {
        if (confirm(`新しいバージョン v${latest} があります。リリースページを開きますか？`)) {
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
  btnCheckUpdate.addEventListener('click', checkForUpdate);
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
}

Object.keys(fsSliders).forEach((key) => {
  fsSliders[key].addEventListener('input', () => {
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
window.addEventListener('popstate', () => {
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
      alert('再同期に失敗しました: ' + (e.message || e));
    } finally {
      btnResync.disabled = false;
    }
  });
}

if (btnPushAll) {
  btnPushAll.addEventListener('click', async () => {
    if (!confirm('このタブレットのデータでクラウドを上書きします。よろしいですか？')) return;
    btnPushAll.disabled = true;
    try {
      await forcePush();
      alert('送信しました');
    } catch (e) {
      alert('送信に失敗しました: ' + (e.message || e));
    } finally {
      btnPushAll.disabled = false;
    }
  });
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
}
