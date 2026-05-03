import { defineConfig } from 'vite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf-8'));

// GitHub Pages 用に base を切り替える
// - Capacitor Android (cap:build): base = '/'
// - GitHub Pages (BUILD_TARGET=pages): base = '/host-menu-app/'
const isPages = process.env.BUILD_TARGET === 'pages';

// Pages 用: ルートにアクセスされたら admin.html に即リダイレクトする最小 index.html を出力
function pagesRedirectIndexPlugin() {
  return {
    name: 'pages-redirect-index',
    apply: 'build',
    generateBundle() {
      if (!isPages) return;
      const html = `<!doctype html>
<html lang="ja">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>GENTLY DIVA Admin</title>
<meta http-equiv="refresh" content="0; url=./admin.html" />
<script>location.replace('./admin.html');</script>
<style>body{background:#0a0a0a;color:#888;font-family:sans-serif;text-align:center;padding-top:40vh;}</style>
</head>
<body>
<a href="./admin.html" style="color:#d4af37">管理画面へ移動</a>
</body>
</html>
`;
      this.emitFile({ type: 'asset', fileName: 'index.html', source: html });
    },
  };
}

export default defineConfig({
  base: isPages ? '/host-menu-app/' : '/',
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  plugins: [pagesRedirectIndexPlugin()],
  build: {
    rollupOptions: {
      // Pages では admin / preview / history をビルド
      // index.html はリダイレクト用 HTML をプラグインで上書き出力
      input: isPages
        ? { admin: 'admin.html', preview: 'preview.html', history: 'history.html' }
        : { main: 'index.html', admin: 'admin.html' },
    },
  },
  server: {
    host: '0.0.0.0',
    port: 3000,
  },
});
