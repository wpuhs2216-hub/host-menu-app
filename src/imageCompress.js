// 画像圧縮ユーティリティ
// File または base64 (data:URL) を受け取り、長辺を maxSize に収め JPEG quality で再エンコードした data:URL を返す

const DEFAULTS = {
  maxSize: 1280,    // 長辺の最大ピクセル
  quality: 0.82,    // JPEG quality
  mimeType: 'image/jpeg',
};

// File → HTMLImageElement
function loadImageFromFile(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = (e) => { URL.revokeObjectURL(url); reject(e); };
    img.src = url;
  });
}

// base64(data:URL) → HTMLImageElement
function loadImageFromDataUrl(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = (e) => reject(e);
    img.src = dataUrl;
  });
}

// data:URL の概算バイト数
export function dataUrlByteSize(dataUrl) {
  if (!dataUrl || typeof dataUrl !== 'string') return 0;
  const comma = dataUrl.indexOf(',');
  if (comma < 0) return dataUrl.length;
  const b64 = dataUrl.slice(comma + 1);
  // base64 1文字 = 6bit、4文字で3バイト。末尾の '=' を引く
  const padding = (b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0);
  return Math.floor(b64.length * 3 / 4) - padding;
}

// メイン圧縮関数
// input: File | string(data:URL)
// returns: data:URL string (JPEG)
export async function compressImage(input, options = {}) {
  const opt = { ...DEFAULTS, ...options };

  // 入力を Image に変換
  let img;
  try {
    if (input instanceof File || input instanceof Blob) {
      img = await loadImageFromFile(input);
    } else if (typeof input === 'string' && input.startsWith('data:')) {
      img = await loadImageFromDataUrl(input);
    } else {
      throw new Error('compressImage: 対応していない入力形式');
    }
  } catch (e) {
    // 読み込み失敗時は元データを返す（File の場合は base64 化を試みる）
    if (typeof input === 'string') return input;
    throw e;
  }

  const w = img.naturalWidth;
  const h = img.naturalHeight;
  if (!w || !h) {
    if (typeof input === 'string') return input;
    throw new Error('compressImage: 画像サイズを取得できません');
  }

  // 縮小率を計算（長辺基準・拡大はしない）
  const longSide = Math.max(w, h);
  const scale = longSide > opt.maxSize ? opt.maxSize / longSide : 1;
  const targetW = Math.round(w * scale);
  const targetH = Math.round(h * scale);

  const canvas = document.createElement('canvas');
  canvas.width = targetW;
  canvas.height = targetH;
  const ctx = canvas.getContext('2d');
  // 高品質縮小
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, targetW, targetH);

  let dataUrl;
  try {
    dataUrl = canvas.toDataURL(opt.mimeType, opt.quality);
  } catch (e) {
    // toDataURL が失敗した場合のフォールバック
    if (typeof input === 'string') return input;
    throw e;
  }

  // 圧縮結果が元より大きい場合は元を返す（base64 入力時のみ可能）
  if (typeof input === 'string') {
    if (dataUrlByteSize(dataUrl) >= dataUrlByteSize(input)) {
      return input;
    }
  }

  return dataUrl;
}
