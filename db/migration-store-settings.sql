-- ============================================================
-- 店舗設定テーブル（卓番リスト・色ラベルを店舗ごとに保存）
-- 使い方: Supabase Dashboard → SQL Editor に貼って Run（非破壊）
-- 行が無い店舗はアプリ側デフォルト（GENTLY DIVA の卓番・壁側/通路側ラベル）で動く
-- ============================================================

create table if not exists public.store_settings (
  store_id text primary key,
  seat_options jsonb not null default '[]'::jsonb,
  color_labels jsonb not null default '{}'::jsonb,
  updated_at timestamptz default now()
);

-- updated_at 自動更新（touch_updated_at は schema.sql で作成済み）
drop trigger if exists trg_store_settings_touch on public.store_settings;
create trigger trg_store_settings_touch
  before update on public.store_settings
  for each row execute function public.touch_updated_at();

-- RLS（既存テーブルと同じ A 案: anon に全許可）
alter table public.store_settings enable row level security;

drop policy if exists store_settings_anon_all on public.store_settings;
create policy store_settings_anon_all on public.store_settings
  for all to anon using (true) with check (true);
