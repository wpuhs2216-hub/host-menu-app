// Supabase 同期レイヤ
// - panels テーブル: id, name, ruby, title, label, image_path, img_x, img_y, img_scale,
//   "order", visible, is_new_face, selectable, has_image, updated_at
// - storage: panel-images バケットに <id>.jpg を保存
// - 注文履歴・フォントサイズ・パスワードはローカルのまま

import { supabase, PANEL_BUCKET, publicImageUrl } from './supabaseClient.js';
import { loadData, saveData } from './store.js';
import { saveImage, getImage, deleteImage, getAllImages } from './imageDB.js';

// === 状態管理 ===

const listeners = new Set();
let status = { state: 'idle', message: '' };

function setStatus(state, message = '') {
  status = { state, message };
  for (const fn of listeners) {
    try { fn(status); } catch { /* ignore */ }
  }
}

export function subscribeStatus(fn) {
  listeners.add(fn);
  fn(status);
  return () => listeners.delete(fn);
}

export function getStatus() {
  return status;
}

// === panels 行 ↔ ローカル item 変換 ===

function rowToItem(row) {
  return {
    id: row.id,
    name: row.name || '',
    ruby: row.ruby || '',
    title: row.title || '',
    label: row.label || '',
    image: '',                              // 画像本体は IndexedDB に置く
    imgX: row.img_x ?? 50,
    imgY: row.img_y ?? 50,
    imgScale: row.img_scale ?? 100,
    order: row.order ?? 0,
    visible: row.visible !== false,
    isNewFace: !!row.is_new_face,
    selectable: row.selectable !== false,
    hasImage: !!row.has_image,
    _imagePath: row.image_path || '',       // 内部用
    _updatedAt: row.updated_at || null,
  };
}

function itemToRow(item) {
  return {
    id: item.id,
    name: item.name || '',
    ruby: item.ruby || '',
    title: item.title || '',
    label: item.label || '',
    image_path: item._imagePath || (item.hasImage ? `${item.id}.jpg` : ''),
    img_x: Number(item.imgX ?? 50),
    img_y: Number(item.imgY ?? 50),
    img_scale: Number(item.imgScale ?? 100),
    order: Number(item.order ?? 0),
    visible: item.visible !== false,
    is_new_face: !!item.isNewFace,
    selectable: item.selectable !== false,
    has_image: !!item.hasImage,
  };
}

// === 画像アップロード/ダウンロード ===

// data:URL を Blob に変換
function dataUrlToBlob(dataUrl) {
  const [meta, b64] = dataUrl.split(',');
  const mime = (meta.match(/data:([^;]+)/) || [])[1] || 'application/octet-stream';
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

async function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(blob);
  });
}

async function uploadImage(id, dataUrl) {
  const path = `${id}.jpg`;
  const blob = dataUrlToBlob(dataUrl);
  const { error } = await supabase.storage.from(PANEL_BUCKET).upload(path, blob, {
    contentType: blob.type || 'image/jpeg',
    upsert: true,
  });
  if (error) throw error;
  return path;
}

async function downloadImageAsDataUrl(path) {
  if (!path) return '';
  const url = publicImageUrl(path) + `?t=${Date.now()}`;
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`画像取得失敗: ${res.status}`);
  const blob = await res.blob();
  return await blobToDataUrl(blob);
}

async function deleteRemoteImage(path) {
  if (!path) return;
  await supabase.storage.from(PANEL_BUCKET).remove([path]);
}

// === Supabase ↔ ローカル 全件同期 ===

// クラウド → ローカル
async function pullAll() {
  setStatus('syncing', 'クラウドから取得中…');
  const { data: rows, error } = await supabase
    .from('panels')
    .select('*')
    .order('order', { ascending: true });
  if (error) throw error;

  const items = rows.map(rowToItem);

  // ローカル画像が無いものだけ Storage からダウンロード
  const localImages = await getAllImages();
  for (const item of items) {
    if (item.hasImage && item._imagePath && !localImages[item.id]) {
      try {
        const dataUrl = await downloadImageAsDataUrl(item._imagePath);
        await saveImage(item.id, dataUrl);
      } catch (e) {
        // 画像取得失敗は致命ではない、続行
        console.warn('画像取得失敗', item.id, e);
      }
    }
  }

  // ローカル data に書き戻し
  saveData({ items: items.map((it) => {
    const { _imagePath, _updatedAt, ...rest } = it;
    return rest;
  })});

  return items;
}

// ローカル → クラウド（初回マイグレーション用）
async function pushAll() {
  setStatus('syncing', 'クラウドへ送信中…');
  const data = loadData();
  const localImages = await getAllImages();

  // 画像を Storage にアップロード
  for (const item of data.items) {
    if (item.hasImage && localImages[item.id]) {
      await uploadImage(item.id, localImages[item.id]);
    }
  }

  // panels 行を upsert
  const rows = data.items.map((item) => itemToRow({
    ...item,
    _imagePath: item.hasImage ? `${item.id}.jpg` : '',
  }));
  if (rows.length > 0) {
    const { error } = await supabase.from('panels').upsert(rows);
    if (error) throw error;
  }
}

// === 公開 API: 1パネル単位の同期 ===

// パネル保存（追加/更新）
// imageDataUrl: 新画像があるとき data:URL を渡す。null なら画像変更なし。
export async function syncSavePanel(item, imageDataUrl = null) {
  try {
    let imagePath = item.hasImage ? `${item.id}.jpg` : '';
    if (imageDataUrl) {
      imagePath = await uploadImage(item.id, imageDataUrl);
    }
    const row = itemToRow({ ...item, _imagePath: imagePath, hasImage: !!imagePath });
    const { error } = await supabase.from('panels').upsert(row);
    if (error) throw error;
    setStatus('connected');
  } catch (e) {
    setStatus('error', e.message || String(e));
    throw e;
  }
}

export async function syncDeletePanel(id) {
  try {
    await deleteRemoteImage(`${id}.jpg`);
    const { error } = await supabase.from('panels').delete().eq('id', id);
    if (error) throw error;
    setStatus('connected');
  } catch (e) {
    setStatus('error', e.message || String(e));
    throw e;
  }
}

// 並べ替え結果を一括反映
export async function syncBulkUpdateOrder(items) {
  try {
    const rows = items.map((it) => ({ id: it.id, order: Number(it.order ?? 0) }));
    const { error } = await supabase.from('panels').upsert(rows);
    if (error) throw error;
    setStatus('connected');
  } catch (e) {
    setStatus('error', e.message || String(e));
    throw e;
  }
}

// 表示/非表示・新人タグ等の小フィールド更新
export async function syncPatchPanel(id, patch) {
  try {
    const row = {};
    if ('visible' in patch) row.visible = !!patch.visible;
    if ('isNewFace' in patch) row.is_new_face = !!patch.isNewFace;
    if ('selectable' in patch) row.selectable = patch.selectable !== false;
    if (Object.keys(row).length === 0) return;
    const { error } = await supabase.from('panels').update(row).eq('id', id);
    if (error) throw error;
    setStatus('connected');
  } catch (e) {
    setStatus('error', e.message || String(e));
    throw e;
  }
}

// === Realtime 購読 ===

let realtimeChannel = null;

export function startRealtime(onChange) {
  if (realtimeChannel) return;
  realtimeChannel = supabase
    .channel('panels-changes')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'panels' }, async (payload) => {
      try {
        await pullAll();
        if (onChange) onChange(payload);
      } catch (e) {
        console.warn('realtime pull 失敗', e);
      }
    })
    .subscribe((s) => {
      if (s === 'SUBSCRIBED') setStatus('connected');
    });
}

export function stopRealtime() {
  if (realtimeChannel) {
    supabase.removeChannel(realtimeChannel);
    realtimeChannel = null;
  }
}

// === 初期化 ===

// 初回セットアップ：クラウドの状態に応じて pull / push を選ぶ
// - クラウドに行がある → pull（クラウド優先）
// - クラウドが空 & ローカルに既存データあり → push
export async function initialSync() {
  try {
    setStatus('syncing', '同期確認中…');
    const { count, error } = await supabase
      .from('panels')
      .select('*', { count: 'exact', head: true });
    if (error) throw error;

    if ((count || 0) === 0) {
      const local = loadData();
      const hasLocal = local.items.some((it) => it.name || it.label || it.hasImage);
      if (hasLocal) {
        await pushAll();
      }
    } else {
      await pullAll();
    }
    setStatus('connected');
  } catch (e) {
    setStatus('error', e.message || String(e));
    throw e;
  }
}

// 強制再同期（admin の「再同期」ボタン）
export async function forcePull() {
  try {
    await pullAll();
    setStatus('connected');
  } catch (e) {
    setStatus('error', e.message || String(e));
    throw e;
  }
}

export async function forcePush() {
  try {
    await pushAll();
    setStatus('connected');
  } catch (e) {
    setStatus('error', e.message || String(e));
    throw e;
  }
}
