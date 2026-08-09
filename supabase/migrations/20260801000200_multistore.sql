-- ============================================================
-- マルチ店舗対応マイグレーション（方式A: 1プロジェクト + store_id 列）
-- 実行タイミング: 営業終了後（このSQLは非破壊。既存行は全て store_id='gently-diva' になる）
-- 使い方: Supabase Dashboard → SQL Editor に貼って Run
--
-- 手順全体:
--   ① このSQLを実行（列追加・stores作成。既存タブレットは無影響）
--   ② 新バージョンのアプリをリリースし、GENTLY DIVA の全タブレットを更新
--   ③ 全台更新を確認してから、下部の「2店舗目の追加」を実行
-- ============================================================

-- ※店舗マスタ（名前・パスワード）はアプリ側にハードコード（src/storeContext.js の STORES）。
--   DB には店舗テーブルを持たず、データ分離用の store_id 列だけ追加する。

-- ===== 1. 各テーブルに store_id 列を追加（default で既存行は gently-diva）=====
alter table public.panels     add column if not exists store_id text not null default 'gently-diva';
alter table public.orders     add column if not exists store_id text not null default 'gently-diva';
alter table public.selections add column if not exists store_id text not null default 'gently-diva';

-- push_subscriptions は存在する場合のみ
do $$
begin
  if exists (select 1 from information_schema.tables
             where table_schema='public' and table_name='push_subscriptions') then
    execute 'alter table public.push_subscriptions add column if not exists store_id text not null default ''gently-diva''';
  end if;
end $$;

-- ===== 2. store_id での絞り込み用インデックス =====
create index if not exists idx_panels_store     on public.panels(store_id);
create index if not exists idx_orders_store      on public.orders(store_id);
create index if not exists idx_selections_store  on public.selections(store_id);

-- ===== 3. Realtime が DELETE/UPDATE でも store_id でフィルタできるように =====
-- 既定の REPLICA IDENTITY は主キーのみ。store_id は主キーに含まれないため、
-- DELETE 時の old レコードに store_id が乗らずフィルタが効かない。FULL にして全列を流す。
alter table public.panels     replica identity full;
alter table public.orders     replica identity full;
alter table public.selections replica identity full;

-- ============================================================
-- 【③ 2店舗目の追加】※①②完了後
-- ============================================================
-- 店舗の追加は DB ではなくアプリ側で行う:
--   1) src/storeContext.js の STORES に { id:'store-2', name:'2号店', password:'XXXX' } を追記
--   2) 新バージョンをビルドして 2号店のタブレットに配布
--   3) 2号店タブレットの起動時パスワード画面で、その店舗のパスワードを入力
-- DB 側は既存の store_id 列にその id（'store-2'）が入るだけで、追加作業は不要。
