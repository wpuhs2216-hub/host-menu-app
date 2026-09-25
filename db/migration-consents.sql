-- ============================================================
-- デジタル署名（ご新規様同意書）
-- 既存テーブル（panels / orders / selections / store_settings）には一切変更を加えない。
-- 使い方: Supabase Dashboard → SQL Editor に貼って Run（非破壊・新規テーブルとバケットの追加のみ）
-- 新規テーブルとバケットを足すだけなので、途中で止めても既存機能は無傷。
-- ============================================================

-- @ハジメル 同意書: ご新規様の手書き署名と記入内容。追記だけで消さない（個人情報あり） #重要
create table if not exists public.consents (
  id text primary key,
  store_id text not null,

  -- 同意内容
  route smallint,                                  -- 来店経路 1:路上での声掛け 2:案内所からの案内 3:その他/自らの意思
  id_checked boolean not null default false,       -- 身分証確認 済/未
  customer_name text default '',                   -- 署名の読み（任意のテキスト入力）

  -- 署名・書類の実体（storage: consent-images）
  signature_path text default '',                  -- 署名だけの透過PNG
  document_path text default '',                   -- 書類全体を焼いた画像

  -- 「何に同意したか」を後から再現するためのスナップショット
  doc_version text not null default '',
  doc_text text not null default '',

  -- 由来と改ざん検知
  device_name text default '',
  device_id text default '',
  hash text default '',                            -- doc_text + 署名 + 日時 の SHA-256

  is_test boolean not null default false,          -- テストモードで作られた行

  signed_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index if not exists idx_consents_store on public.consents (store_id, signed_at desc);

-- ===== RLS =====
-- 同意書は「追記専用」。anon からの UPDATE / DELETE はポリシーを作らないことで禁止する。
-- （テーブル所有者や service_role は従来どおり操作できる）
alter table public.consents enable row level security;

drop policy if exists consents_anon_select on public.consents;
create policy consents_anon_select on public.consents
  for select to anon using (true);

drop policy if exists consents_anon_insert on public.consents;
create policy consents_anon_insert on public.consents
  for insert to anon with check (true);

-- ポリシー未作成だけだと UPDATE/DELETE は「0 行変更」で 204 が返り、
-- クライアントからは成功と区別が付かない。権限自体を剥がして明確に拒否する。
revoke update, delete, truncate on public.consents from anon;
revoke update, delete, truncate on public.consents from authenticated;

-- ===== 署名画像バケット =====
insert into storage.buckets (id, name, public)
values ('consent-images', 'consent-images', true)
on conflict (id) do nothing;

drop policy if exists consent_images_anon_read on storage.objects;
create policy consent_images_anon_read on storage.objects
  for select to anon using (bucket_id = 'consent-images');

drop policy if exists consent_images_anon_write on storage.objects;
create policy consent_images_anon_write on storage.objects
  for insert to anon with check (bucket_id = 'consent-images');
