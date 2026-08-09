# ローカルテスト環境（本番 Supabase を触らずに開発する）

WSL 内に Supabase 一式（Postgres / REST / Storage / Realtime / Studio）を Docker で立てて、
本番データに一切触れずに動作確認できる環境。新機能のスキーマ変更もここで先に試す。

## 前提
- Docker Desktop（Windows）が起動していること。WSL 統合が有効なら WSL 内で `docker` が使える
- Supabase CLI: `~/.local/bin/supabase`（PATH に通す: `export PATH="$HOME/.local/bin:$PATH"`）

## 起動 / 停止

```bash
cd ~/dev/biz-apps/host-menu-app
supabase start          # 初回はイメージ取得で数分。2回目以降は数十秒
supabase status         # URL と各種キーを表示
supabase stop           # 使い終わったら停止（データは保持される）
supabase stop --no-backup   # データも破棄して完全にリセットしたい時
```

| 用途 | URL |
|---|---|
| API（REST / Storage / Realtime） | http://127.0.0.1:54321 |
| Postgres 直結 | postgresql://postgres:postgres@127.0.0.1:54322/postgres |
| Studio（GUI・テーブル閲覧/編集） | http://127.0.0.1:54323 |
| 送信メール確認（Mailpit） | http://127.0.0.1:54324 |

ローカルの anon キーは全開発者共通の固定デモキー（`supabase status` で確認）。秘密ではない。

## アプリをローカル DB に向ける

`.env.local`（git 管理外）があるとその接続先を使い、無ければ本番を見る。

```bash
# ローカルを見る
cp .env.local.example .env.local   # または supabase status の値を書く
npm run dev                        # http://127.0.0.1:5173

# 本番に戻す
mv .env.local .env.local.off
```

判定は `src/supabaseClient.js` の `import.meta.env.VITE_SUPABASE_URL` で行っている。
**ビルド時に焼き込まれる**ので、`.env.local` を置いたまま `npm run cap:build` すると
ローカル DB を見る APK ができてしまう。リリースビルド前に必ず外すこと。

## スキーマの管理

`supabase/migrations/*.sql` が起動時に順に適用される。`db/*.sql`（本番へ手で流してきた SQL）を
同じ順序で並べたもの。新しいスキーマ変更はここに 1 ファイル足して試し、
固まってから本番の SQL Editor に流す。

```bash
supabase db reset   # 全 migration を流し直し + seed 再投入（ローカルのデータは消える）
```

`supabase/seed.sql` はテスト用の初期データ。`panel-images` バケット作成、3 店舗分の店舗設定、
ダミーパネル数件を入れている。個人情報を含む本番データはここに書かない。

## 注意

- `20260801000700_local_grants.sql` は anon ロールへの GRANT。本番では Supabase が自動付与するため
  実質不要だが、ローカルでは無いと `permission denied` になるので入れてある（本番に流しても無害）
- Docker Desktop は常駐でメモリを食うので、使わない時は `supabase stop` してから Docker Desktop も終了する
- 実機（Android タブレット）からローカル DB を見たい場合は、`127.0.0.1` ではなく PC の LAN IP を
  `.env.local` に書き、Windows のファイアウォールで 54321 を開ける必要がある
