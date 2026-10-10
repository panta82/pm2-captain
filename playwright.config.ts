import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: 'http://127.0.0.1:3214',
    viewport: { width: 1500, height: 900 },
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'bash tests/support/start-e2e-server.sh',
    url: 'http://127.0.0.1:3214/health',
    timeout: 30_000,
    reuseExistingServer: false,
  },
});
