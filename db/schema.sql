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
