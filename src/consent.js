// デジタル署名（ご新規様同意書）— テストモード用
// - 書類は HTML で表示し、署名は canvas に手書きする
// - 保存時に「署名だけの透過PNG」と「書類全体を焼いた画像」を storage に上げ、
//   consents テーブルへ 1 行 insert する（追記専用。DB 側で UPDATE/DELETE は拒否）
// - 「何に同意したか」を後から再現できるよう、表示した本文をそのまま doc_text に残す

import { registerPlugin, Capacitor } from '@capacitor/core';
import { supabase } from './supabaseClient.js';
import { getStoreId, getStoreName } from './storeContext.js';
import { requireUnlock, hasLockPattern } from './lockAuth.js';
import { getDeviceName, getSelfDeviceId } from './sync.js';
import { loadSettings } from './store.js';
import {
  saveConsentLocal, listConsentsLocal, getConsentImage,
  markSynced, listUnsyncedLocal, localUsage,
} from './consentDB.js';
import * as dlg from './dialog.js';
import './consent.css';

export const CONSENT_BUCKET = 'consent-images';

// 端末のアルバムへ保存するネイティブプラグイン（APK 版のみ実体あり）
const AlbumSaver = registerPlugin('AlbumSaver');
const IS_CAPACITOR = !!(Capacitor && Capacitor.isNativePlatform && Capacitor.isNativePlatform());
const ALBUM_NAME = '同意書';

// 書類の版。本文を変えたら必ず版も上げる（過去の同意がどの本文だったか追えなくなるため）
export const DOC_VERSION = 'spl-v1';

export const DOC = {
  title: 'S.P.L　ご新規様同意書',
  lead: [
    '私は、下記の通りS.P.Lに来店したことを同意し、',
    '事実に相違がないことを確認いたします。',
  ],
  routeHeading: '【来店経路】',
  routeNote: '※該当する番号にチェックをご記入ください',
  routes: [
    '①路上での声掛けにより来店',
    '②案内所からのご案内で来店',
    '③その他／自らの意思で来店',
  ],
  noticeHeading: '【注意事項】',
  notice: [
    '当店は違法なキャッチ・勧誘行為を行っておりません。',
    '来店経路に虚偽があった場合、',
    'いかなるトラブルにも当店は責任を負いかねます。',
    '上記内容にご理解のうえご署名をお願いいたします。',
  ],
  signHeading: '【署名】',
  signLead: '私は上記内容に相違なく、確認のうえ署名いたします。',
};

// doc_text（保存用の本文スナップショット）。表示と同じ文言から組み立てる
export function buildDocText() {
  return [
    DOC.title,
    '',
    ...DOC.lead,
    '',
    DOC.routeHeading,
    DOC.routeNote,
    ...DOC.routes,
    '',
    DOC.noticeHeading,
    ...DOC.notice,
    '',
    DOC.signHeading,
    DOC.signLead,
  ].join('\n');
}

function genId() {
  return `consent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function sha256Hex(text) {
  try {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    return '';
  }
}

function dataUrlToBlob(dataUrl) {
  const [head, body] = dataUrl.split(',');
  const mime = /:(.*?);/.exec(head)?.[1] || 'image/png';
  const bin = atob(body);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: mime });
}

// 書類に載せる来店日時は日付まで（原本が「__年__月__日」のため）。
// 記録用の正確な時刻は signedAt に別途残している
function fmtDate(d) {
  const w = ['日', '月', '火', '水', '木', '金', '土'][d.getDay()];
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日(${w})`;
}

// === 署名キャンバス ===
// 指/スタイラス用。筆圧は取れないので、速度に応じて線幅を変えて手書きらしく見せる。
function createSignaturePad(canvas) {
  const ctx = canvas.getContext('2d');
  let strokes = [];       // [[{x,y,w}...], ...] 取り消し用に線ごとに保持
  let current = null;
  let last = null;
  let dirty = false;

  function fit() {
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    redraw();
  }

  function redraw() {
    const rect = canvas.getBoundingClientRect();
    ctx.clearRect(0, 0, rect.width, rect.height);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#111';
    for (const st of strokes) {
      for (let i = 1; i < st.length; i++) {
        ctx.beginPath();
        ctx.lineWidth = st[i].w;
        ctx.moveTo(st[i - 1].x, st[i - 1].y);
        ctx.lineTo(st[i].x, st[i].y);
        ctx.stroke();
      }
    }
  }

  function pos(e) {
    const rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  function down(e) {
    e.preventDefault();
    canvas.setPointerCapture?.(e.pointerId);
    const p = pos(e);
    current = [{ ...p, w: 3 }];
    strokes.push(current);
    last = p;
    dirty = true;
  }

  function move(e) {
    if (!current) return;
    e.preventDefault();
    const p = pos(e);
    const d = Math.hypot(p.x - last.x, p.y - last.y);
    // 速く動かすほど細く（3.6px → 1.4px あたりに収める）
    const w = Math.max(1.4, 3.6 - d * 0.12);
    current.push({ ...p, w });
    ctx.beginPath();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#111';
    ctx.lineWidth = w;
    ctx.moveTo(last.x, last.y);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    last = p;
  }

  function up(e) {
    if (!current) return;
    e.preventDefault();
    current = null;
  }

  canvas.addEventListener('pointerdown', down);
  canvas.addEventListener('pointermove', move);
  canvas.addEventListener('pointerup', up);
  canvas.addEventListener('pointercancel', up);
  canvas.addEventListener('pointerleave', up);

  return {
    fit,
    isEmpty: () => !dirty || strokes.length === 0,
    undo() { strokes.pop(); redraw(); if (strokes.length === 0) dirty = false; },
    clear() { strokes = []; dirty = false; redraw(); },
    // 余白を落とした透過 PNG を返す
    toTrimmedPng() {
      const rect = canvas.getBoundingClientRect();
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const st of strokes) {
        for (const p of st) {
          minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
          minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
        }
      }
      if (!isFinite(minX)) return '';
      const pad = 8;
      minX = Math.max(0, minX - pad); minY = Math.max(0, minY - pad);
      maxX = Math.min(rect.width, maxX + pad); maxY = Math.min(rect.height, maxY + pad);
      const w = Math.max(1, Math.round(maxX - minX));
      const h = Math.max(1, Math.round(maxY - minY));
      const out = document.createElement('canvas');
      const scale = 2;                        // 印刷しても粗くならない程度に
      out.width = w * scale; out.height = h * scale;
      const octx = out.getContext('2d');
      octx.scale(scale, scale);
      octx.translate(-minX, -minY);
      octx.lineCap = 'round';
      octx.lineJoin = 'round';
      octx.strokeStyle = '#111';
      for (const st of strokes) {
        for (let i = 1; i < st.length; i++) {
          octx.beginPath();
          octx.lineWidth = st[i].w;
          octx.moveTo(st[i - 1].x, st[i - 1].y);
          octx.lineTo(st[i].x, st[i].y);
          octx.stroke();
        }
      }
      return out.toDataURL('image/png');
    },
  };
}

// === 書類全体を 1 枚の画像に焼く ===
// html2canvas 等は入れず、canvas に直接描く（依存ゼロ・日本語もそのまま出る）
function renderDocumentImage({ route, idChecked, customerName, signaturePng, signedAt }) {
  return new Promise((resolve) => {
    const W = 1240, H = 1754;               // A4 相当（150dpi）
    const cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    const c = cv.getContext('2d');

    c.fillStyle = '#fff';
    c.fillRect(0, 0, W, H);
    c.fillStyle = '#111';
    c.textBaseline = 'top';

    const center = (text, y, font) => {
      c.font = font;
      c.textAlign = 'center';
      c.fillText(text, W / 2, y);
    };
    const left = (text, x, y, font) => {
      c.font = font;
      c.textAlign = 'left';
      c.fillText(text, x, y);
    };

    let y = 110;
    center(DOC.title, y, 'bold 46px serif'); y += 90;
    for (const line of DOC.lead) { center(line, y, '26px sans-serif'); y += 40; }
    y += 40;

    center(DOC.routeHeading, y, 'bold 28px sans-serif'); y += 46;
    center(DOC.routeNote, y, '22px sans-serif'); y += 46;
    for (let i = 0; i < DOC.routes.length; i++) {
      const bx = 380, by = y + 4;
      c.strokeStyle = '#111'; c.lineWidth = 2;
      c.strokeRect(bx, by, 24, 24);
      if (route === i + 1) {                 // 選んだ項目にレ点
        c.beginPath();
        c.lineWidth = 4;
        c.moveTo(bx + 4, by + 13);
        c.lineTo(bx + 10, by + 20);
        c.lineTo(bx + 21, by + 4);
        c.stroke();
      }
      left(DOC.routes[i], bx + 40, y, '26px sans-serif');
      y += 46;
    }
    y += 50;

    center(DOC.noticeHeading, y, 'bold 28px sans-serif'); y += 46;
    for (const line of DOC.notice) { center(line, y, '25px sans-serif'); y += 40; }
    y += 46;

    center(DOC.signHeading, y, 'bold 28px sans-serif'); y += 46;
    // 署名は下線の上へ最大 100px で描くので、本文と重ならないだけの間隔を空ける
    center(DOC.signLead, y, '25px sans-serif'); y += 150;

    // 署名欄
    const labelX = 150;
    left('お名前(署名) :', labelX, y, '26px sans-serif');
    const lineX1 = labelX + 220, lineX2 = W - 150, lineY = y + 44;
    c.lineWidth = 2;
    c.beginPath(); c.moveTo(lineX1, lineY); c.lineTo(lineX2, lineY); c.stroke();

    const drawRest = () => {
      let yy = lineY + 60;
      left(`来店日時 :　${fmtDate(signedAt)}`, labelX, yy, '26px sans-serif');
      yy += 70;
      left('身分証確認 :', labelX, yy, '26px sans-serif');
      const bx = labelX + 200;
      for (const [i, lbl] of ['済', '未'].entries()) {
        const x = bx + i * 130;
        c.strokeRect(x, yy + 4, 24, 24);
        const on = (i === 0) === !!idChecked;
        if (on) {
          c.beginPath();
          c.lineWidth = 4;
          c.moveTo(x + 4, yy + 17); c.lineTo(x + 10, yy + 24); c.lineTo(x + 21, yy + 8);
          c.stroke();
          c.lineWidth = 2;
        }
        left(lbl, x + 36, yy, '26px sans-serif');
      }
      yy += 90;
      if (customerName) left(`伝票名 :　${customerName}`, labelX, yy, '24px sans-serif');

      // フッタ（記録用の由来情報）
      c.fillStyle = '#666';
      left(`${getStoreName() || getStoreId()}　/　端末: ${getDeviceName() || '未設定'}　/　${DOC_VERSION}`,
        labelX, H - 70, '20px sans-serif');
      resolve(cv.toDataURL('image/jpeg', 0.85));
    };

    if (signaturePng) {
      const img = new Image();
      img.onload = () => {
        // 署名を線の上に収める
        const maxW = lineX2 - lineX1 - 20;
        const maxH = 100;
        const r = Math.min(maxW / img.width, maxH / img.height);
        const w = img.width * r, h = img.height * r;
        c.drawImage(img, lineX1 + 10, lineY - h - 4, w, h);
        drawRest();
      };
      img.onerror = () => drawRest();
      img.src = signaturePng;
    } else {
      drawRest();
    }
  });
}

async function uploadPng(path, dataUrl) {
  const blob = dataUrlToBlob(dataUrl);
  const { error } = await supabase.storage.from(CONSENT_BUCKET).upload(path, blob, {
    contentType: blob.type,
    upsert: false,          // 同意書は上書きしない
    cacheControl: '3600',
  });
  if (error) throw error;
  return path;
}

// クラウドにも保存するか（既定オフ＝この端末の中だけに置く）
export function isCloudSaveEnabled() {
  return !!loadSettings().consentCloudSave;
}

// 伝票名（ひらがな）の入力欄を出すか（既定オフ）
export function isNameFieldEnabled() {
  return !!loadSettings().consentNameField;
}

// 端末のアルバムにも保存するか（既定オン）
export function isAlbumSaveEnabled() {
  const s = loadSettings();
  return s.consentAlbumSave !== false;
}

// 保存する画像のファイル名（アルバムで見て分かるように日時を入れる）
function albumFileName(signedAt, customerName) {
  const p = (n) => String(n).padStart(2, '0');
  const d = signedAt;
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  const who = (customerName || '').replace(/[\\/:*?"<>|]/g, '').slice(0, 20);
  return `同意書_${stamp}${who ? `_${who}` : ''}.jpg`;
}

// === 端末のアルバムへ保存 ===
// アプリ版はギャラリーへ、ブラウザ版はダウンロードにフォールバックする
export async function saveToAlbum(dataUrl, fileName) {
  if (!dataUrl) return { ok: false, reason: 'NO_DATA' };

  if (IS_CAPACITOR) {
    try {
      const res = await AlbumSaver.save({ data: dataUrl, fileName, album: ALBUM_NAME });
      return { ok: true, uri: res?.uri || '' };
    } catch (err) {
      const msg = String(err?.message || err || '');
      return { ok: false, reason: msg.includes('PERMISSION_DENIED') ? 'PERMISSION_DENIED' : msg };
    }
  }

  // ブラウザ: アルバムの概念がないのでファイルとして落とす
  try {
    const blob = dataUrlToBlob(dataUrl);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    return { ok: true, downloaded: true };
  } catch (err) {
    return { ok: false, reason: err?.message || String(err) };
  }
}

// === クラウドへ 1 件送る（ローカルに保存済みのものを送信する） ===
// 保存の本体はローカル側。ここは「送れたら送る」役割で、失敗しても署名自体は失われない。
export async function pushConsentToCloud(meta) {
  const documentImage = await getConsentImage(meta.id);
  const signatureImage = await getConsentImage(`${meta.id}__sig`);

  const signaturePath = `${meta.id}__sig.png`;
  const documentPath = `${meta.id}.jpg`;
  if (signatureImage) await uploadPng(signaturePath, signatureImage);
  if (documentImage) await uploadPng(documentPath, documentImage);

  const { error } = await supabase.from('consents').insert({
    id: meta.id,
    store_id: meta.storeId,
    route: meta.route,
    id_checked: !!meta.idChecked,
    customer_name: meta.customerName || '',
    signature_path: signaturePath,
    document_path: documentPath,
    doc_version: meta.docVersion,
    doc_text: meta.docText,
    device_name: meta.deviceName || '',
    device_id: meta.deviceId || '',
    hash: meta.hash || '',
    is_test: !!meta.isTest,
    signed_at: meta.signedAt,
  });
  if (error) throw error;
  await markSynced(meta.id, true);
  return true;
}

// 未送信ぶんをまとめて送る（クラウド保存をオンにした時や再送ボタン用）
export async function pushPendingConsents() {
  const pending = await listUnsyncedLocal(getStoreId());
  let ok = 0;
  const failed = [];
  for (const meta of pending) {
    try { await pushConsentToCloud(meta); ok++; } catch (e) { failed.push({ id: meta.id, error: e?.message || String(e) }); }
  }
  return { total: pending.length, ok, failed };
}

// === 保存 ===
// まず端末内（IndexedDB）に確定保存し、そのあとで必要ならクラウドへ送る。
// 通信が無くても署名は取れる／消えない、という順序にしてある。
export async function saveConsent({ route, idChecked, customerName, pad, isTest = true }) {
  const id = genId();
  const signedAt = new Date();
  const docText = buildDocText();

  const signaturePng = pad.toTrimmedPng();
  const documentJpg = await renderDocumentImage({
    route, idChecked, customerName, signaturePng, signedAt,
  });

  const hash = await sha256Hex([
    DOC_VERSION, docText, route, idChecked ? '1' : '0',
    customerName || '', signedAt.toISOString(), signaturePng.slice(0, 4096),
  ].join('|'));

  const meta = {
    id,
    storeId: getStoreId(),
    route,
    idChecked: !!idChecked,
    customerName: customerName || '',
    docVersion: DOC_VERSION,
    docText,
    deviceName: getDeviceName(),
    deviceId: getSelfDeviceId(),
    hash,
    isTest: !!isTest,
    signedAt: signedAt.toISOString(),
    synced: false,
    syncedAt: '',
  };

  // ① 端末内に保存（ここが本体。失敗したらエラーにする）
  await saveConsentLocal(meta, { documentImage: documentJpg, signatureImage: signaturePng });

  // ② 端末のアルバムにも残す（失敗しても署名自体は①で確定済み）
  if (isAlbumSaveEnabled()) {
    const r = await saveToAlbum(documentJpg, albumFileName(signedAt, customerName));
    meta.albumSaved = !!r.ok;
    if (!r.ok) meta.albumError = r.reason;
    // 保存結果を meta に反映（画像は①で入っているので再書き込みしない）
    await saveConsentLocal(meta);
  }

  // ③ クラウド保存が有効なら送る。失敗しても未送信として残すだけで、署名は端末に残る
  if (isCloudSaveEnabled()) {
    try {
      await pushConsentToCloud(meta);
      meta.synced = true;
    } catch (err) {
      console.warn('クラウド送信に失敗（端末内には保存済み）', err);
      meta.cloudError = err?.message || String(err);
    }
  }
  return meta;
}

// === 一覧取得（端末内から） ===
export async function listConsents(limit = 50) {
  return listConsentsLocal(getStoreId(), limit);
}

export async function getLocalUsage() {
  return localUsage(getStoreId());
}

// 保存済みの 1 件を、あとからアルバムへ入れ直す（保存に失敗していた分の救済）
export async function resaveToAlbum(meta) {
  const documentImage = await getConsentImage(meta.id);
  if (!documentImage) return { ok: false, reason: 'NO_DATA' };
  const r = await saveToAlbum(documentImage, albumFileName(new Date(meta.signedAt), meta.customerName));
  if (r.ok) {
    meta.albumSaved = true;
    delete meta.albumError;
    await saveConsentLocal(meta);
  }
  return r;
}

// 端末内に保存した書類をアプリ内のビューアで開く。
// 別タブ（window.open）だとアプリ版で前の画面に戻れなくなるため、必ずこのモーダルで見せる。
export async function openConsentImage(id) {
  const dataUrl = await getConsentImage(id);
  if (!dataUrl) return false;

  const overlay = document.createElement('div');
  overlay.className = 'consent-viewer';
  overlay.innerHTML = `
    <div class="cv-bar">
      <button class="cv-close" id="cv-close" type="button">✕ 閉じる</button>
      <button class="cv-zoom" id="cv-zoom" type="button">拡大</button>
    </div>
    <div class="cv-body" id="cv-body">
      <img class="cv-img" id="cv-img" alt="同意書" />
    </div>`;
  document.body.appendChild(overlay);

  const img = overlay.querySelector('#cv-img');
  img.src = dataUrl;

  const body = overlay.querySelector('#cv-body');
  const zoomBtn = overlay.querySelector('#cv-zoom');
  let zoomed = false;                       // 既定は全体表示（拡大しない）
  zoomBtn.addEventListener('click', () => {
    zoomed = !zoomed;
    body.classList.toggle('zoomed', zoomed);
    zoomBtn.textContent = zoomed ? '全体表示' : '拡大';
    if (!zoomed) { body.scrollTop = 0; body.scrollLeft = 0; }
  });

  const close = () => {
    window.removeEventListener('popstate', onPop);
    overlay.remove();
  };
  // アプリの戻る操作でもビューアだけ閉じる（メニューまで戻ってしまわないように）
  const onPop = (e) => { e.stopImmediatePropagation?.(); close(); };
  window.addEventListener('popstate', onPop);

  overlay.querySelector('#cv-close').addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  return true;
}

// クラウド側に保存された画像の URL（クラウド保存を使う場合のみ意味を持つ）
export function consentImageUrl(path) {
  if (!path) return '';
  const { data } = supabase.storage.from(CONSENT_BUCKET).getPublicUrl(path);
  return data?.publicUrl || '';
}

// === 署名モーダル ===
// 完了したら保存済みの行を、キャンセルなら null を返す
export function openConsentDialog({ isTest = true } = {}) {
  return new Promise((resolve) => {
    // 伝票名の入力欄は設定でオンにした時だけ出す（既定は非表示）
    const showNameField = isNameFieldEnabled();
    const overlay = document.createElement('div');
    overlay.className = 'consent-overlay';
    overlay.innerHTML = `
      <div class="consent-sheet" role="dialog" aria-modal="true">
        ${isTest ? '<div class="consent-testbadge">テストモード（本番の運用データではありません）</div>' : ''}
        <div class="consent-doc">
          <h2 class="consent-title">${DOC.title}</h2>

          <!-- 左: 読ませる内容 / 右: 記入する内容。横長画面では 2 カラムに並ぶ -->
          <div class="consent-col consent-col-read">
            <p class="consent-lead">${DOC.lead.join('<br>')}</p>

            <h3 class="consent-h">${DOC.routeHeading}</h3>
            <p class="consent-note">${DOC.routeNote}</p>
            <div class="consent-routes">
              ${DOC.routes.map((r, i) => `
                <label class="consent-route">
                  <input type="radio" name="consent-route" value="${i + 1}" />
                  <span>${r}</span>
                </label>`).join('')}
            </div>

            <h3 class="consent-h">${DOC.noticeHeading}</h3>
            <p class="consent-notice">${DOC.notice.join('<br>')}</p>
          </div>

          <div class="consent-col consent-col-write">
            <h3 class="consent-h">${DOC.signHeading}</h3>
            <p class="consent-note">${DOC.signLead}</p>

            ${showNameField ? `
            <div class="consent-field">
              <label class="consent-label">伝票名（ひらがな）</label>
              <input type="text" class="consent-input" id="consent-name" lang="ja"
                     placeholder="下のお名前・ニックネーム" />
            </div>` : ''}

            <div class="consent-field">
              <label class="consent-label">ご署名（枠内に指またはペンで）</label>
              <div class="consent-padwrap">
                <canvas class="consent-pad" id="consent-pad"></canvas>
              </div>
              <div class="consent-padactions">
                <button class="btn btn-secondary" id="consent-undo">一画取り消し</button>
                <button class="btn btn-secondary" id="consent-clear">全部消す</button>
              </div>
            </div>

            <div class="consent-field consent-idcheck">
              <span class="consent-label">身分証確認（スタッフ）</span>
              <label class="consent-route"><input type="radio" name="consent-idck" value="1" checked /><span>済</span></label>
              <label class="consent-route"><input type="radio" name="consent-idck" value="0" /><span>未</span></label>
            </div>

            <p class="consent-when">来店日時：<span id="consent-when"></span>（自動記録）</p>
          </div>
        </div>

        <div class="consent-actions">
          <button class="btn btn-secondary" id="consent-cancel">キャンセル</button>
          <button class="btn btn-primary" id="consent-submit">同意して署名を保存</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    const canvas = overlay.querySelector('#consent-pad');
    const pad = createSignaturePad(canvas);
    requestAnimationFrame(() => pad.fit());
    const onResize = () => pad.fit();
    window.addEventListener('resize', onResize);

    const whenEl = overlay.querySelector('#consent-when');
    const tick = () => { whenEl.textContent = fmtDate(new Date()); };
    tick();
    const timer = setInterval(tick, 30000);

    // 署名欄が無くなったあと（完了画面）は時計もリサイズ追従も要らないので止める
    let live = true;
    const stopLive = () => {
      if (!live) return;
      live = false;
      clearInterval(timer);
      window.removeEventListener('resize', onResize);
    };

    const close = (result) => {
      stopLive();
      overlay.remove();
      resolve(result);
    };

    // 保存が終わったら、お客様に見せる完了画面へ差し替える。
    // ここでタブレットを運営スタッフに渡してもらう想定なので、閉じるまで自動では消さない。
    const showDone = (row) => {
      stopLive();
      overlay.innerHTML = `
        <div class="consent-sheet consent-done" role="dialog" aria-modal="true">
          ${isTest ? '<div class="consent-testbadge">テストモード（本番の運用データではありません）</div>' : ''}
          <div class="consent-done-body">
            <div class="consent-done-mark">✓</div>
            <h2 class="consent-done-title">ご記入ありがとうございました</h2>
            <p class="consent-done-lead">この画面を<br>運営スタッフにお渡しください</p>
            <p class="consent-done-note">閉じるには${hasLockPattern() ? 'パターン入力' : '店舗パスワード'}が必要です</p>
          </div>
          <div class="consent-actions">
            <button class="btn btn-secondary" id="consent-done-preview">プレビュー</button>
            <button class="btn btn-primary" id="consent-done-close">閉じる</button>
          </div>
        </div>`;

      const previewBtn = overlay.querySelector('#consent-done-preview');
      previewBtn.addEventListener('click', async () => {
        previewBtn.disabled = true;
        try {
          const ok = await openConsentImage(row.id);
          if (!ok) dlg.toast('書類の画像が見つかりませんでした', { type: 'error' });
        } finally {
          previewBtn.disabled = false;
        }
      });
      // 閉じるは解錠を要求する（お客様が勝手に閉じて次の画面へ進めないように）
      // テンキー、パターンを登録している端末ではパターン入力になる
      overlay.querySelector('#consent-done-close').addEventListener('click', async () => {
        const ok = await requireUnlock({ title: 'スタッフ確認' });
        if (ok) close(row);                      // キャンセル・誤りは完了画面のまま
      });
    };

    overlay.querySelector('#consent-undo').addEventListener('click', () => pad.undo());
    overlay.querySelector('#consent-clear').addEventListener('click', () => pad.clear());
    overlay.querySelector('#consent-cancel').addEventListener('click', async () => {
      if (!pad.isEmpty()) {
        const ok = await dlg.confirm('署名を破棄して閉じますか？', { title: '確認', okLabel: '破棄', danger: true });
        if (!ok) return;
      }
      close(null);
    });

    const submitBtn = overlay.querySelector('#consent-submit');
    submitBtn.addEventListener('click', async () => {
      const routeEl = overlay.querySelector('input[name="consent-route"]:checked');
      if (!routeEl) { dlg.toast('来店経路を選んでください', { type: 'error' }); return; }
      if (pad.isEmpty()) { dlg.toast('ご署名を記入してください', { type: 'error' }); return; }

      submitBtn.disabled = true;
      submitBtn.textContent = '保存中…';
      try {
        const row = await saveConsent({
          route: Number(routeEl.value),
          idChecked: overlay.querySelector('input[name="consent-idck"]:checked')?.value === '1',
          customerName: overlay.querySelector('#consent-name')?.value.trim() || '',
          pad,
          isTest,
        });
        showDone(row);
      } catch (err) {
        console.error(err);
        submitBtn.disabled = false;
        submitBtn.textContent = '同意して署名を保存';
        dlg.alert(`保存に失敗しました。\n${err?.message || err}`, { title: 'エラー' });
      }
    });
  });
}
