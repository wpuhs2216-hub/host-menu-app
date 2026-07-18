-- 店舗ごとのフォント（源氏名・役職の書体）設定。空文字=デフォルト。
-- 値は src/storeSettings.js の FONT_OPTIONS の id（例: shippori-mincho）。
alter table public.store_settings
  add column if not exists ui_font text not null default '';
