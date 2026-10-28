import { defineConfig } from 'vite';

export default defineConfig({
  base: '/partner/',
  server: {
    host: '127.0.0.1',
    port: 4178,
    strictPort: true,
    proxy: { '/api': { target: 'http://127.0.0.1:8787', changeOrigin: true } }
  }
});
