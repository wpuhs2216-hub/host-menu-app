-- GENTLY DIVA メニュー表アプリ Supabase スキーマ
-- 使い方: Supabase Dashboard → SQL Editor → このファイルの中身を全部貼って Run

-- ===== panels テーブル =====
create table if not exists public.panels (
  id text primary key,
  name text default '',
  ruby text default '',
  title text default '',
  label text default '',
  image_path text default '',
  image_version bigint default 0,
  img_x integer default 50,
  img_y integer default 50,
  img_scale integer default 100,
  "order" integer default 0,
  visible boolean default true,
  is_new_face boolean default false,
  selectable boolean default true,
  has_image boolean default false,
  updated_at timestamptz default now()
);

-- 既存DB向けマイグレーション: 画像バージョン列（画像差し替え検知用）
alter table public.panels add column if not exists image_version bigint default 0;

-- updated_at 自動更新
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists trg_panels_touch on public.panels;
create trigger trg_panels_touch
  before update on public.panels
  for each row execute function public.touch_updated_at();

-- ===== RLS（A 案: anon に全許可。2台限定運用前提）=====
alter table public.panels enable row level security;

drop policy if exists panels_anon_select on public.panels;
create policy panels_anon_select on public.panels
  for select to anon using (true);

drop policy if exists panels_anon_insert on public.panels;
create policy panels_anon_insert on public.panels
  for insert to anon with check (true);

drop policy if exists panels_anon_update on public.panels;
create policy panels_anon_update on public.panels
  for update to anon using (true) with check (true);

drop policy if exists panels_anon_delete on public.panels;
create policy panels_anon_delete on public.panels
  for delete to anon using (true);

-- ===== Realtime 有効化 =====
-- Supabase Dashboard → Database → Replication で panels を ON、または下記:
alter publication supabase_realtime add table public.panels;

-- ===== Storage バケット =====
-- 画像保存用バケット panel-images（public read）
insert into storage.buckets (id, name, public)
values ('panel-images', 'panel-images', true)
on conflict (id) do update set public = true;

-- ===== orders テーブル（注文履歴を全端末で共有） =====
create table if not exists public.orders (
  id text primary key,
  seat text default '',
  customer_name text default '',
  memo text default '',
  color text default 'yellow',
  casts jsonb default '[]'::jsonb,
  source text default 'main',         -- 'main' or 'preview'
  device_id text default '',
  device_name text default '',
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

drop trigger if exists trg_orders_touch on public.orders;
create trigger trg_orders_touch
  before update on public.orders
  for each row execute function public.touch_updated_at();

alter table public.orders enable row level security;

drop policy if exists orders_anon_all on public.orders;
create policy orders_anon_all on public.orders
  for all to anon using (true) with check (true);

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'orders'
  ) then
    execute 'alter publication supabase_realtime add table public.orders';
  end if;
end $$;

-- ===== selections テーブル（チェック中キャスト共有） =====
-- 1キャストに複数色を許す: PK は (panel_id, color) 複合
drop table if exists public.selections cascade;
create table public.selections (
  panel_id text not null,
  color text not null,
  updated_at timestamptz default now(),
  primary key (panel_id, color)
);

drop trigger if exists trg_selections_touch on public.selections;
create trigger trg_selections_touch
  before update on public.selections
  for each row execute function public.touch_updated_at();

alter table public.selections enable row level security;

drop policy if exists selections_anon_all on public.selections;
create policy selections_anon_all on public.selections
  for all to anon using (true) with check (true);

-- Realtime publication （存在しない場合のみ追加）
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'selections'
  ) then
    execute 'alter publication supabase_realtime add table public.selections';
  end if;
end $$;

-- バケット内オブジェクトに対する RLS（anon に全許可）
drop policy if exists panel_images_anon_select on storage.objects;
create policy panel_images_anon_select on storage.objects
  for select to anon using (bucket_id = 'panel-images');

drop policy if exists panel_images_anon_insert on storage.objects;
create policy panel_images_anon_insert on storage.objects
  for insert to anon with check (bucket_id = 'panel-images');

drop policy if exists panel_images_anon_update on storage.objects;
create policy panel_images_anon_update on storage.objects
  for update to anon using (bucket_id = 'panel-images') with check (bucket_id = 'panel-images');

drop policy if exists panel_images_anon_delete on storage.objects;
create policy panel_images_anon_delete on storage.objects
  for delete to anon using (bucket_id = 'panel-images');

-- ===== マルチ店舗対応（方式A: store_id 列。詳細は db/migration-multistore.sql）=====
-- 店舗マスタ（名前・パスワード）はアプリ側にハードコード（src/storeContext.js の STORES）。
-- DB はデータ分離用の store_id 列のみ持つ。
-- 各テーブルへ store_id（既存行は既定で gently-diva）
alter table public.panels     add column if not exists store_id text not null default 'gently-diva';
alter table public.orders     add column if not exists store_id text not null default 'gently-diva';
alter table public.selections add column if not exists store_id text not null default 'gently-diva';

create index if not exists idx_panels_store    on public.panels(store_id);
create index if not exists idx_orders_store     on public.orders(store_id);
create index if not exists idx_selections_store on public.selections(store_id);

-- Realtime が DELETE/UPDATE でも store_id でフィルタできるように全列を流す
alter table public.panels     replica identity full;
alter table public.orders     replica identity full;
alter table public.selections replica identity full;
