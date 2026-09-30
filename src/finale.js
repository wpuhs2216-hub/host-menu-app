// ファイナルカレンダー（2026-10-01・まず GENTLY DIVA だけ）
// - 営業終わりに「その日のファイナルの人」を 1 人選ぶと、DAY1 から順に枠へ写真が入る
// - 上の大枠には、前月いちばんファイナルが多かった人が 1 か月乗る（自動。手で選び直すこともできる）
// - 背景は店ごとの 1 枚絵。灰色の枠の位置に写真を重ねる（位置は元絵 1240×1754 の画素で測った値）
// - 記録は Supabase の表ではなく、写真置き場（panel-images バケット）に月ごとの JSON で置く

import { supabase, PANEL_BUCKET, publicImageUrl } from './supabaseClient.js';
import { getStoreId } from './storeContext.js';
import { ensureStoreFixed } from './storeLogin.js';
import * as dlg from './dialog.js';

// 使える店と背景の絵。ここに無い店では画面を出さない
const CALENDARS = {
  'gently-diva': { bg: 'finale/diva-bg.jpg' },
  'test-store': { bg: 'finale/diva-bg.jpg' }, // 動作確認用
};

// 元絵の大きさと、灰色の枠・大枠の位置（画素）
const ART_W = 1240;
const ART_H = 1754;
const SLOT_XS = [58, 223, 388, 554, 719, 884, 1049];
const SLOT_YS = [926, 1135, 1343];
const SLOT_W = 134;
const SLOT_H = 128;
const MAX_DAYS = 20;
const HERO = { x: 248, y: 184, w: 744, h: 666 };

// 営業終わりは日付をまたぐので、朝 6 時までは前の日（前の月）として扱う
const DAY_CUTOFF_HOURS = 6;

const slotRect = (i) => ({ x: SLOT_XS[i % 7], y: SLOT_YS[Math.floor(i / 7)], w: SLOT_W, h: SLOT_H });

// @ハジメル ファイナル台帳: 月ごとの「その日のファイナルの人」の並びと、上の大枠の人・透過写真（倉庫の finale/<店>/<年-月>.json） #一覧
const ledgerPath = (store, ym) => `finale/${store}/${ym}.json`;
const heroImagePath = (store, ym) => `finale/${store}/hero-${ym}-${Date.now()}.webp`;
// @ハジメル 枠の顔の位置: キャストごとの「四角い枠で写真のどこを映すか」（中心と拡大率。倉庫の finale/<店>/faces.json） #設定
const facesPath = (store) => `finale/${store}/faces.json`;

let storeId = '';
let calendar = null;
let casts = [];          // この店のキャスト（名前があって表示中のものだけ。写真が無い人は名前だけ出す）
let ym = '';             // 表示中の月 'YYYY-MM'
let ledger = emptyLedger();
let prevLedger = emptyLedger();
let faces = {};          // { panelId: { x, y, z, v, auto } }（x・y は写真の中の中心の位置 0〜1、z は拡大率）

function emptyLedger() {
  return { version: 1, days: [], hero: null };
}

function businessYm(d = new Date()) {
  const t = new Date(d.getTime() - DAY_CUTOFF_HOURS * 3600 * 1000);
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}`;
}

function shiftYm(value, step) {
  const [y, m] = value.split('-').map(Number);
  const d = new Date(y, m - 1 + step, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function ymLabel(value) {
  const [y, m] = value.split('-').map(Number);
  return `${y}年${m}月`;
}

// ===== 台帳の読み書き =====
async function loadLedger(month) {
  // 公開 URL に毎回違う印を付けて、古い控えを返されないようにする
  const res = await fetch(`${publicImageUrl(ledgerPath(storeId, month))}?t=${Date.now()}`, { cache: 'no-store' });
  if (!res.ok) return emptyLedger(); // まだ無い月は空
  try {
    const json = await res.json();
    return { ...emptyLedger(), ...json, days: Array.isArray(json.days) ? json.days : [] };
  } catch {
    return emptyLedger();
  }
}

async function saveLedger() {
  ledger.updatedAt = new Date().toISOString();
  const blob = new Blob([JSON.stringify(ledger)], { type: 'application/json' });
  const { error } = await supabase.storage.from(PANEL_BUCKET).upload(ledgerPath(storeId, ym), blob, {
    contentType: 'application/json',
    upsert: true,
    cacheControl: '0',
  });
  if (error) throw error;
}

async function loadCasts() {
  const { data, error } = await supabase
    .from('panels')
    .select('id, name, image_path, image_version, img_x, img_y, visible, has_image, "order"')
    .eq('store_id', storeId)
    .order('order');
  if (error) throw error;
  casts = (data || []).filter((p) => p.visible && (p.name || '').trim());
}

function castById(id) {
  return casts.find((c) => c.id === id) || null;
}

function castPhoto(c) {
  return c && c.has_image && c.image_path ? `${publicImageUrl(c.image_path)}?v=${c.image_version || 0}` : '';
}

// ===== 枠の顔の位置 =====
// メニューの写真の位置（img_x / img_y）とは別に持つ。メニューの見た目には効かない。
// 写真を差し替えた人（image_version が違う人）の位置は使わず、真ん中寄りに戻す。
const DEFAULT_CROP = { x: 0.5, y: 0.3, z: 1 };

async function loadFaces() {
  const res = await fetch(`${publicImageUrl(facesPath(storeId))}?t=${Date.now()}`, { cache: 'no-store' });
  if (!res.ok) return {};
  try { return (await res.json()) || {}; } catch { return {}; }
}

// 1 人分だけ書き換える（書く直前に読み直して、ほかの人の分を消さない）
async function saveFace(panelId, value) {
  const latest = await loadFaces();
  if (value) latest[panelId] = value; else delete latest[panelId];
  const blob = new Blob([JSON.stringify(latest)], { type: 'application/json' });
  const { error } = await supabase.storage.from(PANEL_BUCKET).upload(facesPath(storeId), blob, {
    contentType: 'application/json',
    upsert: true,
    cacheControl: '0',
  });
  if (error) throw error;
  faces = latest;
}

function cropOf(c) {
  const f = c && faces[c.id];
  if (!f || (f.v ?? 0) !== (c.image_version || 0)) return { ...DEFAULT_CROP };
  return { x: f.x, y: f.y, z: f.z || 1 };
}

// 写真のどこを切り出すか（元の写真の画素）。枠の縦横比は bw:bh
function srcRect(nw, nh, crop, bw = SLOT_W, bh = SLOT_H) {
  const s = Math.max(bw / nw, bh / nh) * Math.max(1, crop.z || 1);
  const sw = bw / s;
  const sh = bh / s;
  const sx = Math.min(Math.max(crop.x * nw - sw / 2, 0), nw - sw);
  const sy = Math.min(Math.max(crop.y * nh - sh / 2, 0), nh - sh);
  return { sx, sy, sw, sh };
}

// 画面の <img> を切り出し位置に合わせて置く（枠の中で % 指定）
function applyCrop(img, crop, bw = SLOT_W, bh = SLOT_H) {
  const place = () => {
    if (!img.naturalWidth) return;
    const r = srcRect(img.naturalWidth, img.naturalHeight, crop, bw, bh);
    img.style.width = `${(img.naturalWidth / r.sw) * 100}%`;
    img.style.height = `${(img.naturalHeight / r.sh) * 100}%`;
    img.style.left = `${(-r.sx / r.sw) * 100}%`;
    img.style.top = `${(-r.sy / r.sh) * 100}%`;
  };
  if (img.complete) place();
  img.addEventListener('load', place);
}

function drawCrop(ctx, img, r, crop) {
  const q = srcRect(img.naturalWidth, img.naturalHeight, crop, r.w, r.h);
  ctx.drawImage(img, q.sx, q.sy, q.sw, q.sh, r.x, r.y, r.w, r.h);
}

// ===== 上の大枠の人を決める =====
// 手で選んだ人がいればその人。いなければ前月の回数がいちばん多い人（同じ回数なら先にその回数へ届いた人）
function resolveHero() {
  const h = ledger.hero || {};
  if (h.panelId) return { panelId: h.panelId, name: h.name, image: h.image || '', how: 'manual' };
  const counts = new Map();
  let best = null;
  for (const d of prevLedger.days) {
    if (!d || !d.panelId) continue;
    const n = (counts.get(d.panelId) || 0) + 1;
    counts.set(d.panelId, n);
    if (!best || n > best.count) best = { panelId: d.panelId, name: d.name, count: n };
  }
  if (!best) return { panelId: '', name: '', image: h.image || '', how: 'none' };
  const tie = [...counts.values()].filter((n) => n === best.count).length > 1;
  return { ...best, image: h.image || '', how: 'auto', tie };
}

// ===== 描く =====
const pct = (v, total) => `${(v / total) * 100}%`;

function placeBox(el, r) {
  el.style.left = pct(r.x, ART_W);
  el.style.top = pct(r.y, ART_H);
  el.style.width = pct(r.w, ART_W);
  el.style.height = pct(r.h, ART_H);
}

function render() {
  document.getElementById('fc-month-label').textContent = ymLabel(ym);

  // 日の枠
  const wrap = document.getElementById('fc-slots');
  wrap.innerHTML = '';
  const next = ledger.days.length;
  for (let i = 0; i < MAX_DAYS; i++) {
    const d = ledger.days[i];
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'fc-slot';
    placeBox(el, slotRect(i));
    if (d) {
      const c = castById(d.panelId);
      if (castPhoto(c)) {
        const img = document.createElement('img');
        img.crossOrigin = 'anonymous';
        img.alt = d.name || '';
        img.src = castPhoto(c);
        img.className = 'fc-crop';
        applyCrop(img, cropOf(c));
        el.appendChild(img);
      }
      const name = document.createElement('span');
      name.className = 'fc-slot-name';
      name.textContent = d.name || '';
      el.appendChild(name);
      el.addEventListener('click', () => onFilledSlot(i));
    } else if (i === next) {
      el.classList.add('fc-slot-next');
      el.innerHTML = '<span class="fc-plus">＋</span>';
      el.addEventListener('click', () => onNextSlot());
    } else {
      el.classList.add('fc-slot-empty');
      el.addEventListener('click', () => dlg.toast(`DAY は順番に入ります。次は DAY${next + 1} です`));
    }
    wrap.appendChild(el);
  }

  // 上の大枠
  const hero = resolveHero();
  const box = document.getElementById('fc-hero');
  placeBox(box, HERO);
  box.innerHTML = '';
  box.classList.toggle('fc-hero-soft', !hero.image);
  const src = hero.image ? publicImageUrl(hero.image) : castPhoto(castById(hero.panelId));
  if (src) {
    const img = document.createElement('img');
    img.crossOrigin = 'anonymous';
    img.alt = hero.name || '';
    img.src = src;
    box.appendChild(img);
  }

  const desc = document.getElementById('fc-hero-desc');
  if (hero.how === 'manual') desc.textContent = `いまは「${hero.name}」さんを手で選んでいます。`;
  else if (hero.how === 'auto') desc.textContent = `前月（${ymLabel(shiftYm(ym, -1))}）いちばん多かった「${hero.name}」さん（${hero.count} 回）を自動で出しています。${hero.tie ? '同じ回数の人がいます。先にその回数に届いた人を出しています。変えたい時は手で選んでください。' : ''}`;
  else desc.textContent = `前月（${ymLabel(shiftYm(ym, -1))}）の記録がありません。「人を手で選ぶ」で決めてください。`;
  desc.textContent += hero.image ? ' 写真は背景を消した物を使っています。' : ' 写真はメニューの写真をふちをぼかして使っています。背景を消した写真を載せるときれいになります。';

  const last = ledger.days[ledger.days.length - 1];
  document.getElementById('fc-note').textContent = next >= MAX_DAYS
    ? `今月の 20 枠はすべて埋まりました。`
    : `枠の「＋」を押して、今日のファイナルの人を選んでください（次は DAY${next + 1}）。${last ? `最後に入れたのは DAY${next}「${last.name}」さんです。` : ''}`;
}

// ===== 人を選ぶ小窓 =====
function pickCast(title, { allowRemove = false } = {}) {
  return new Promise((resolve) => {
    const host = document.createElement('div');
    host.className = 'app-dialog-backdrop fc-picker-backdrop';
    host.innerHTML = `
      <div class="app-dialog-box fc-picker">
        <div class="fc-picker-title"></div>
        <div class="fc-picker-grid"></div>
        <div class="fc-picker-actions">
          ${allowRemove ? '<button type="button" class="fc-remove">この日を外す</button>' : ''}
          <button type="button" class="fc-cancel">やめる</button>
        </div>
      </div>`;
    host.querySelector('.fc-picker-title').textContent = title;
    const grid = host.querySelector('.fc-picker-grid');
    for (const c of casts) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'fc-pick';
      const img = document.createElement(castPhoto(c) ? 'img' : 'div');
      img.className = 'fc-pick-photo';
      if (castPhoto(c)) {
        img.src = castPhoto(c);
        img.alt = '';
        img.style.objectPosition = `${c.img_x ?? 50}% ${c.img_y ?? 30}%`;
      }
      const name = document.createElement('span');
      name.textContent = c.name;
      b.append(img, name);
      b.addEventListener('click', () => done(c));
      grid.appendChild(b);
    }
    const done = (v) => { host.remove(); resolve(v); };
    host.querySelector('.fc-cancel').addEventListener('click', () => done(null));
    host.querySelector('.fc-remove')?.addEventListener('click', () => done('remove'));
    host.addEventListener('click', (e) => { if (e.target === host) done(null); });
    document.body.appendChild(host);
  });
}

async function persist(message) {
  try {
    await saveLedger();
    render();
    if (message) dlg.toast(message);
  } catch (e) {
    await dlg.alert(`保存できませんでした。通信を確かめてもう一度お試しください。\n${e.message || e}`);
    ledger = await loadLedger(ym);
    render();
  }
}

async function onNextSlot() {
  if (ledger.days.length >= MAX_DAYS) return;
  // 同じ営業日を 2 回入れてしまうのを防ぐ（最後の記録から 12 時間以内なら聞く）
  const last = ledger.days[ledger.days.length - 1];
  if (last && Date.now() - new Date(last.at).getTime() < 12 * 3600 * 1000) {
    const ok = await dlg.confirm(`さっき DAY${ledger.days.length} に「${last.name}」さんを入れたばかりです。\n別の営業日の分として DAY${ledger.days.length + 1} を入れますか？`, { okLabel: '入れる' });
    if (!ok) return;
  }
  const n = ledger.days.length + 1;
  const c = await pickCast(`DAY${n} のファイナル`);
  if (!c || c === 'remove') return;
  ledger = await loadLedger(ym); // 他の端末が先に入れていないか読み直す
  ledger.days.push({ panelId: c.id, name: c.name, at: new Date().toISOString() });
  await persist(`DAY${ledger.days.length} に「${c.name}」さんを入れました`);
}

async function onFilledSlot(i) {
  const isLast = i === ledger.days.length - 1;
  const c = await pickCast(`DAY${i + 1}（いまは「${ledger.days[i].name}」さん）を変える`, { allowRemove: isLast });
  if (!c) return;
  ledger = await loadLedger(ym);
  if (!ledger.days[i]) { render(); return; }
  if (c === 'remove') {
    ledger.days.splice(i, 1);
    await persist(`DAY${i + 1} を外しました`);
  } else {
    ledger.days[i] = { ...ledger.days[i], panelId: c.id, name: c.name };
    await persist(`DAY${i + 1} を「${c.name}」さんに変えました`);
  }
}

// ===== 上の大枠の操作 =====
async function onHeroPick() {
  const c = await pickCast('上の大枠に出す人');
  if (!c || c === 'remove') return;
  ledger = await loadLedger(ym);
  const keepImage = ledger.hero?.panelId === c.id ? ledger.hero.image : '';
  ledger.hero = { panelId: c.id, name: c.name, image: keepImage || '' };
  await persist(`上の大枠を「${c.name}」さんにしました`);
}

async function onHeroAuto() {
  ledger = await loadLedger(ym);
  ledger.hero = null;
  await persist('上の大枠を自動に戻しました');
}

async function onHeroFile(e) {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (!file) return;
  const hero = resolveHero();
  if (!hero.panelId) { await dlg.alert('先に「人を手で選ぶ」で、大枠に出す人を決めてください。'); return; }
  try {
    const path = heroImagePath(storeId, ym);
    const { error } = await supabase.storage.from(PANEL_BUCKET).upload(path, file, {
      contentType: file.type || 'image/png',
      upsert: false,
      cacheControl: '3600',
    });
    if (error) throw error;
    ledger = await loadLedger(ym);
    ledger.hero = { panelId: hero.panelId, name: hero.name, image: path };
    await persist('大枠の写真を載せました');
  } catch (err) {
    await dlg.alert(`写真を載せられませんでした。\n${err.message || err}`);
  }
}

async function onHeroFileClear() {
  ledger = await loadLedger(ym);
  if (!ledger.hero?.image) { dlg.toast('載せた写真はありません'); return; }
  ledger.hero = { ...ledger.hero, image: '' };
  await persist('載せた写真を外しました');
}

// ===== 枠の顔の位置を直す =====
function toggleFaceList() {
  const list = document.getElementById('fc-face-list');
  const open = list.hidden;
  list.hidden = !open;
  if (open) renderFaceList();
}

function renderFaceList() {
  const list = document.getElementById('fc-face-list');
  list.innerHTML = '';
  for (const c of casts) {
    if (!castPhoto(c)) continue;
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'fc-face-item';
    const box = document.createElement('div');
    box.className = 'fc-face-thumb';
    const img = document.createElement('img');
    img.className = 'fc-crop';
    img.crossOrigin = 'anonymous';
    img.alt = '';
    img.src = castPhoto(c);
    applyCrop(img, cropOf(c));
    box.appendChild(img);
    const name = document.createElement('span');
    name.textContent = c.name;
    b.append(box, name);
    b.addEventListener('click', () => editFace(c));
    list.appendChild(b);
  }
}

// 1 人分の位置を直す小窓。指でずらす・つまみで大きさを変える
function editFace(c) {
  const saved = faces[c.id];
  const fresh = saved && (saved.v ?? 0) === (c.image_version || 0);
  const auto = fresh && saved.auto ? saved.auto : null; // 顔を見つけて決めた最初の位置
  let crop = cropOf(c);

  const host = document.createElement('div');
  host.className = 'app-dialog-backdrop fc-picker-backdrop';
  host.innerHTML = `
    <div class="app-dialog-box fc-picker fc-face-editor">
      <div class="fc-picker-title"></div>
      <p class="fc-desc">写真を指でずらして、枠に映す所を決めてください。下のつまみで大きさを変えられます。</p>
      <div class="fc-face-stage"><img class="fc-crop" alt="" /></div>
      <label class="fc-zoom">大きさ <input type="range" min="1" max="4" step="0.01" /></label>
      <div class="fc-picker-actions">
        <button type="button" class="fc-reset"></button>
        <button type="button" class="fc-cancel">やめる</button>
        <button type="button" class="fc-ok">保存</button>
      </div>
    </div>`;
  host.querySelector('.fc-picker-title').textContent = `${c.name} さんの枠の位置`;
  const stage = host.querySelector('.fc-face-stage');
  const img = stage.querySelector('img');
  const zoom = host.querySelector('input[type=range]');
  const reset = host.querySelector('.fc-reset');
  reset.textContent = auto ? '顔に合わせた位置に戻す' : '真ん中に戻す';
  img.src = castPhoto(c);
  zoom.value = String(crop.z);

  const draw = () => applyCrop(img, crop);
  // 動かした後、写真の外へはみ出さないよう中心を収める
  const clamp = () => {
    if (!img.naturalWidth) return;
    const r = srcRect(img.naturalWidth, img.naturalHeight, crop);
    crop.x = (r.sx + r.sw / 2) / img.naturalWidth;
    crop.y = (r.sy + r.sh / 2) / img.naturalHeight;
  };
  draw();

  let drag = null;
  stage.addEventListener('pointerdown', (e) => {
    if (!img.naturalWidth) return;
    stage.setPointerCapture(e.pointerId);
    drag = { x: e.clientX, y: e.clientY, crop: { ...crop } };
  });
  stage.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const r = srcRect(img.naturalWidth, img.naturalHeight, drag.crop);
    const k = r.sw / stage.clientWidth; // 画面の 1px が写真の何画素か
    crop = {
      ...drag.crop,
      x: drag.crop.x - ((e.clientX - drag.x) * k) / img.naturalWidth,
      y: drag.crop.y - ((e.clientY - drag.y) * k) / img.naturalHeight,
    };
    clamp();
    draw();
  });
  const endDrag = () => { drag = null; };
  stage.addEventListener('pointerup', endDrag);
  stage.addEventListener('pointercancel', endDrag);
  zoom.addEventListener('input', () => { crop = { ...crop, z: Number(zoom.value) }; clamp(); draw(); });
  reset.addEventListener('click', () => {
    crop = auto ? { ...auto } : { ...DEFAULT_CROP };
    zoom.value = String(crop.z);
    draw();
  });

  const close = () => host.remove();
  host.querySelector('.fc-cancel').addEventListener('click', close);
  host.querySelector('.fc-ok').addEventListener('click', async () => {
    try {
      const round = (v) => Math.round(v * 10000) / 10000;
      await saveFace(c.id, {
        x: round(crop.x), y: round(crop.y), z: round(crop.z),
        v: c.image_version || 0,
        ...(auto ? { auto } : {}),
      });
      close();
      render();
      renderFaceList();
      dlg.toast(`${c.name} さんの位置を保存しました`);
    } catch (err) {
      await dlg.alert(`保存できませんでした。\n${err.message || err}`);
    }
  });
  document.body.appendChild(host);
}

// ===== 画像で保存 =====
function loadImg(src) {
  return new Promise((resolve) => {
    if (!src) { resolve(null); return; }
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

// object-fit: cover と同じ切り取り方で描く
function drawCover(ctx, img, r, posX = 50, posY = 30) {
  const s = Math.max(r.w / img.naturalWidth, r.h / img.naturalHeight);
  const sw = r.w / s;
  const sh = r.h / s;
  const sx = (img.naturalWidth - sw) * (posX / 100);
  const sy = (img.naturalHeight - sh) * (posY / 100);
  ctx.drawImage(img, sx, sy, sw, sh, r.x, r.y, r.w, r.h);
}

async function onSave() {
  const btn = document.getElementById('fc-save');
  btn.disabled = true;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = ART_W;
    canvas.height = ART_H;
    const ctx = canvas.getContext('2d');
    const bg = await loadImg(document.getElementById('fc-bg').src);
    if (bg) ctx.drawImage(bg, 0, 0, ART_W, ART_H);

    // 上の大枠
    const hero = resolveHero();
    if (hero.image) {
      const img = await loadImg(publicImageUrl(hero.image));
      if (img) {
        const s = Math.min(HERO.w / img.naturalWidth, HERO.h / img.naturalHeight);
        const w = img.naturalWidth * s;
        const h = img.naturalHeight * s;
        ctx.drawImage(img, HERO.x + (HERO.w - w) / 2, HERO.y + HERO.h - h, w, h);
      }
    } else if (hero.panelId) {
      const c = castById(hero.panelId);
      const img = await loadImg(castPhoto(c));
      if (img) {
        // ふちをぼかして丸く溶かす
        const off = document.createElement('canvas');
        off.width = HERO.w;
        off.height = HERO.h;
        const o = off.getContext('2d');
        drawCover(o, img, { x: 0, y: 0, w: HERO.w, h: HERO.h }, 50, 30); // 画面（.fc-hero-soft）と同じ切り取り位置
        const g = o.createRadialGradient(HERO.w / 2, HERO.h * 0.45, HERO.h * 0.25, HERO.w / 2, HERO.h * 0.45, HERO.h * 0.52);
        g.addColorStop(0, 'rgba(0,0,0,1)');
        g.addColorStop(1, 'rgba(0,0,0,0)');
        o.globalCompositeOperation = 'destination-in';
        o.fillStyle = g;
        o.fillRect(0, 0, HERO.w, HERO.h);
        ctx.drawImage(off, HERO.x, HERO.y);
      }
    }

    // 日の枠
    for (let i = 0; i < ledger.days.length && i < MAX_DAYS; i++) {
      const d = ledger.days[i];
      const c = castById(d.panelId);
      const r = slotRect(i);
      const img = await loadImg(castPhoto(c));
      if (img) drawCrop(ctx, img, r, cropOf(c));
      // 名前（下に薄い帯）
      const g = ctx.createLinearGradient(0, r.y + r.h - 34, 0, r.y + r.h);
      g.addColorStop(0, 'rgba(0,0,0,0)');
      g.addColorStop(1, 'rgba(0,0,0,0.75)');
      ctx.fillStyle = g;
      ctx.fillRect(r.x, r.y + r.h - 34, r.w, 34);
      ctx.fillStyle = '#fff';
      ctx.font = "700 17px 'Noto Sans JP', sans-serif";
      ctx.textAlign = 'center';
      ctx.textBaseline = 'alphabetic';
      ctx.fillText(d.name || '', r.x + r.w / 2, r.y + r.h - 8, r.w - 8);
    }

    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('画像を作れませんでした');
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `finale-calendar-${ym}.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  } catch (e) {
    await dlg.alert(`画像を保存できませんでした。\n${e.message || e}`);
  } finally {
    btn.disabled = false;
  }
}

// ===== 月の切り替え =====
async function openMonth(month) {
  ym = month;
  [ledger, prevLedger, faces] = await Promise.all([loadLedger(ym), loadLedger(shiftYm(ym, -1)), loadFaces()]);
  render();
}

// ===== 起動 =====
(async () => {
  await ensureStoreFixed({ grantAdmin: true });
  storeId = getStoreId();
  calendar = CALENDARS[storeId];
  if (!calendar) {
    document.querySelector('.fc-main').innerHTML = '<p class="fc-note">この店舗では、ファイナルカレンダーはまだ使えません。</p>';
    return;
  }
  document.getElementById('fc-bg').src = `${import.meta.env.BASE_URL}${calendar.bg}`;
  try {
    await loadCasts();
  } catch (e) {
    await dlg.alert(`キャストの一覧を読めませんでした。\n${e.message || e}`);
  }
  document.getElementById('fc-prev').addEventListener('click', () => openMonth(shiftYm(ym, -1)));
  document.getElementById('fc-next').addEventListener('click', () => openMonth(shiftYm(ym, 1)));
  document.getElementById('fc-save').addEventListener('click', onSave);
  document.getElementById('fc-hero-pick').addEventListener('click', onHeroPick);
  document.getElementById('fc-hero-auto').addEventListener('click', onHeroAuto);
  document.getElementById('fc-hero-file').addEventListener('change', onHeroFile);
  document.getElementById('fc-hero-file-clear').addEventListener('click', onHeroFileClear);
  document.getElementById('fc-face-list-open').addEventListener('click', toggleFaceList);
  await openMonth(businessYm());
})();
