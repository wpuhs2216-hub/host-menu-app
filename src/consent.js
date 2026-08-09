// デジタル署名（ご新規様同意書）— テストモード用
// - 書類は HTML で表示し、署名は canvas に手書きする
// - 保存時に「署名だけの透過PNG」と「書類全体を焼いた画像」を storage に上げ、
//   consents テーブルへ 1 行 insert する（追記専用。DB 側で UPDATE/DELETE は拒否）
// - 「何に同意したか」を後から再現できるよう、表示した本文をそのまま doc_text に残す

import { supabase } from './supabaseClient.js';
import { getStoreId, getStoreName } from './storeContext.js';
import { getDeviceName, getSelfDeviceId } from './sync.js';
import * as dlg from './dialog.js';
import './consent.css';

export const CONSENT_BUCKET = 'consent-images';

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

function fmtDate(d) {
  const w = ['日', '月', '火', '水', '木', '金', '土'][d.getDay()];
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日(${w}) `
    + `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
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
      if (customerName) left(`お名前(読み) :　${customerName}`, labelX, yy, '24px sans-serif');

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

// === 保存 ===
export async function saveConsent({ route, idChecked, customerName, pad, isTest = true }) {
  const id = genId();
  const signedAt = new Date();
  const docText = buildDocText();

  const signaturePng = pad.toTrimmedPng();
  const documentJpg = await renderDocumentImage({
    route, idChecked, customerName, signaturePng, signedAt,
  });

  const signaturePath = `${id}__sig.png`;
  const documentPath = `${id}.jpg`;
  await uploadPng(signaturePath, signaturePng);
  await uploadPng(documentPath, documentJpg);

  const hash = await sha256Hex([
    DOC_VERSION, docText, route, idChecked ? '1' : '0',
    customerName || '', signedAt.toISOString(), signaturePng.slice(0, 4096),
  ].join('|'));

  const row = {
    id,
    store_id: getStoreId(),
    route,
    id_checked: !!idChecked,
    customer_name: customerName || '',
    signature_path: signaturePath,
    document_path: documentPath,
    doc_version: DOC_VERSION,
    doc_text: docText,
    device_name: getDeviceName(),
    device_id: getSelfDeviceId(),
    hash,
    is_test: !!isTest,
    signed_at: signedAt.toISOString(),
  };
  const { error } = await supabase.from('consents').insert(row);
  if (error) throw error;
  return row;
}

// === 一覧取得 ===
export async function listConsents(limit = 20) {
  const { data, error } = await supabase
    .from('consents')
    .select('id,route,id_checked,customer_name,document_path,signed_at,device_name,is_test,doc_version')
    .eq('store_id', getStoreId())
    .order('signed_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data || [];
}

export function consentImageUrl(path) {
  if (!path) return '';
  const { data } = supabase.storage.from(CONSENT_BUCKET).getPublicUrl(path);
  return data?.publicUrl || '';
}

// === 署名モーダル ===
// 完了したら保存済みの行を、キャンセルなら null を返す
export function openConsentDialog({ isTest = true } = {}) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'consent-overlay';
    overlay.innerHTML = `
      <div class="consent-sheet" role="dialog" aria-modal="true">
        ${isTest ? '<div class="consent-testbadge">テストモード（本番の運用データではありません）</div>' : ''}
        <div class="consent-doc">
          <h2 class="consent-title">${DOC.title}</h2>
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

          <h3 class="consent-h">${DOC.signHeading}</h3>
          <p class="consent-note">${DOC.signLead}</p>

          <div class="consent-field">
            <label class="consent-label">お名前（読み・任意）</label>
            <input type="text" class="consent-input" id="consent-name" placeholder="例: 山田 太郎" />
          </div>

          <div class="consent-field">
            <label class="consent-label">ご署名（枠内に指またはペンで）</label>
            <div class="consent-padwrap">
              <canvas class="consent-pad" id="consent-pad"></canvas>
              <div class="consent-padline"></div>
            </div>
            <div class="consent-padactions">
              <button class="btn btn-secondary" id="consent-undo">一画取り消し</button>
              <button class="btn btn-secondary" id="consent-clear">全部消す</button>
            </div>
          </div>

          <div class="consent-field consent-idcheck">
            <span class="consent-label">身分証確認（スタッフ）</span>
            <label class="consent-route"><input type="radio" name="consent-idck" value="1" /><span>済</span></label>
            <label class="consent-route"><input type="radio" name="consent-idck" value="0" checked /><span>未</span></label>
          </div>

          <p class="consent-when">来店日時：<span id="consent-when"></span>（自動記録）</p>
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

    const close = (result) => {
      clearInterval(timer);
      window.removeEventListener('resize', onResize);
      overlay.remove();
      resolve(result);
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
          customerName: overlay.querySelector('#consent-name').value.trim(),
          pad,
          isTest,
        });
        dlg.toast('同意書を保存しました', { type: 'success' });
        close(row);
      } catch (err) {
        console.error(err);
        submitBtn.disabled = false;
        submitBtn.textContent = '同意して署名を保存';
        dlg.alert(`保存に失敗しました。\n${err?.message || err}`, { title: 'エラー' });
      }
    });
  });
}
