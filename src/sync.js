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
    imageVersion: row.image_version ?? 0,   // 画像差し替え検知用
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
    image_version: Number(item.imageVersion ?? 0),
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
    cacheControl: '0',                       // 同一パス上書きで CDN が古い画像を返さないように
  });
  if (error) throw error;
  return path;
}

async function downloadImageAsDataUrl(path, version = '') {
  if (!path) return '';
  // version をキャッシュキーに使う（CDN がクエリを無視する場合でも version 変化で別URL扱いになる）
  const bust = version || Date.now();
  const url = publicImageUrl(path) + `?v=${bust}`;
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

  // ローカル画像が無い or バージョンが上がったものを Storage からダウンロード
  const localImages = await getAllImages();
  const prevData = loadData();
  const prevVersionById = {};
  for (const it of (prevData.items || [])) prevVersionById[it.id] = it.imageVersion ?? 0;

  for (const item of items) {
    if (item.hasImage && item._imagePath) {
      const remoteVersion = item.imageVersion ?? 0;
      const hasLocal = !!localImages[item.id];
      const needFetch = !hasLocal || remoteVersion !== (prevVersionById[item.id] ?? -1);
      if (!needFetch) continue;
      try {
        const dataUrl = await downloadImageAsDataUrl(item._imagePath, remoteVersion);
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

// === Realtime 購読（差分反映） ===

let realtimeChannel = null;

// payload を受け取って該当行だけローカルに反映
async function applyRealtimePayload(payload) {
  const { eventType } = payload;
  if (eventType === 'DELETE') {
    const id = (payload.old && payload.old.id) || null;
    if (!id) return;
    const cur = loadData();
    cur.items = (cur.items || []).filter((it) => it.id !== id);
    saveData(cur);
    try { await deleteImage(id); } catch { /* ignore */ }
    return;
  }
  // INSERT / UPDATE
  const row = payload.new;
  if (!row || !row.id) return;
  const newItem = rowToItem(row);

  const cur = loadData();
  const items = cur.items || [];
  const idx = items.findIndex((it) => it.id === newItem.id);

  // マージ前にローカルが持つ画像バージョンを退避（差し替え検知用）
  const prevVersion = idx >= 0 ? (items[idx].imageVersion ?? 0) : -1;

  // 内部用フィールドを除外して保存
  const { _imagePath, _updatedAt, ...clean } = newItem;
  if (idx >= 0) items[idx] = { ...items[idx], ...clean };
  else items.push(clean);
  cur.items = items;
  saveData(cur);

  // 画像差分: ローカルに無い or バージョンが上がっていれば再 DL（差し替え・INSERT を含む）
  if (newItem.hasImage && newItem._imagePath) {
    try {
      const localImages = await getAllImages();
      const remoteVersion = newItem.imageVersion ?? 0;
      const hasLocal = !!localImages[newItem.id];
      const needFetch = !hasLocal || remoteVersion !== prevVersion;
      if (needFetch) {
        const dataUrl = await downloadImageAsDataUrl(newItem._imagePath, remoteVersion);
        await saveImage(newItem.id, dataUrl);
      }
    } catch (e) {
      console.warn('画像取得失敗', newItem.id, e);
    }
  } else if (!newItem.hasImage) {
    // 画像が外された
    try { await deleteImage(newItem.id); } catch { /* ignore */ }
  }
}

export function startRealtime(onChange) {
  if (realtimeChannel) return;
  realtimeChannel = supabase
    .channel('panels-changes')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'panels' }, async (payload) => {
      try {
        await applyRealtimePayload(payload);
        if (onChange) onChange(payload);
      } catch (e) {
        console.warn('realtime apply 失敗', e);
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

// === orders 同期（注文履歴を全端末で共有） ===

// device_id（端末識別。クラッシュレポート用、user 区別はしない）
function deviceId() {
  let id = localStorage.getItem('host-menu-device-id');
  if (!id) {
    id = 'd-' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
    localStorage.setItem('host-menu-device-id', id);
  }
  return id;
}

// device_name（admin で設定する端末表示名。任意）
const DEVICE_NAME_KEY = 'host-menu-device-name';
export function getDeviceName() {
  return localStorage.getItem(DEVICE_NAME_KEY) || '';
}
export function setDeviceName(name) {
  localStorage.setItem(DEVICE_NAME_KEY, name || '');
}

function orderToRow(order, source = 'main') {
  return {
    id: order.id,
    seat: order.seat || '',
    customer_name: order.customerName || '',
    memo: order.memo || '',
    color: order.color || 'yellow',
    casts: order.casts || [],
    source,
    device_id: deviceId(),
    device_name: getDeviceName(),
    created_at: order.createdAt || new Date().toISOString(),
  };
}

function rowToOrder(row) {
  return {
    id: row.id,
    seat: row.seat || '',
    customerName: row.customer_name || '',
    memo: row.memo || '',
    color: row.color || 'yellow',
    casts: row.casts || [],
    source: row.source || 'main',
    deviceId: row.device_id || '',
    deviceName: row.device_name || '',
    createdAt: row.created_at || new Date().toISOString(),
  };
}

// 自端末 ID を外部公開（通知の重複防止用）
export function getSelfDeviceId() { return deviceId(); }

// === Web Push 購読情報の永続化 ===
export async function syncPushSubscriptionUpsert(subscription) {
  try {
    const json = subscription.toJSON();
    const { error } = await supabase.from('push_subscriptions').upsert({
      endpoint: json.endpoint,
      p256dh: json.keys.p256dh,
      auth: json.keys.auth,
      device_id: deviceId(),
      device_name: getDeviceName(),
    });
    if (error) throw error;
  } catch (e) { console.warn('push subscription upsert 失敗', e); }
}
export async function syncPushSubscriptionDelete(endpoint) {
  try {
    const { error } = await supabase.from('push_subscriptions').delete().eq('endpoint', endpoint);
    if (error) throw error;
  } catch (e) { console.warn('push subscription delete 失敗', e); }
}

export async function syncOrderInsert(order, source = 'main') {
  try {
    const { error } = await supabase.from('orders').insert(orderToRow(order, source));
    if (error) throw error;
  } catch (e) {
    console.warn('order insert 失敗', e);
  }
}

export async function syncOrderUpdate(id, patch) {
  try {
    const row = {};
    if ('seat' in patch) row.seat = patch.seat || '';
    if ('customerName' in patch) row.customer_name = patch.customerName || '';
    if ('memo' in patch) row.memo = patch.memo || '';
    if ('color' in patch) row.color = patch.color || 'yellow';
    if (Object.keys(row).length === 0) return;
    const { error } = await supabase.from('orders').update(row).eq('id', id);
    if (error) throw error;
  } catch (e) {
    console.warn('order update 失敗', e);
  }
}

export async function syncOrderDelete(id) {
  try {
    const { error } = await supabase.from('orders').delete().eq('id', id);
    if (error) throw error;
  } catch (e) {
    console.warn('order delete 失敗', e);
  }
}

export async function syncOrdersClear() {
  try {
    const { error } = await supabase.from('orders').delete().not('id', 'is', null);
    if (error) throw error;
  } catch (e) {
    console.warn('orders clear 失敗', e);
  }
}

export async function loadOrdersCloud() {
  try {
    const { data, error } = await supabase
      .from('orders')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(500);
    if (error) throw error;
    return (data || []).map(rowToOrder);
  } catch (e) {
    console.warn('orders fetch 失敗', e);
    return [];
  }
}

let ordersChannel = null;
export function startOrdersRealtime(handlers) {
  if (ordersChannel) return;
  ordersChannel = supabase
    .channel('orders-changes')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'orders' }, (payload) => {
      try {
        if (payload.eventType === 'DELETE') {
          handlers?.onDelete?.(payload.old?.id);
        } else if (payload.eventType === 'INSERT') {
          handlers?.onInsert?.(rowToOrder(payload.new));
        } else if (payload.eventType === 'UPDATE') {
          handlers?.onUpdate?.(rowToOrder(payload.new));
        }
      } catch (e) { console.warn('order realtime apply 失敗', e); }
    })
    .subscribe();
}

// === selections 同期（チェック中キャスト共有・複数色対応） ===
// 1キャストに複数色を許す。PK は (panel_id, color)

export async function syncSelectionAdd(panelId, color) {
  try {
    const { error } = await supabase
      .from('selections')
      .upsert({ panel_id: panelId, color: color || 'yellow' });
    if (error) throw error;
  } catch (e) {
    console.warn('selection add 失敗', e);
  }
}

export async function syncSelectionRemove(panelId, color) {
  try {
    let q = supabase.from('selections').delete().eq('panel_id', panelId);
    if (color) q = q.eq('color', color);
    const { error } = await q;
    if (error) throw error;
  } catch (e) {
    console.warn('selection remove 失敗', e);
  }
}

export async function syncSelectionsClear() {
  try {
    const { error } = await supabase.from('selections').delete().not('panel_id', 'is', null);
    if (error) throw error;
  } catch (e) {
    console.warn('selections clear 失敗', e);
  }
}

export async function loadSelections() {
  try {
    const { data, error } = await supabase.from('selections').select('panel_id,color');
    if (error) throw error;
    return data || [];
  } catch (e) {
    console.warn('selections fetch 失敗', e);
    return [];
  }
}

let selectionsChannel = null;

export function startSelectionsRealtime(handlers) {
  if (selectionsChannel) return;
  // handlers: { onAdd(panelId, color), onRemove(panelId, color) }
  selectionsChannel = supabase
    .channel('selections-changes')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'selections' }, (payload) => {
      try {
        if (payload.eventType === 'DELETE') {
          const o = payload.old || {};
          if (o.panel_id) handlers?.onRemove?.(o.panel_id, o.color || null);
        } else {
          const r = payload.new || {};
          if (r.panel_id) handlers?.onAdd?.(r.panel_id, r.color || 'yellow');
        }
      } catch (e) { console.warn('selection realtime apply 失敗', e); }
    })
    .subscribe();
}

// === クラウドバックアップ/復元（panels 同期とは独立） ===
// Supabase Storage に backups/<タイムスタンプ>.json として全データを保存

const BACKUP_FOLDER = 'backups';

export async function cloudBackup(label = '') {
  setStatus('syncing', 'バックアップ作成中…');
  try {
    // 全データを収集
    const { loadData: ld, loadOrders: lo, loadSettings: ls, getAdminPw: gp } = await import('./store.js');
    const data = ld();
    const orders = lo();
    const settings = ls();
    const adminPw = gp();
    const images = await getAllImages();

    const snapshot = {
      version: 1,
      createdAt: new Date().toISOString(),
      label: label || '',
      items: data,
      orders,
      settings,
      adminPw,
      images,
    };

    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `${BACKUP_FOLDER}/${ts}.json`;
    const blob = new Blob([JSON.stringify(snapshot)], { type: 'application/json' });
    const { error } = await supabase.storage.from(PANEL_BUCKET).upload(filename, blob, {
      contentType: 'application/json',
      upsert: false,
    });
    if (error) throw error;
    setStatus('connected');
    return { filename, size: blob.size, createdAt: snapshot.createdAt };
  } catch (e) {
    setStatus('error', e.message || String(e));
    throw e;
  }
}

export async function cloudBackupList() {
  const { data, error } = await supabase.storage.from(PANEL_BUCKET).list(BACKUP_FOLDER, {
    limit: 100,
    sortBy: { column: 'created_at', order: 'desc' },
  });
  if (error) throw error;
  return (data || []).filter((f) => f.name && f.name.endsWith('.json'));
}

export async function cloudBackupRestore(filename) {
  setStatus('syncing', 'バックアップから復元中…');
  try {
    const path = filename.startsWith(BACKUP_FOLDER) ? filename : `${BACKUP_FOLDER}/${filename}`;
    const { data: blob, error } = await supabase.storage.from(PANEL_BUCKET).download(path);
    if (error) throw error;
    const text = await blob.text();
    const snap = JSON.parse(text);

    const { saveData, importAllData, setAdminPw } = await import('./store.js');
    const { saveImage, clearImages } = await import('./imageDB.js');

    // ローカル全部置き換え
    if (snap.items) saveData(snap.items);
    if (snap.orders || snap.settings) {
      const payload = {};
      if (snap.items) payload.items = snap.items;
      if (snap.orders) payload.orders = snap.orders;
      if (snap.settings) payload.settings = snap.settings;
      importAllData(payload);
    }
    if (snap.adminPw) setAdminPw(snap.adminPw);

    if (snap.images) {
      await clearImages();
      for (const [id, img] of Object.entries(snap.images)) {
        await saveImage(id, img);
      }
    }
    setStatus('connected');
  } catch (e) {
    setStatus('error', e.message || String(e));
    throw e;
  }
}

export async function cloudBackupDelete(filename) {
  const path = filename.startsWith(BACKUP_FOLDER) ? filename : `${BACKUP_FOLDER}/${filename}`;
  const { error } = await supabase.storage.from(PANEL_BUCKET).remove([path]);
  if (error) throw error;
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
