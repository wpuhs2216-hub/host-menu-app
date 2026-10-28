// ファイナルカレンダー（2026-10-01・まず GENTLY DIVA だけ）
// - 営業終わりに「その日のファイナルの人」を 1 人選ぶと、DAY1 から順に枠へ写真が入る
// - 上の大枠には、前月いちばんファイナルが多かった人が 1 か月乗る（自動。手で選び直すこともできる）
// - 背景は店ごとの 1 枚絵。灰色の枠の位置に写真を重ねる（位置は元絵 1240×1754 の画素で測った値）
// - 記録は Supabase の表ではなく、写真置き場（panel-images バケット）に月ごとの JSON で置く

import { supabase, PANEL_BUCKET, publicImageUrl } from './supabaseClient.js';
import { getStoreId, STORES } from './storeContext.js';
import { ensureStoreFixed } from './storeLogin.js';
import * as dlg from './dialog.js';

// 使える店と背景の絵。ここに無い店では画面を出さない
// layouts = その月から使う並び（新しい月ほど後ろ）。書いていない月は版 1（背景の絵に枠まで描いてある）
const DIVA_LAYOUTS = [{ from: '2026-11', layout: 'v2' }];
// monthStarts = 月の始まりを前へずらす日（営業日の日付）。2026-10-31 の営業から 11 月のカレンダーにする（本人指示 2026-10-29）
const DIVA_MONTH_STARTS = { '2026-11': '2026-10-31' };
const CALENDARS = {
  'gently-diva': { bg: 'finale/diva-bg.jpg', none: 'finale/diva-none.jpg', layouts: DIVA_LAYOUTS, monthStarts: DIVA_MONTH_STARTS },
  'test-store': { bg: 'finale/diva-bg.jpg', none: 'finale/diva-none.jpg', layouts: DIVA_LAYOUTS, monthStarts: DIVA_MONTH_STARTS }, // 動作確認用
};

// 元絵の大きさと、灰色の枠・大枠の位置（画素）
const ART_W = 1240;
const ART_H = 1754;
// 「画像で保存」の出来上がり（ストーリーの大きさ）
const STORY_W = 1080;
const STORY_H = 1920;
// 名前の字の大きさと、写真の切り取りの基準にする枠の大きさ（版 1 の枠）
const SLOT_W = 134;
const SLOT_H = 128;

// 版 1（2026-10 まで）: 背景の絵 1 枚に枠も大枠も描いてある。DAY1〜21、上の真ん中に大枠
const V1_XS = [58, 223, 388, 554, 719, 884, 1049];
const V1_YS = [926, 1135, 1343];
// 版 2（2026-11 から）: 白い所が透明な枠の絵（frame）を、季節の背景と左上の人の上に重ねる。
// DAY1〜20 と、左の「Today's FINALE」の大きな枠（その月の最後に入れた人）。位置は元絵 1240×1754 の画素
const V2_ROWS = [
  { y: 945, xs: [391, 556, 721, 886, 1051] },
  { y: 1155, xs: [391, 556, 721, 886, 1051] },
  { y: 1365, xs: [60, 225, 391, 556, 721, 886, 1051] },
  { y: 1575, xs: [60, 225, 391] },
];
const LAYOUTS = {
  v1: {
    frame: '',
    slots: Array.from({ length: 21 }, (_, i) => ({ x: V1_XS[i % 7], y: V1_YS[Math.floor(i / 7)], w: SLOT_W, h: SLOT_H })),
    hero: { x: 248, y: 184, w: 744, h: 666 },
    today: null,
  },
  v2: {
    frame: 'finale/diva-frame-v2.png',
    slots: V2_ROWS.flatMap((row) => row.xs.map((x) => ({ x, y: row.y, w: 133, h: 126 }))),
    hero: { x: 30, y: 40, w: 600, h: 870 }, // 下の端は枠の後ろに少しもぐる
    today: { x: 60, y: 997, w: 299, h: 284 },
  },
};

// 営業終わりは日付をまたぐので、朝 6 時までは前の日（前の月）として扱う
const DAY_CUTOFF_HOURS = 6;

// 「ファイナルなし」の日に入れる印（人の代わりに店のロゴを出す）
const NONE_ID = '__none__';
const NONE_NAME = 'ファイナルなし';
const NONE_CROP = { x: 0.5, y: 0.5, z: 1.3 };

let layout = LAYOUTS.v1;  // 表示中の月の並び（openMonth で決める）
function layoutOf(month) {
  let key = 'v1';
  for (const l of calendar?.layouts || []) if (month >= l.from) key = l.layout;
  return LAYOUTS[key];
}
const maxDays = () => layout.slots.length;

// @ハジメル ファイナル台帳: 月ごとの「その日のファイナルの人」の並びと、上の大枠の人・透過写真・人入りの背景（倉庫の finale/<店>/<年-月>.json） #一覧
const ledgerPath = (store, ym) => `finale/${store}/${ym}.json`;
const heroImagePath = (store, ym) => `finale/${store}/hero-${ym}-${Date.now()}.webp`;
const seasonBgPath = (store, ym, ext) => `finale/${store}/season-${ym}-${Date.now()}.${ext}`;
// @ハジメル 枠の顔の位置: キャストごとの「四角い枠で写真のどこを映すか」（中心と拡大率。倉庫の finale/<店>/faces.json） #設定
const facesPath = (store) => `finale/${store}/faces.json`;
// @ハジメル カレンダーの表示設定: 店ごとの見せ方（枠に名前を出すかどうか・季節の背景をどの月から使うか）。どの月にも効く（倉庫の finale/<店>/settings.json） #設定
const settingsPath = (store) => `finale/${store}/settings.json`;

let storeId = '';
let calendar = null;
let casts = [];          // 系列の全店のキャスト（名前がある人）。自分の店を先に、店の中では表示中→非表示の順。写真が無い人は名前だけ出す
let ym = '';             // 表示中の月 'YYYY-MM'
let ledger = emptyLedger();
let prevLedger = emptyLedger();
let faces = {};          // { panelId: { x, y, z, v, auto } }（x・y は写真の中の中心の位置 0〜1、z は拡大率）
let viewSettings = { showNames: true };

function emptyLedger() {
  return { version: 1, days: [], hero: null };
}

function businessYm(d = new Date()) {
  const t = new Date(d.getTime() - DAY_CUTOFF_HOURS * 3600 * 1000);
  const month = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}`;
  // 次の月の始まりが前にずらしてあれば、その日からは次の月
  const day = `${month}-${String(t.getDate()).padStart(2, '0')}`;
  const nextStart = calendar?.monthStarts?.[shiftYm(month, 1)];
  return nextStart && day >= nextStart ? shiftYm(month, 1) : month;
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
    return { ...emptyLedger(), ...json, days: trimDays(Array.isArray(json.days) ? json.days : []) };
  } catch {
    return emptyLedger();
  }
}

// 途中の日を消した所は null（空いた枠）で残す。うしろの空きは詰める（次の DAY がずれないように）
function trimDays(days) {
  const out = days.map((d) => (d && d.panelId ? d : null));
  while (out.length && !out[out.length - 1]) out.pop();
  return out;
}

async function saveLedger() {
  ledger.days = trimDays(ledger.days);
  ledger.updatedAt = new Date().toISOString();
  const blob = new Blob([JSON.stringify(ledger)], { type: 'application/json' });
  const { error } = await supabase.storage.from(PANEL_BUCKET).upload(ledgerPath(storeId, ym), blob, {
    contentType: 'application/json',
    upsert: true,
    cacheControl: '0',
  });
  if (error) throw error;
}

// 系列の全店（テスト店舗は自分がテスト店舗の時だけ）。自分の店を先頭に、あとは STORES の順
function storeOrder() {
  const ids = STORES.map((st) => st.id).filter((id) => id !== 'test-store' || id === storeId);
  return [storeId, ...ids.filter((id) => id !== storeId)];
}

function storeLabel(id) {
  return STORES.find((st) => st.id === id)?.name || id;
}

async function loadCasts() {
  const order = storeOrder();
  const { data, error } = await supabase
    .from('panels')
    .select('id, name, image_path, image_version, img_x, img_y, visible, has_image, "order", store_id')
    .in('store_id', order)
    .order('order');
  if (error) throw error;
  const named = (data || []).filter((p) => (p.name || '').trim());
  casts = order.flatMap((id) => {
    const mine = named.filter((p) => p.store_id === id);
    return [...mine.filter((p) => p.visible), ...mine.filter((p) => !p.visible)];
  });
}

// 店ごとのまとまりに分ける（casts の並びのまま）
function castGroups(list = casts) {
  const groups = [];
  for (const c of list) {
    let g = groups[groups.length - 1];
    if (!g || g.storeId !== c.store_id) { g = { storeId: c.store_id, name: storeLabel(c.store_id), items: [] }; groups.push(g); }
    g.items.push(c);
  }
  return groups;
}

function castLabel(c) {
  return c.visible ? c.name : `${c.name}（非表示）`;
}

// 枠と同じ切り取りの小さな写真（写真が無い人は灰色）
function cropThumb(c, cls) {
  const box = document.createElement('div');
  box.className = cls;
  const src = c === NONE_ID ? noneImage() : castPhoto(c);
  if (src) {
    const img = document.createElement('img');
    img.className = 'fc-crop';
    img.alt = '';
    img.loading = 'lazy';
    img.src = src;
    applyCrop(img, c === NONE_ID ? NONE_CROP : cropOf(c));
    box.appendChild(img);
  }
  return box;
}

function noneImage() {
  return calendar?.none ? `${import.meta.env.BASE_URL}${calendar.none}` : '';
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

// ===== 表示設定 =====
async function loadViewSettings() {
  const res = await fetch(`${publicImageUrl(settingsPath(storeId))}?t=${Date.now()}`, { cache: 'no-store' });
  const base = { showNames: true, seasonBgs: [] }; // seasonBgs = [{ from: 'YYYY-MM', path }]。その月から次の背景までずっと使う
  if (!res.ok) return base;
  try { return { ...base, ...(await res.json()) }; } catch { return base; }
}

async function saveViewSettings(patch) {
  const latest = { ...(await loadViewSettings()), ...patch };
  const blob = new Blob([JSON.stringify(latest)], { type: 'application/json' });
  const { error } = await supabase.storage.from(PANEL_BUCKET).upload(settingsPath(storeId), blob, {
    contentType: 'application/json',
    upsert: true,
    cacheControl: '0',
  });
  if (error) throw error;
  viewSettings = latest;
}

// ===== 枠の名前の組み方 =====
// 文字数では切らない。枠の幅（元絵の画素）に収まるよう 2 行まで折り返し、それでも入らなければ文字を小さくする。
// 画面と「画像で保存」で同じ結果になるよう、ここで 1 回決めた大きさと行を両方で使う。
const NAME_FONT = "'Noto Sans JP', sans-serif";
const NAME_MAX_W = SLOT_W - 8;
const NAME_SIZES = [17, 16, 15, 14, 13, 12, 11, 10, 9, 8];
const measureCtx = document.createElement('canvas').getContext('2d');

function breakLines(text, size) {
  measureCtx.font = `700 ${size}px ${NAME_FONT}`;
  const lines = [];
  let cur = '';
  for (const ch of [...text]) {
    if (cur && measureCtx.measureText(cur + ch).width > NAME_MAX_W) { lines.push(cur); cur = ch.trim() ? ch : ''; }
    else cur += ch;
  }
  if (cur) lines.push(cur);
  return lines;
}

function fitName(text) {
  const t = String(text || '').trim();
  for (const size of NAME_SIZES) {
    const lines = breakLines(t, size);
    if (lines.length <= 2) return { size, lines };
  }
  const size = NAME_SIZES[NAME_SIZES.length - 1];
  return { size, lines: breakLines(t, size) }; // とても長い名前は小さい字で 3 行以上になっても全部出す
}

// ===== 上の大枠の人を決める =====
// 手で選んだ人がいればその人。いなければ前月の回数がいちばん多い人（同じ回数なら先にその回数へ届いた人）
function resolveHero() {
  const h = ledger.hero || {};
  // frame = 大枠の人を背景の絵ごと作り直した 1 枚（元絵と同じ 1240×1754）。あれば背景をこれに替え、大枠には何も重ねない
  if (h.panelId) return { panelId: h.panelId, name: h.name, image: h.image || '', frame: h.frame || '', how: 'manual' };
  const counts = new Map();
  let best = null;
  for (const d of prevLedger.days) {
    if (!d || !d.panelId || d.panelId === NONE_ID) continue;
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

// その月の最後に入れた人（空いた枠は飛ばす）
function lastEntry() {
  for (let i = ledger.days.length - 1; i >= 0; i--) if (ledger.days[i]) return ledger.days[i];
  return null;
}

// その月に使う季節の背景（その月より前で、いちばん新しく載せた物）
function seasonBgFor(month) {
  let hit = null;
  for (const b of viewSettings.seasonBgs || []) if (b.from <= month && (!hit || b.from > hit.from)) hit = b;
  return hit;
}

// 枠より下に敷く絵。人入りの背景（hero.frame）> 版 2 は季節の背景 > 版 1 は店の背景の絵。無ければ白
function posterBgSrc() {
  const hero = resolveHero();
  if (hero.frame) return publicImageUrl(hero.frame);
  if (layout.frame) {
    const season = seasonBgFor(ym);
    return season ? publicImageUrl(season.path) : '';
  }
  return `${import.meta.env.BASE_URL}${calendar.bg}`;
}

// 枠の中身（写真と名前）を画面に置く。r は枠の大きさ（写真の切り取りに使う）
function fillSlotEl(el, d, r) {
  if (d.panelId === NONE_ID) {
    if (noneImage()) {
      const img = document.createElement('img');
      img.alt = NONE_NAME;
      img.src = noneImage();
      img.className = 'fc-crop';
      applyCrop(img, NONE_CROP, r.w, r.h);
      el.appendChild(img);
    }
    return;
  }
  const c = castById(d.panelId);
  if (castPhoto(c)) {
    const img = document.createElement('img');
    img.crossOrigin = 'anonymous';
    img.alt = d.name || '';
    img.src = castPhoto(c);
    img.className = 'fc-crop';
    applyCrop(img, cropOf(c), r.w, r.h);
    el.appendChild(img);
  }
  if (!viewSettings.showNames || !d.name) return;
  const name = document.createElement('span');
  name.className = 'fc-slot-name';
  const fit = fitName(d.name);
  name.style.fontSize = `${(fit.size / SLOT_W) * 100}cqw`; // 枠の幅に対する割合（保存画像と同じ比率）
  for (const [k, line] of fit.lines.entries()) {
    if (k) name.appendChild(document.createElement('br'));
    name.appendChild(document.createTextNode(line));
  }
  el.appendChild(name);
}

function render() {
  document.getElementById('fc-month-label').textContent = ymLabel(ym);

  // 日の枠
  const wrap = document.getElementById('fc-slots');
  wrap.innerHTML = '';
  const next = ledger.days.length;
  for (let i = 0; i < maxDays(); i++) {
    const d = ledger.days[i];
    const r = layout.slots[i];
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'fc-slot';
    placeBox(el, r);
    if (d) {
      fillSlotEl(el, d, r);
      el.addEventListener('click', () => onFilledSlot(i));
    } else if (i < next) {
      // 途中で消して空いた枠。押せばまた入れられる
      el.classList.add('fc-slot-hole');
      el.innerHTML = '<span class="fc-plus">＋</span>';
      el.addEventListener('click', () => onHoleSlot(i));
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

  // 「Today's FINALE」の枠（版 2）: その月の最後に入れた人
  const today = lastEntry();
  if (layout.today && today) {
    const el = document.createElement('div');
    el.className = 'fc-slot fc-today';
    placeBox(el, layout.today);
    fillSlotEl(el, today, layout.today);
    wrap.appendChild(el);
  }

  // 背景と枠の絵
  const poster = document.getElementById('fc-poster');
  const bgEl = document.getElementById('fc-bg');
  const bgSrc = posterBgSrc();
  poster.classList.toggle('fc-poster-light', !bgSrc);
  bgEl.hidden = !bgSrc;
  if (bgSrc && bgEl.getAttribute('src') !== bgSrc) bgEl.src = bgSrc;
  const frameEl = document.getElementById('fc-frame');
  const frameSrc = layout.frame ? `${import.meta.env.BASE_URL}${layout.frame}` : '';
  frameEl.hidden = !frameSrc;
  if (frameSrc && frameEl.getAttribute('src') !== frameSrc) frameEl.src = frameSrc;
  document.getElementById('fc-season').hidden = !layout.frame;
  const season = seasonBgFor(ym);
  document.getElementById('fc-season-desc').textContent = season
    ? `いまは ${ymLabel(season.from)} から載せた背景を使っています（次に載せ替えるまで、その後の月もずっと同じ背景です）。`
    : 'まだ背景がありません（白のままです）。季節の背景を載せると、この月から使います。';

  // 上の大枠（版 2 は左上）
  const hero = resolveHero();
  const box = document.getElementById('fc-hero');
  placeBox(box, layout.hero);
  box.innerHTML = '';
  box.classList.toggle('fc-hero-soft', !hero.image);
  const src = hero.frame ? '' : hero.image ? publicImageUrl(hero.image) : castPhoto(castById(hero.panelId));
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
  desc.textContent += hero.frame ? ' 背景の絵ごと作り直した 1 枚を使っています。' : hero.image ? ' 写真は背景を消した物を使っています。' : ' 写真はメニューの写真をふちをぼかして使っています。背景を消した写真を載せるときれいになります。';

  const last = ledger.days[ledger.days.length - 1];
  document.getElementById('fc-note').textContent = next >= maxDays()
    ? `今月の ${maxDays()} 枠はすべて埋まりました。`
    : `枠の「＋」を押して、今日のファイナルの人を選んでください（次は DAY${next + 1}）。${last ? `最後に入れたのは DAY${next}「${last.name}」さんです。` : ''}`;
}

// ===== 人を選ぶ小窓 =====
function pickCast(title, { allowRemove = false, allowNone = false } = {}) {
  return new Promise((resolve) => {
    const host = document.createElement('div');
    host.className = 'app-dialog-backdrop fc-picker-backdrop';
    host.innerHTML = `
      <div class="app-dialog-box fc-picker">
        <div class="fc-picker-title"></div>
        <div class="fc-picker-body"></div>
        <div class="fc-picker-actions">
          ${allowRemove ? '<button type="button" class="fc-remove">この枠から消す</button>' : ''}
          <button type="button" class="fc-cancel">やめる</button>
        </div>
      </div>`;
    host.querySelector('.fc-picker-title').textContent = title;
    const body = host.querySelector('.fc-picker-body');
    const tile = (c, label) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'fc-pick';
      const name = document.createElement('span');
      name.textContent = label;
      b.append(cropThumb(c, 'fc-pick-photo'), name);
      b.addEventListener('click', () => done(c === NONE_ID ? { id: NONE_ID, name: NONE_NAME } : c));
      return b;
    };
    if (allowNone && noneImage()) {
      const grid = document.createElement('div');
      grid.className = 'fc-picker-grid';
      grid.appendChild(tile(NONE_ID, NONE_NAME));
      body.appendChild(grid);
    }
    for (const g of castGroups()) {
      const grid = document.createElement('div');
      grid.className = 'fc-picker-grid';
      for (const c of g.items) grid.appendChild(tile(c, castLabel(c)));
      const wrap = document.createElement('details');
      wrap.className = 'fc-store-group';
      wrap.open = g.storeId === storeId; // 自分の店だけ開いておく
      const sum = document.createElement('summary');
      sum.textContent = `${g.name}（${g.items.length} 人）`;
      wrap.append(sum, grid);
      body.appendChild(wrap);
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
  if (ledger.days.length >= maxDays()) return;
  // 同じ営業日を 2 回入れてしまうのを防ぐ（最後の記録から 12 時間以内なら聞く）
  const last = ledger.days[ledger.days.length - 1];
  if (last && Date.now() - new Date(last.at).getTime() < 12 * 3600 * 1000) {
    const ok = await dlg.confirm(`さっき DAY${ledger.days.length} に「${last.name}」さんを入れたばかりです。\n別の営業日の分として DAY${ledger.days.length + 1} を入れますか？`, { okLabel: '入れる' });
    if (!ok) return;
  }
  const n = ledger.days.length + 1;
  const c = await pickCast(`DAY${n} のファイナル`, { allowNone: true });
  if (!c || c === 'remove') return;
  ledger = await loadLedger(ym); // 他の端末が先に入れていないか読み直す
  ledger.days.push({ panelId: c.id, name: c.name, at: new Date().toISOString() });
  await persist(`DAY${ledger.days.length} に「${c.name}」さんを入れました`);
}

// 途中で空いた枠に入れる
async function onHoleSlot(i) {
  const c = await pickCast(`DAY${i + 1} のファイナル（空いている枠）`, { allowNone: true });
  if (!c || c === 'remove') return;
  ledger = await loadLedger(ym);
  if (ledger.days[i]) { render(); dlg.toast(`DAY${i + 1} にはもう「${ledger.days[i].name}」さんが入っています`); return; }
  while (ledger.days.length <= i) ledger.days.push(null);
  ledger.days[i] = { panelId: c.id, name: c.name, at: new Date().toISOString() };
  await persist(`DAY${i + 1} に「${c.name}」さんを入れました`);
}

async function onFilledSlot(i) {
  const name = ledger.days[i].name;
  const c = await pickCast(`DAY${i + 1}（いまは「${name}」さん）を別の人に変える・この枠から消す`, { allowRemove: true, allowNone: true });
  if (!c) return;
  if (c === 'remove') {
    const later = i < ledger.days.length - 1;
    const ok = await dlg.confirm(`DAY${i + 1} の「${name}」さんを消しますか？${later ? `\nうしろの日は詰めず、DAY${i + 1} の枠だけが空きます。あとで押せばまた入れられます。` : ''}`, { okLabel: '消す', danger: true });
    if (!ok) return;
  }
  ledger = await loadLedger(ym);
  if (!ledger.days[i]) { render(); return; }
  if (c === 'remove') {
    ledger.days[i] = null;
    await persist(`DAY${i + 1} を消しました`);
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
  const same = ledger.hero?.panelId === c.id;
  ledger.hero = { panelId: c.id, name: c.name, image: (same && ledger.hero.image) || '', frame: (same && ledger.hero.frame) || '' };
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
  if (!ledger.hero?.image && !ledger.hero?.frame) { dlg.toast('載せた写真はありません'); return; }
  ledger.hero = { ...ledger.hero, image: '', frame: '' };
  await persist('載せた写真を外しました');
}

// ===== 季節の背景（版 2）=====
// 表示中の月から使う。次に載せ替えるまで、その後の月もずっと同じ背景
async function onSeasonFile(e) {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (!file) return;
  try {
    const ext = file.type === 'image/png' ? 'png' : file.type === 'image/webp' ? 'webp' : 'jpg';
    const path = seasonBgPath(storeId, ym, ext);
    const { error } = await supabase.storage.from(PANEL_BUCKET).upload(path, file, {
      contentType: file.type || 'image/jpeg',
      upsert: false,
      cacheControl: '3600',
    });
    if (error) throw error;
    const list = ((await loadViewSettings()).seasonBgs || []).filter((b) => b.from !== ym);
    await saveViewSettings({ seasonBgs: [...list, { from: ym, path }] });
    render();
    dlg.toast(`${ymLabel(ym)} から、この背景を使います`);
  } catch (err) {
    await dlg.alert(`背景を載せられませんでした。\n${err.message || err}`);
  }
}

async function onSeasonClear() {
  const list = (await loadViewSettings()).seasonBgs || [];
  if (!list.some((b) => b.from === ym)) {
    await dlg.alert(`${ymLabel(ym)} から載せた背景はありません。前の月から続いている背景は、その月を開いて外してください。`);
    return;
  }
  try {
    await saveViewSettings({ seasonBgs: list.filter((b) => b.from !== ym) });
    render();
    dlg.toast(`${ymLabel(ym)} から載せた背景を外しました`);
  } catch (err) {
    await dlg.alert(`保存できませんでした。\n${err.message || err}`);
  }
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
  for (const g of castGroups(casts.filter((c) => castPhoto(c)))) {
    const grid = document.createElement('div');
    grid.className = 'fc-face-grid';
    for (const c of g.items) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'fc-face-item';
      const name = document.createElement('span');
      name.textContent = castLabel(c);
      b.append(cropThumb(c, 'fc-face-thumb'), name);
      b.addEventListener('click', () => editFace(c));
      grid.appendChild(b);
    }
    const wrap = document.createElement('details');
    wrap.className = 'fc-store-group';
    wrap.open = g.storeId === storeId;
    const sum = document.createElement('summary');
    sum.textContent = `${g.name}（${g.items.length} 人）`;
    wrap.append(sum, grid);
    list.appendChild(wrap);
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

// 枠の中身（写真と名前）を保存画像に描く。名前は画面と同じく枠の幅に比例させる
async function drawSlotEntry(ctx, d, r) {
  if (d.panelId === NONE_ID) {
    // ファイナルなしの日は店のロゴだけ（名前の帯は付けない）
    const logo = await loadImg(noneImage());
    if (logo) drawCrop(ctx, logo, r, NONE_CROP);
    return;
  }
  const c = castById(d.panelId);
  const img = await loadImg(castPhoto(c));
  if (img) drawCrop(ctx, img, r, cropOf(c));
  // 名前（下に薄い帯）。名前を出さない設定の時は描かない
  if (!viewSettings.showNames || !d.name) return;
  const k = r.w / SLOT_W;
  const fit = fitName(d.name);
  const size = fit.size * k;
  const lineH = Math.round(size * 1.2);
  const bandH = Math.min(r.h, lineH * fit.lines.length + 16 * k);
  const g = ctx.createLinearGradient(0, r.y + r.h - bandH, 0, r.y + r.h);
  g.addColorStop(0, 'rgba(0,0,0,0)');
  g.addColorStop(1, 'rgba(0,0,0,0.75)');
  ctx.fillStyle = g;
  ctx.fillRect(r.x, r.y + r.h - bandH, r.w, bandH);
  ctx.fillStyle = '#fff';
  ctx.font = `700 ${size}px ${NAME_FONT}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  fit.lines.forEach((line, j) => {
    const y = r.y + r.h - 7 * k - (fit.lines.length - 1 - j) * lineH;
    ctx.fillText(line, r.x + r.w / 2, y);
  });
}

async function onSave() {
  const btn = document.getElementById('fc-save');
  btn.disabled = true;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = ART_W;
    canvas.height = ART_H;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff'; // 背景の無い月は白
    ctx.fillRect(0, 0, ART_W, ART_H);
    const bg = await loadImg(posterBgSrc());
    if (bg) ctx.drawImage(bg, 0, 0, ART_W, ART_H);
    const HERO = layout.hero;

    // 上の大枠
    const hero = resolveHero();
    if (hero.frame) {
      // 人入りの背景を使う月は、背景だけで大枠ができている
    } else if (hero.image) {
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

    // 枠の絵（版 2）。人の写真の上、日の枠の写真の下
    if (layout.frame) {
      const frame = await loadImg(`${import.meta.env.BASE_URL}${layout.frame}`);
      if (frame) ctx.drawImage(frame, 0, 0, ART_W, ART_H);
    }

    // 日の枠
    for (let i = 0; i < ledger.days.length && i < maxDays(); i++) {
      if (ledger.days[i]) await drawSlotEntry(ctx, ledger.days[i], layout.slots[i]); // 空いた枠は灰色のまま
    }
    const today = lastEntry();
    if (layout.today && today) await drawSlotEntry(ctx, today, layout.today);

    // ストーリーの大きさ（縦長 9:16）に入れ、上下の余りは黒で埋める
    const story = document.createElement('canvas');
    story.width = STORY_W;
    story.height = STORY_H;
    const sctx = story.getContext('2d');
    sctx.fillStyle = '#000';
    sctx.fillRect(0, 0, STORY_W, STORY_H);
    sctx.imageSmoothingQuality = 'high';
    const artH = Math.round((STORY_W * ART_H) / ART_W);
    sctx.drawImage(canvas, 0, Math.round((STORY_H - artH) / 2), STORY_W, artH);

    const blob = await new Promise((resolve) => story.toBlob(resolve, 'image/png'));
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
  layout = layoutOf(ym);
  [ledger, prevLedger, faces, viewSettings] = await Promise.all([loadLedger(ym), loadLedger(shiftYm(ym, -1)), loadFaces(), loadViewSettings()]);
  document.getElementById('fc-show-names').checked = viewSettings.showNames !== false;
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
  document.getElementById('fc-season-file').addEventListener('change', onSeasonFile);
  document.getElementById('fc-season-clear').addEventListener('click', onSeasonClear);
  document.getElementById('fc-show-names').addEventListener('change', async (e) => {
    const on = e.target.checked;
    try {
      await saveViewSettings({ showNames: on });
      render();
      dlg.toast(on ? '枠に名前を出します' : '枠の名前を消しました');
    } catch (err) {
      e.target.checked = !on;
      await dlg.alert(`保存できませんでした。\n${err.message || err}`);
    }
  });
  // 名前の幅を正しく測るため、書体が届くのを待つ（届かなくても 3 秒で先へ進む）
  try { await Promise.race([document.fonts.load(`700 17px ${NAME_FONT}`, 'あ'), new Promise((r) => setTimeout(r, 3000))]); } catch { /* ignore */ }
  await openMonth(businessYm());
})();
