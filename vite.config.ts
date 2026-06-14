import { defineConfig } from 'vite';
import path from 'path';

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    host: true,
    proxy: {
      // Proxy WebSocket pelo Vite — sem abrir porta extra no firewall
      '/room': {
        target: 'ws://localhost:3001',
        ws: true,
      },
    },
  },
});
