import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5182,
    // 한 글자 접두사는 정규식으로 못박아야 한다 — '/s' 로 두면 vite 가
    // /src/main.tsx 까지 백엔드로 넘겨 개발 서버가 통째로 안 뜬다.
    proxy: Object.fromEntries(
      ['api', 't', 'u', 'p', 'w', 's', 'c', 'a'].map((p) => [`^/${p}/`, 'http://localhost:9200'])
    ),
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
