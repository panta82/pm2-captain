import { defineConfig } from '@playwright/test';

// Electron flows against the staged desktop app (`npm run build && npm run
// desktop:stage`), with simulated daemons, a temporary profile and a temporary
// config directory. Run under a display, for example `xvfb-run -a`.
export default defineConfig({
  testDir: '.',
  testMatch: '*.test.ts',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  use: { trace: 'retain-on-failure' },
});
