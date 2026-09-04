import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5182,
    proxy: {
      '/api': 'http://localhost:9200',
      '/t': 'http://localhost:9200',
      '/u': 'http://localhost:9200',
      '/p': 'http://localhost:9200',
      '/w': 'http://localhost:9200',
      '/s': 'http://localhost:9200',
      '/c': 'http://localhost:9200',
    },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
