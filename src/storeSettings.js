// 店舗ごとの運用設定（卓番リスト・色ラベル）
// - Supabase の store_settings テーブル（store_id 単位で1行）に保存し全端末で共有
// - localStorage にキャッシュしてオフラインでも利用可能
// - 行が無い店舗はデフォルト値（既存 GENTLY DIVA の卓番・壁側/通路側ラベル）で動く

import { supabase } from './supabaseClient.js';
import { getStoreId } from './storeContext.js';

// @ハジメル 店の設定の控え: クラウドの店の設定をこの端末に写した物。圏外でも使えるように置く
// storeContext.logoutStore からも参照されるキャッシュキー（店舗切替時に破棄）
export const STORE_SETTINGS_KEY = 'host-menu-store-settings';

// デフォルト卓番（従来ハードコードされていた GENTLY DIVA の卓番）
export const DEFAULT_SEAT_OPTIONS = ['A', 'B-1', 'B-2', 'C-1', 'C-2', 'D', 'E-1', 'E-2', 'E-3'];

// デフォルト色ラベル（yellow=壁側 / red=通路側、他は空欄=色名フォールバック）
export const DEFAULT_COLOR_LABELS = { yellow: '壁側', red: '通路側', blue: '', green: '' };

// 空欄時のフォールバック表示（従来表示と同じ英語色名）
const COLOR_NAME_FALLBACK = { yellow: 'Yellow', red: 'Red', blue: 'Blue', green: 'Green' };

const COLOR_KEYS = ['yellow', 'red', 'blue', 'green'];

// 選べるフォント（全端末共通）。Google Fonts から読み込む。
// id='' はデフォルト（従来の Noto Sans JP）。google はCDN読み込み用のファミリ指定、css は font-family 値。
export const FONT_OPTIONS = [
  { id: '', label: 'デフォルト（標準ゴシック）', css: "'Noto Sans JP', 'Hiragino Kaku Gothic ProN', sans-serif", google: '' },
  { id: 'shippori-mincho', label: '明朝（高級・上品）', css: "'Shippori Mincho B1', serif", google: 'Shippori+Mincho+B1:wght@500;700' },
  { id: 'zen-old-mincho', label: '明朝（格調）', css: "'Zen Old Mincho', serif", google: 'Zen+Old+Mincho:wght@600;700' },
  { id: 'yuji-syuku', label: '筆文字（和・粋）', css: "'Yuji Syuku', serif", google: 'Yuji+Syuku' },
  { id: 'dela-gothic', label: '極太ゴシック（インパクト）', css: "'Dela Gothic One', sans-serif", google: 'Dela+Gothic+One' },
  { id: 'reggae', label: '個性派 極太', css: "'Reggae One', sans-serif", google: 'Reggae+One' },
  { id: 'klee', label: '手書き楷書（上品）', css: "'Klee One', cursive", google: 'Klee+One:wght@600' },
  { id: 'zen-kaku', label: 'モダン角ゴ', css: "'Zen Kaku Gothic New', sans-serif", google: 'Zen+Kaku+Gothic+New:wght@500;700' },
];

function fontById(id) {
  return FONT_OPTIONS.find((f) => f.id === id) || FONT_OPTIONS[0];
}

function normalize(raw) {
  const out = {
    seatOptions: [...DEFAULT_SEAT_OPTIONS],
    colorLabels: { ...DEFAULT_COLOR_LABELS },
    font: '',
    // 店ごとの既定設定（台に上書きが無い時に効く）。{ 設定名: true/false }
    deviceDefaults: {},
  };
  if (raw && Array.isArray(raw.seatOptions)) {
    out.seatOptions = raw.seatOptions.map((s) => String(s).trim()).filter(Boolean);
  }
  if (raw && raw.colorLabels && typeof raw.colorLabels === 'object') {
    for (const c of COLOR_KEYS) {
      if (typeof raw.colorLabels[c] === 'string') out.colorLabels[c] = raw.colorLabels[c].trim();
    }
  }
  if (raw && typeof raw.font === 'string' && FONT_OPTIONS.some((f) => f.id === raw.font)) {
    out.font = raw.font;
  }
  if (raw && raw.deviceDefaults && typeof raw.deviceDefaults === 'object') {
    for (const [k, v] of Object.entries(raw.deviceDefaults)) {
      if (typeof v === 'boolean') out.deviceDefaults[k] = v;
    }
  }
  return out;
}

export function loadStoreSettings() {
  try {
    const saved = localStorage.getItem(STORE_SETTINGS_KEY);
    if (saved) return normalize(JSON.parse(saved));
  } catch { /* fall through */ }
  return normalize(null);
}

// Service Worker（Web Push 通知本文の色ラベル書き換え）から参照できるよう
// Cache Storage にも保存する（sw は localStorage を読めないため）
function saveSwCache(settings) {
  try {
    if (typeof caches === 'undefined') return;
    caches.open('hm-store-settings').then((cache) =>
      cache.put('/__store-settings', new Response(JSON.stringify(settings), {
        headers: { 'Content-Type': 'application/json' },
      }))
    ).catch(() => {});
  } catch { /* ignore */ }
}

function saveLocal(settings) {
  localStorage.setItem(STORE_SETTINGS_KEY, JSON.stringify(settings));
  saveSwCache(settings);
}

// 卓番リスト（選択肢。自由入力「その他」は常に別途表示される）
export function getSeatOptions() {
  return loadStoreSettings().seatOptions;
}

// 色ラベル（空欄はフォールバックの色名を返す）
export function getColorLabel(color) {
  const labels = loadStoreSettings().colorLabels;
  return labels[color] || COLOR_NAME_FALLBACK[color] || color;
}

// 色ラベルの生値（空欄は空のまま。設定 UI 用）
export function getRawColorLabels() {
  return loadStoreSettings().colorLabels;
}

// 店ごとの既定設定（{ 設定名: true/false }）。行が無い店は空＝すべてプログラムの既定値のまま
export function getStoreDeviceDefaults() {
  return loadStoreSettings().deviceDefaults;
}

// 選択中フォント id
export function getFont() {
  return loadStoreSettings().font;
}

// 選択フォントを画面に適用する。
// - Google Fonts の <link> を必要時だけ注入
// - CSS 変数 --menu-font に font-family を設定（源氏名・役職に効く）
export function applyMenuFont(id = getFont()) {
  const opt = fontById(id);
  // Google Fonts 読み込み（デフォルト以外）
  if (opt.google) {
    const linkId = `gf-${opt.id}`;
    if (!document.getElementById(linkId)) {
      const link = document.createElement('link');
      link.id = linkId;
      link.rel = 'stylesheet';
      link.href = `https://fonts.googleapis.com/css2?family=${opt.google}&display=swap`;
      document.head.appendChild(link);
    }
  }
  document.documentElement.style.setProperty('--menu-font', opt.css);
}

// クラウド → ローカル（行が無ければローカル値を維持）
export async function pullStoreSettings() {
  const { data, error } = await supabase
    .from('store_settings')
    .select('seat_options, color_labels, ui_font, device_defaults')
    .eq('store_id', getStoreId())
    .maybeSingle();
  if (error) throw error;
  if (!data) {
    // 行が無い店舗もデフォルトラベルを sw 用キャッシュに反映しておく
    const current = loadStoreSettings();
    saveSwCache(current);
    return current;
  }
  const settings = normalize({
    seatOptions: data.seat_options,
    colorLabels: data.color_labels,
    font: data.ui_font,
    deviceDefaults: data.device_defaults,
  });
  saveLocal(settings);
  return settings;
}

// 保存（ローカル即時反映 + クラウド upsert。クラウド失敗時は throw）
export async function saveStoreSettings({ seatOptions, colorLabels, font, deviceDefaults }) {
  // deviceDefaults を渡さなかった時は今の値を保つ（卓番だけ保存しても既定設定が消えないように）
  const keep = loadStoreSettings();
  const settings = normalize({
    seatOptions,
    colorLabels,
    font,
    deviceDefaults: deviceDefaults === undefined ? keep.deviceDefaults : deviceDefaults,
  });
  saveLocal(settings);
  const { error } = await supabase.from('store_settings').upsert({
    store_id: getStoreId(),
    seat_options: settings.seatOptions,
    color_labels: settings.colorLabels,
    ui_font: settings.font,
    device_defaults: settings.deviceDefaults,
  });
  if (error) throw error;
  return settings;
}
