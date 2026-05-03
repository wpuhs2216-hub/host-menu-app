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

export default defineConfig({
  base: isPages ? '/host-menu-app/' : '/',
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  build: {
    rollupOptions: {
      input: {
        main: 'index.html',
        admin: 'admin.html',
      },
    },
  },
  server: {
    host: '0.0.0.0',
    port: 3000,
  },
});
