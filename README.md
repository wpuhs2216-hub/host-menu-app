# GENTLY DIVA メニュー表アプリ

ホストクラブ「GENTLY DIVA」店内タブレット用メニュー表アプリ（Capacitor Android）。

## 構成
- Vanilla JS + Vite + Capacitor Android
- データはローカル保存（localStorage + IndexedDB）。サーバー通信なし
- アプリ内の「アップデート確認」から GitHub Releases の最新版を取得可能

## 開発
```bash
npm install
npm run dev          # Vite dev server
npm run cap:build    # Vite build + cap sync
cd android && ./gradlew assembleDebug
```

## リリース
1. `package.json` の `version` と `android/app/build.gradle` の `versionCode`/`versionName` を上げる
2. `git tag v<バージョン> && git push --tags`
3. GitHub Actions が APK をビルドして Releases に添付
