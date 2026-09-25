-- メニュー分け（料金システム / ALLCAST / 役職メニュー）と、設定の二段構え
-- 2026-09-25
--
-- 足すだけの引っ越し。既にあるデータは書き換えない。
-- 既定値のおかげで、古い版のアプリから来た書き込みもそのまま通る。

-- 札に「役職メニューに出す」の印を足す（既定は付いていない）
alter table public.panels
  add column if not exists is_officer boolean not null default false;

-- 店ごとの既定設定を入れる棚を足す（台ごとの上書きが無い時に効く）
-- 例: {"menuSplit": true, "hideCheckbox": false}
alter table public.store_settings
  add column if not exists device_defaults jsonb not null default '{}'::jsonb;
