import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const rootDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: path.join(rootDir, 'src/frontend'),
  publicDir: path.join(rootDir, 'src/frontend/public'),
  plugins: [react(), tailwindcss()],
  build: {
    emptyOutDir: true,
    outDir: path.join(rootDir, 'dist/frontend'),
  },
  resolve: {
    alias: {
      '@': path.resolve(rootDir, 'src/frontend'),
      '@shared': path.resolve(rootDir, 'src/shared'),
    },
  },
  envPrefix: 'PUBLIC_',
  envDir: rootDir,
});
