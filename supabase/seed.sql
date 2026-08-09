-- ローカル開発環境の初期データ（本番には流さない）
-- supabase start / supabase db reset のたびに自動で実行される

-- パネル画像バケット（本番と同名・公開バケット）
insert into storage.buckets (id, name, public)
values ('panel-images', 'panel-images', true)
on conflict (id) do update set public = true;

-- バケットへの anon 全許可（本番の運用に合わせる）
drop policy if exists panel_images_anon_all on storage.objects;
create policy panel_images_anon_all on storage.objects
  for all to anon using (bucket_id = 'panel-images') with check (bucket_id = 'panel-images');

-- 店舗設定（本番の3店舗と同じ store_id を用意しておく）
insert into public.store_settings (store_id, seat_options, color_labels, ui_font) values
  ('gently-diva',
   '["A","B-1","B-2","C-1","C-2","D","E-1","E-2","E-3"]'::jsonb,
   '{"yellow":"壁側","red":"通路側","blue":"","green":""}'::jsonb,
   'zen-old-mincho'),
  ('dears-lucia',
   '["A-1","A-2","A-3","B-1","B-2","C-1","D","V-1"]'::jsonb,
   '{"yellow":"左側","red":"真ん中","blue":"右側","green":""}'::jsonb,
   ''),
  ('dears-bachelor',
   '["A","B-1","B-2","C-1","C-2","D"]'::jsonb,
   '{"yellow":"壁側","red":"通路側","blue":"","green":""}'::jsonb,
   '')
on conflict (store_id) do nothing;

-- テスト用パネル（画像なし。表示・並べ替え・同期の確認用）
insert into public.panels (id, store_id, name, title, "order", visible, selectable, has_image) values
  ('test-1', 'dears-bachelor', 'テスト太郎', '代表',   0, true, true, false),
  ('test-2', 'dears-bachelor', 'テスト次郎', '幹部',   1, true, true, false),
  ('test-3', 'dears-bachelor', 'テスト三郎', '',       2, true, true, false),
  ('test-4', 'gently-diva',    'ダミー花子', '',       0, true, true, false)
on conflict (id) do nothing;
