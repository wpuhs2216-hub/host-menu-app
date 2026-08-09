-- パネル（キャスト）1件に複数画像を持たせるための追加カラム
-- extra_images: [{ "key": "<id>__<uid>", "v": <version> }] の配列。
-- メイン画像は従来どおり image_path=<id>.jpg（storage）／IndexedDB キー=id で据え置き。
-- 追加画像は storage <key>.jpg／IndexedDB キー=key に保存する。
alter table public.panels
  add column if not exists extra_images jsonb not null default '[]'::jsonb;
