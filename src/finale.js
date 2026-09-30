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

let storeId = '';
let calendar = null;
let casts = [];          // この店のキャスト（名前があって表示中のものだけ。写真が無い人は名前だけ出す）
let ym = '';             // 表示中の月 'YYYY-MM'
let ledger = emptyLedger();
let prevLedger = emptyLedger();

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
        img.style.objectPosition = `${c.img_x ?? 50}% ${c.img_y ?? 30}%`;
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
      if (img) drawCover(ctx, img, r, c?.img_x ?? 50, c?.img_y ?? 30);
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
  [ledger, prevLedger] = await Promise.all([loadLedger(ym), loadLedger(shiftYm(ym, -1))]);
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
  await openMonth(businessYm());
})();
