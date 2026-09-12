// ハジメル向けの差し替え部品（2026-09-12）。
//
// `BACKEND=hajimeru` で焼く時だけ、vite の alias が `./supabaseClient.js` をこのファイルに差し替える。
// 元のコード（sync.js / storeSettings.js / consent.js）は 1 文字も直さない。
// ここは Supabase の client と**同じ顔**をして、中身をハジメルの口（同じ住所の /_h/app/board/*）に流す。
//
// できること（元のアプリが実際に使っている物だけ）:
//   from(table).select/eq/order/limit/maybeSingle/insert/upsert/update/delete
//   storage.from(bucket).upload/remove/getPublicUrl/list/download
//   channel(name).on('postgres_changes', …).subscribe()  → 3 秒ごとに「板が変わった回数」を見て差分を流す
//   removeChannel(ch)
// ⚠ 店（store_id）はこちらでは読まない。端末の合鍵（Cookie）で店が決まる。

const API = '/_h/app/board';

async function call(path, init = {}) {
  let res;
  try {
    res = await fetch(`${API}${path}`, { credentials: 'same-origin', ...init });
  } catch (e) {
    return { data: null, error: { message: `つながりません: ${e?.message || e}` } };
  }
  let body = null;
  try { body = await res.json(); } catch { /* 本文なし */ }
  if (!res.ok) return { data: null, error: (body && body.error) || { message: `HTTP ${res.status}` }, status: res.status };
  return body || { data: null, error: null };
}

// === 表の読み書き ===
class Query {
  constructor(table) {
    this.q = { table, op: 'select', select: '*', filters: [] };
  }
  select(cols = '*', opts = {}) {
    if (this.q.op === 'select') this.q.select = cols;
    if (opts.count) this.q.count = true;
    if (opts.head) this.q.head = true;
    return this;
  }
  eq(col, val) { this.q.filters.push({ col, op: 'eq', val }); return this; }
  order(col, opts = {}) { this.q.order = { col, asc: opts.ascending !== false }; return this; }
  limit(n) { this.q.limit = n; return this; }
  maybeSingle() { this.single = true; this.q.limit = 1; return this; }
  insert(rows) { this.q.op = 'insert'; this.q.rows = Array.isArray(rows) ? rows : [rows]; return this; }
  upsert(rows) { this.q.op = 'upsert'; this.q.rows = Array.isArray(rows) ? rows : [rows]; return this; }
  update(patch) { this.q.op = 'update'; this.q.patch = patch; return this; }
  delete() { this.q.op = 'delete'; return this; }
  async run() {
    const r = await call('/q', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(this.q) });
    if (this.single) return { data: Array.isArray(r.data) ? (r.data[0] ?? null) : null, error: r.error };
    return r;
  }
  then(onOk, onErr) { return this.run().then(onOk, onErr); }
}

// === 置き場所 ===
function storageFor(bucket) {
  const url = (path) => `${API}/file/${bucket}/${path.split('/').map(encodeURIComponent).join('/')}`;
  return {
    async upload(path, blob, opts = {}) {
      const body = blob instanceof Blob ? blob : new Blob([blob]);
      const r = await call(`/file/${bucket}/${path.split('/').map(encodeURIComponent).join('/')}${opts.upsert === false ? '?upsert=0' : ''}`, {
        method: 'PUT', headers: { 'content-type': opts.contentType || body.type || 'application/octet-stream' }, body,
      });
      return { data: r.data, error: r.error };
    },
    async remove(paths) {
      return call('/file/remove', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ bucket, paths }) });
    },
    getPublicUrl(path) { return { data: { publicUrl: url(path) } }; },
    async list(folder = '', _opts = {}) {
      return call(`/files/${bucket}?prefix=${encodeURIComponent(folder)}`);
    },
    async download(path) {
      try {
        const res = await fetch(url(path), { credentials: 'same-origin', cache: 'no-store' });
        if (!res.ok) return { data: null, error: { message: `HTTP ${res.status}` } };
        return { data: await res.blob(), error: null };
      } catch (e) { return { data: null, error: { message: String(e?.message || e) } }; }
    },
  };
}

// === リアルタイムの代わり（見張り） ===
// 板が変わった回数（rev）を 3 秒ごとに見て、変わっていたら購読中の表を読み直し、
// 前の写しと突き合わせて INSERT / UPDATE / DELETE の形で流す。
const POLL_MS = 3000;
const channels = new Set();
let timer = null;
let lastRev = null;
let polling = false;

function pkOf(table, row) {
  if (table === 'selections') return `${row.panel_id}|${row.color}`;
  if (table === 'store_settings') return 'one';
  return String(row.id);
}

async function snapshot(table) {
  const r = await new Query(table).select('*').run();
  const map = new Map();
  for (const row of (r.data || [])) map.set(pkOf(table, row), row);
  return map;
}

async function poll() {
  if (polling) return;
  polling = true;
  try {
    const r = await call('/rev');
    if (r.error) return;
    const rev = r.data?.rev ?? 0;
    if (lastRev === null) { lastRev = rev; return; }
    if (rev === lastRev) return;
    lastRev = rev;
    for (const ch of channels) {
      for (const sub of ch.subs) {
        const next = await snapshot(sub.table);
        const prev = sub.snap || new Map();
        for (const [k, row] of next) {
          if (!prev.has(k)) sub.emit({ eventType: 'INSERT', new: row, old: {} });
          else if (JSON.stringify(prev.get(k)) !== JSON.stringify(row)) sub.emit({ eventType: 'UPDATE', new: row, old: prev.get(k) });
        }
        for (const [k, row] of prev) if (!next.has(k)) sub.emit({ eventType: 'DELETE', new: {}, old: row });
        sub.snap = next;
      }
    }
  } finally { polling = false; }
}

function ensurePolling() {
  if (timer || channels.size === 0) return;
  timer = setInterval(poll, POLL_MS);
  poll();
}

class Channel {
  constructor(name) { this.name = name; this.subs = []; }
  on(_event, filter, cb) {
    const table = filter?.table;
    if (table) this.subs.push({ table, emit: (p) => { try { cb(p); } catch (e) { console.warn('見張りの反映に失敗', e); } }, snap: null });
    return this;
  }
  subscribe(cb) {
    channels.add(this);
    // いまの写しを取ってから見張り始める（最初の 1 回を「全部 INSERT」として流さない）
    Promise.all(this.subs.map(async (s) => { s.snap = await snapshot(s.table); }))
      .then(() => { ensurePolling(); if (cb) cb('SUBSCRIBED'); })
      .catch(() => { ensurePolling(); if (cb) cb('CHANNEL_ERROR'); });
    return this;
  }
}

export const supabase = {
  from: (table) => new Query(table),
  storage: { from: storageFor },
  channel: (name) => new Channel(name),
  removeChannel(ch) {
    channels.delete(ch);
    if (channels.size === 0 && timer) { clearInterval(timer); timer = null; lastRev = null; }
  },
  auth: { getSession: async () => ({ data: { session: null }, error: null }) },
};

export const PANEL_BUCKET = 'panel-images';

export function publicImageUrl(path) {
  if (!path) return '';
  return storageFor(PANEL_BUCKET).getPublicUrl(path).data.publicUrl;
}
