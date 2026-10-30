// ファイナルカレンダーの枠を絵ではなくプログラムで描く（版 2 のプログラム版・2026-10-29 試し）
// - 元絵（版 2 の枠の絵）を 1 画素ずつ測った寸法で、セル・見出し・すき間・外枠を描く
// - 日数を変えると、並びと外枠の形が自動で組み変わる（左上の 2×2 が「Today's FINALE」、残りを左上から順に DAY を詰める）
// - ロゴ（GENTLY DIVA と白い光）は描き直さず、絵のまま重ねる
// 寸法はすべて元絵の画素（SRC）。最後に左右の縁へぴったり合う倍率で 1240×1754 の台に置く

export const FRAME_FONT = "'Abril Fatface', 'Playfair Display', serif";
// 元絵の書体は Abril Fatface より横に広い（同じ高さで幅が約 1.3 倍）。横に伸ばして幅をそろえる
const TEXT_STRETCH = 1.3;
const TODAY_STRETCH = 1.22; // 「Today's FINALE」は少し控えめ（元絵の幅に合わせた）

const ART_W = 1240;
const ART_H = 1754;

// 元絵で測った値
const COLS = 7;
const COL_X0 = 49;      // 1 列目のセルの左
const PITCH_X = 165;    // セルの横の間隔（セル 157 + すき間 8）
const ROW_Y0 = 883;     // 1 段目のセルの上
const PITCH_Y = 209.5;  // セルの縦の間隔（セル 202 + すき間 7.5）
const CELL_W = 157;
const CELL_H = 202;
const PAD = 6;          // 外枠の線からセルまで（白いすき間）
const PHOTO = { left: 12, right: 12, top: 62, bottom: 12 };      // DAY のセルの中の写真の場所
const TODAY_PHOTO = { left: 11, right: 12, top: 114, bottom: 13 }; // Today's FINALE の写真の場所

const COLOR = {
  cell: '#464646',
  cellEdge: '#2b2b2b',
  photo: '#d1d1d1',
  photoEdge: '#dcdcdc',
  photoShadow: 'rgba(0, 0, 0, 0.55)',
  matTop: '#fdfdfd',
  matBottom: '#eef2f6',
  border: '#2e2e2e',
  text: '#f7f7f7',
  textShadow: 'rgba(0, 0, 0, 0.65)',
};

// 日数から、セルの並び（元絵の画素）を決める
function cellsFor(days) {
  const cells = [];
  let row = 0;
  let col = 2;
  for (let i = 0; i < days; i++) {
    if (col >= COLS) { row++; col = row < 2 ? 2 : 0; }
    cells.push({ row, col });
    col++;
  }
  const rows = Math.max(2, row + 1);
  return { cells, rows };
}

const cellRect = (row, col, rowSpan = 1, colSpan = 1) => ({
  x: COL_X0 + col * PITCH_X,
  y: ROW_Y0 + row * PITCH_Y,
  w: CELL_W + (colSpan - 1) * PITCH_X,
  h: CELL_H + (rowSpan - 1) * PITCH_Y,
});

const inset = (r, p) => ({ x: r.x + p.left, y: r.y + p.top, w: r.w - p.left - p.right, h: r.h - p.top - p.bottom });

// 並び（台の上の画素）。slots / today は写真を置く場所、hero は左上の人の場所
export function frameGeometry(days) {
  const { cells, rows } = cellsFor(days);
  // 外枠の箱（元絵の画素）
  const left = COL_X0 - PAD - 1;
  const right = COL_X0 + (COLS - 1) * PITCH_X + CELL_W + PAD;
  const top = ROW_Y0 - PAD - 1;
  const bottom = ROW_Y0 + (rows - 1) * PITCH_Y + CELL_H + PAD;
  const scale = ART_W / (right - left);
  const offY = ART_H - (bottom - top) * scale;
  const fit = (r) => ({ x: (r.x - left) * scale, y: offY + (r.y - top) * scale, w: r.w * scale, h: r.h * scale });

  // 最後の段が右まで埋まっていなければ、外枠は階段の形になる
  const last = cells[cells.length - 1];
  const lastRowFull = !last || last.row < 2 || last.col === COLS - 1;
  const lastRight = last ? COL_X0 + last.col * PITCH_X + CELL_W + PAD : right;
  const stepY = ROW_Y0 + (rows - 1) * PITCH_Y - PITCH_Y + CELL_H + PAD;
  const outline = lastRowFull
    ? [[left, top], [right, top], [right, bottom], [left, bottom]]
    : [[left, top], [right, top], [right, stepY], [lastRight, stepY], [lastRight, bottom], [left, bottom]];

  const todayCell = cellRect(0, 0, 2, 2);
  return {
    scale,
    top: offY,
    outline: outline.map(([x, y]) => [(x - left) * scale, offY + (y - top) * scale]),
    today: { cell: fit(todayCell), photo: fit(inset(todayCell, TODAY_PHOTO)) },
    days: cells.map((c, i) => {
      const r = cellRect(c.row, c.col);
      return { n: i + 1, cell: fit(r), photo: fit(inset(r, PHOTO)) };
    }),
  };
}

function pathOf(ctx, pts) {
  ctx.beginPath();
  pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.closePath();
}

function drawCell(ctx, cell, photo, k) {
  // セル（少し上が暗い）
  const g = ctx.createLinearGradient(0, cell.y, 0, cell.y + 30 * k);
  g.addColorStop(0, '#3c3c3c');
  g.addColorStop(1, COLOR.cell);
  ctx.fillStyle = g;
  ctx.fillRect(cell.x, cell.y, cell.w, cell.h);
  ctx.strokeStyle = COLOR.cellEdge;
  ctx.lineWidth = 1.5 * k;
  ctx.strokeRect(cell.x, cell.y, cell.w, cell.h);
  // 写真の場所（外側に細い影、内側に明るい線）
  ctx.save();
  ctx.shadowColor = COLOR.photoShadow;
  ctx.shadowBlur = 3 * k;
  ctx.fillStyle = COLOR.photo;
  ctx.fillRect(photo.x, photo.y, photo.w, photo.h);
  ctx.restore();
  ctx.strokeStyle = COLOR.photoEdge;
  ctx.lineWidth = 1 * k;
  ctx.strokeRect(photo.x + 0.5 * k, photo.y + 0.5 * k, photo.w - k, photo.h - k);
}

function withTextShadow(ctx, k, fn) {
  ctx.save();
  ctx.shadowColor = COLOR.textShadow;
  ctx.shadowOffsetX = 1.5 * k;
  ctx.shadowOffsetY = 2 * k;
  ctx.shadowBlur = 2.5 * k;
  ctx.fillStyle = COLOR.text;
  fn();
  ctx.restore();
}

// 横に伸ばして描く（cx を中心に）
function stretched(ctx, cx, fn, sx = TEXT_STRETCH) {
  ctx.translate(cx, 0);
  ctx.scale(sx, 1);
  fn();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

// 「DAY」は小さく、数字は大きく。2 つ合わせてセルの真ん中にそろえる
function drawDayLabel(ctx, cell, n, k) {
  const small = 21 * k;
  const big = 31.5 * k;
  const baseline = cell.y + 40 * k;
  ctx.textBaseline = 'alphabetic';
  ctx.font = `${small}px ${FRAME_FONT}`;
  const w1 = ctx.measureText('DAY').width;
  ctx.font = `${big}px ${FRAME_FONT}`;
  const w2 = ctx.measureText(String(n)).width;
  const x = -(w1 + 1 * k + w2) / 2; // 伸ばす前の幅で真ん中
  withTextShadow(ctx, k, () => stretched(ctx, cell.x + cell.w / 2, () => {
    ctx.textAlign = 'left';
    ctx.font = `${small}px ${FRAME_FONT}`;
    ctx.fillText('DAY', x, baseline);
    ctx.font = `${big}px ${FRAME_FONT}`;
    ctx.fillText(String(n), x + w1 + 1 * k, baseline);
  }));
}

function drawTodayLabel(ctx, cell, k) {
  const size = 42 * k;
  withTextShadow(ctx, k, () => stretched(ctx, cell.x + cell.w / 2, () => {
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.font = `${size}px ${FRAME_FONT}`;
    ctx.fillText('Today’s', 0, cell.y + 52 * k);
    ctx.fillText('FINALE', 0, cell.y + 87 * k);
  }, TODAY_STRETCH));
}

// ロゴの下・カレンダーの真上に「2026.11 / FINAL CALENDAR」（年と月は表示中の月）
// 置き場所はロゴの絵の文字の範囲（x 692〜1168）の真ん中。ロゴと同じく白い光を付けて、暗い背景でも読めるようにする
const TITLE = { cx: 930, maxW: 476, gap: 24, ink: '#141414', glow: 'rgba(255, 255, 255, 0.95)' };

function drawTitle(ctx, ym, top) {
  const month = String(ym || '').replace('-', '.');
  if (!month) return;
  const sub = 'FINAL CALENDAR';
  const bigSize = 74;
  let subSize = 40;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.font = `${subSize}px ${FRAME_FONT}`;
  ctx.letterSpacing = '3px';
  const w = ctx.measureText(sub).width;
  if (w > TITLE.maxW) { subSize *= TITLE.maxW / w; ctx.font = `${subSize}px ${FRAME_FONT}`; }
  const subBase = top - TITLE.gap;
  const bigBase = subBase - subSize * 1.15;
  const paint = (stroke = false) => {
    const put = (t, y) => (stroke ? ctx.strokeText(t, TITLE.cx, y) : ctx.fillText(t, TITLE.cx, y));
    ctx.font = `${bigSize}px ${FRAME_FONT}`;
    ctx.letterSpacing = '2px';
    put(month, bigBase);
    ctx.font = `${subSize}px ${FRAME_FONT}`;
    ctx.letterSpacing = '3px';
    put(sub, subBase);
  };
  ctx.save();
  // 白い光（ロゴと同じくらいの濃さ。大きいぼかしから順に重ね、最後に白い縁取り）
  ctx.fillStyle = TITLE.glow;
  ctx.shadowColor = TITLE.glow;
  for (const blur of [40, 28, 18, 10, 5]) { ctx.shadowBlur = blur; paint(); }
  ctx.shadowColor = 'transparent';
  ctx.strokeStyle = '#ffffff';
  ctx.lineJoin = 'round';
  ctx.lineWidth = 7;
  paint(true);
  ctx.fillStyle = TITLE.ink;
  paint();
  ctx.restore();
  ctx.letterSpacing = '0px';
}

// 枠の絵を 1 枚作る（1240×1754・透明の台）。logo はロゴと白い光だけの絵（台の上の部分 1240×800）。ym は「2026-11」の形
export function drawFrame(days, logo, ym) {
  const geo = frameGeometry(days);
  const k = geo.scale;
  const canvas = document.createElement('canvas');
  canvas.width = ART_W;
  canvas.height = ART_H;
  const ctx = canvas.getContext('2d');
  if (logo) ctx.drawImage(logo, 0, 0); // ロゴの絵は台の左上から（幅 1240・高さ 800）
  drawTitle(ctx, ym, geo.top);

  // 外枠（影 → 白いすき間 → 線）
  ctx.save();
  ctx.shadowColor = 'rgba(0, 0, 0, 0.35)';
  ctx.shadowBlur = 8 * k;
  ctx.shadowOffsetX = 2 * k;
  ctx.shadowOffsetY = 3 * k;
  pathOf(ctx, geo.outline);
  const mat = ctx.createLinearGradient(0, geo.top, 0, ART_H);
  mat.addColorStop(0, COLOR.matTop);
  mat.addColorStop(1, COLOR.matBottom);
  ctx.fillStyle = mat;
  ctx.fill();
  ctx.restore();
  pathOf(ctx, geo.outline);
  ctx.strokeStyle = COLOR.border;
  ctx.lineWidth = 2 * k;
  ctx.stroke();

  drawCell(ctx, geo.today.cell, geo.today.photo, k);
  drawTodayLabel(ctx, geo.today.cell, k);
  for (const d of geo.days) {
    drawCell(ctx, d.cell, d.photo, k);
    drawDayLabel(ctx, d.cell, d.n, k);
  }
  return { canvas, geo };
}
