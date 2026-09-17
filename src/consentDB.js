// 署名済み同意書の端末内ストレージ（IndexedDB）
// - 署名はまずこの端末に保存する。クラウド送信は任意（consent.js 側で判断）
// - meta ストア: 1 件 = 1 レコード（doc_text 等のメタ情報 + 同期状態）
// - image ストア: 書類画像・署名画像を dataURL で保持（キーは meta.id / meta.id + '__sig'）

const DB_NAME = 'host-menu-consents';
const META_STORE = 'meta';
const IMAGE_STORE = 'images';
const DB_VERSION = 1;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(META_STORE)) {
        const store = db.createObjectStore(META_STORE, { keyPath: 'id' });
        // 店舗ごとに新しい順で引くため
        store.createIndex('by_store_signed', ['storeId', 'signedAt']);
      }
      if (!db.objectStoreNames.contains(IMAGE_STORE)) {
        db.createObjectStore(IMAGE_STORE);
      }
    };
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror = (e) => reject(e.target.error);
  });
}

// 1 件保存（メタ + 画像2枚をまとめて）
export async function saveConsentLocal(meta, { documentImage = '', signatureImage = '' } = {}) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([META_STORE, IMAGE_STORE], 'readwrite');
    tx.objectStore(META_STORE).put(meta);
    const imgs = tx.objectStore(IMAGE_STORE);
    if (documentImage) imgs.put(documentImage, meta.id);
    if (signatureImage) imgs.put(signatureImage, `${meta.id}__sig`);
    tx.oncomplete = () => resolve(meta);
    tx.onerror = (e) => reject(e.target.error);
  });
}

// 店舗の署名一覧（新しい順）
export async function listConsentsLocal(storeId, limit = 50) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(META_STORE, 'readonly');
    const req = tx.objectStore(META_STORE).getAll();
    req.onsuccess = () => {
      const rows = (req.result || [])
        .filter((r) => !storeId || r.storeId === storeId)
        .sort((a, b) => String(b.signedAt).localeCompare(String(a.signedAt)))
        .slice(0, limit);
      resolve(rows);
    };
    req.onerror = (e) => reject(e.target.error);
  });
}

export async function getConsentImage(key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IMAGE_STORE, 'readonly');
    const req = tx.objectStore(IMAGE_STORE).get(key);
    req.onsuccess = () => resolve(req.result || '');
    req.onerror = (e) => reject(e.target.error);
  });
}

// クラウド送信が済んだ 1 件に印を付ける
export async function markSynced(id, synced = true, serverSignedAt = '') {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(META_STORE, 'readwrite');
    const store = tx.objectStore(META_STORE);
    const req = store.get(id);
    req.onsuccess = () => {
      const row = req.result;
      if (row) {
        row.synced = !!synced;
        row.syncedAt = synced ? new Date().toISOString() : '';
        // クラウドが打った署名時刻（端末の時計に依らない正）。受け取れた時だけ残す
        if (serverSignedAt) row.serverSignedAt = serverSignedAt;
        store.put(row);
      }
    };
    tx.oncomplete = () => resolve();
    tx.onerror = (e) => reject(e.target.error);
  });
}

// 未送信の署名（クラウド保存をオンにした時にまとめて送る用）
export async function listUnsyncedLocal(storeId) {
  const rows = await listConsentsLocal(storeId, 1000);
  return rows.filter((r) => !r.synced);
}

export async function deleteConsentLocal(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([META_STORE, IMAGE_STORE], 'readwrite');
    tx.objectStore(META_STORE).delete(id);
    const imgs = tx.objectStore(IMAGE_STORE);
    imgs.delete(id);
    imgs.delete(`${id}__sig`);
    tx.oncomplete = () => resolve();
    tx.onerror = (e) => reject(e.target.error);
  });
}

// 端末内の使用量の目安（バイト）。画像は dataURL 長からおおよそで見積もる
export async function localUsage(storeId) {
  const rows = await listConsentsLocal(storeId, 1000);
  let bytes = 0;
  for (const r of rows) {
    for (const key of [r.id, `${r.id}__sig`]) {
      const s = await getConsentImage(key);
      if (s) bytes += Math.round(s.length * 0.75);   // base64 → 実バイト
    }
  }
  return { count: rows.length, bytes };
}
