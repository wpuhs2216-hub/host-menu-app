// 店舗ごとの運用設定（卓番リスト・色ラベル）
// - Supabase の store_settings テーブル（store_id 単位で1行）に保存し全端末で共有
// - localStorage にキャッシュしてオフラインでも利用可能
// - 行が無い店舗はデフォルト値（既存 GENTLY DIVA の卓番・壁側/通路側ラベル）で動く

import { supabase } from './supabaseClient.js';
import { getStoreId } from './storeContext.js';

// storeContext.logoutStore からも参照されるキャッシュキー（店舗切替時に破棄）
export const STORE_SETTINGS_KEY = 'host-menu-store-settings';

// デフォルト卓番（従来ハードコードされていた GENTLY DIVA の卓番）
export const DEFAULT_SEAT_OPTIONS = ['A', 'B-1', 'B-2', 'C-1', 'C-2', 'D', 'E-1', 'E-2', 'E-3'];

// デフォルト色ラベル（yellow=壁側 / red=通路側、他は空欄=色名フォールバック）
export const DEFAULT_COLOR_LABELS = { yellow: '壁側', red: '通路側', blue: '', green: '' };

// 空欄時のフォールバック表示（従来表示と同じ英語色名）
const COLOR_NAME_FALLBACK = { yellow: 'Yellow', red: 'Red', blue: 'Blue', green: 'Green' };

const COLOR_KEYS = ['yellow', 'red', 'blue', 'green'];

function normalize(raw) {
  const out = {
    seatOptions: [...DEFAULT_SEAT_OPTIONS],
    colorLabels: { ...DEFAULT_COLOR_LABELS },
  };
  if (raw && Array.isArray(raw.seatOptions)) {
    out.seatOptions = raw.seatOptions.map((s) => String(s).trim()).filter(Boolean);
  }
  if (raw && raw.colorLabels && typeof raw.colorLabels === 'object') {
    for (const c of COLOR_KEYS) {
      if (typeof raw.colorLabels[c] === 'string') out.colorLabels[c] = raw.colorLabels[c].trim();
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

// クラウド → ローカル（行が無ければローカル値を維持）
export async function pullStoreSettings() {
  const { data, error } = await supabase
    .from('store_settings')
    .select('seat_options, color_labels')
    .eq('store_id', getStoreId())
    .maybeSingle();
  if (error) throw error;
  if (!data) {
    // 行が無い店舗もデフォルトラベルを sw 用キャッシュに反映しておく
    const current = loadStoreSettings();
    saveSwCache(current);
    return current;
  }
  const settings = normalize({ seatOptions: data.seat_options, colorLabels: data.color_labels });
  saveLocal(settings);
  return settings;
}

// 保存（ローカル即時反映 + クラウド upsert。クラウド失敗時は throw）
export async function saveStoreSettings({ seatOptions, colorLabels }) {
  const settings = normalize({ seatOptions, colorLabels });
  saveLocal(settings);
  const { error } = await supabase.from('store_settings').upsert({
    store_id: getStoreId(),
    seat_options: settings.seatOptions,
    color_labels: settings.colorLabels,
  });
  if (error) throw error;
  return settings;
}
