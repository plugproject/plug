import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
  root: 'apps/playground',
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true },
});
