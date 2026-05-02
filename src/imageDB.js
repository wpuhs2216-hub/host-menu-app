// IndexedDBによる画像ストレージ
const DB_NAME = 'host-menu-images';
const STORE_NAME = 'images';
const DB_VERSION = 1;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      e.target.result.createObjectStore(STORE_NAME);
    };
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror = (e) => reject(e.target.error);
  });
}

export async function saveImage(id, base64) {
  if (!base64) return;
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(base64, id);
    tx.oncomplete = () => resolve();
    tx.onerror = (e) => reject(e.target.error);
  });
}

export async function getImage(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).get(id);
    req.onsuccess = () => resolve(req.result || '');
    req.onerror = (e) => reject(e.target.error);
  });
}

export async function deleteImage(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = (e) => reject(e.target.error);
  });
}

export async function getAllImages() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const keys = store.getAllKeys();
    const vals = store.getAll();
    tx.oncomplete = () => {
      const map = {};
      keys.result.forEach((k, i) => { map[k] = vals.result[i]; });
      resolve(map);
    };
    tx.onerror = (e) => reject(e.target.error);
  });
}

export async function clearImages() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = (e) => reject(e.target.error);
  });
}

// 旧localStorage画像データをIndexedDBに移行
export async function migrateFromLocalStorage(items) {
  let migrated = false;
  for (const item of items) {
    if (item.image && item.image.startsWith('data:')) {
      await saveImage(item.id, item.image);
      item.hasImage = true;
      item.image = '';
      migrated = true;
    }
  }
  return migrated;
}
