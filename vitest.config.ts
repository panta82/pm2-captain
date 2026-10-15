import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // The same aliases as vite.config.mjs, for frontend modules that use them.
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src/frontend', import.meta.url)),
      '@shared': fileURLToPath(new URL('./src/shared', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.test.ts'],
    coverage: {
      reporter: ['text', 'html'],
    },
  },
});
