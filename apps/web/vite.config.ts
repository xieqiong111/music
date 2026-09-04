import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 4320,
    proxy: {
      '/api': 'http://127.0.0.1:4319',
      '/healthz': 'http://127.0.0.1:4319',
    },
  },
  test: {
    environment: 'jsdom',
    css: false,
  },
});
