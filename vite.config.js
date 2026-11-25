import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import tailwindcss from '@tailwindcss/vite';
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
let commit = 'dev';
try {
  commit = execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
    .toString()
    .trim();
} catch {
  /* not a git checkout */
}

export default defineConfig({
  plugins: [vue(), tailwindcss()],
  define: { __APP_VERSION__: JSON.stringify(`${pkg.version} (${commit})`) },
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:8787',
      '/auth': 'http://127.0.0.1:8787',
      '/mcp': 'http://127.0.0.1:8787',
      '/oauth': 'http://127.0.0.1:8787',
      '/.well-known': 'http://127.0.0.1:8787',
    },
  },
  test: {
    include: ['test/**/*.test.js'],
    // Each test file migrates a fresh in-memory database and some tests make dozens of requests. With every
    // file running in parallel the default 5 s timed out on busy machines (passing when run alone).
    testTimeout: 20000,
  },
});
