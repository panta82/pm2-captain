import { defineConfig } from '@playwright/test';

const REAL_URL = 'http://127.0.0.1:3214';
const FAKE_URL = 'http://127.0.0.1:3215';

// GitHub's runners are slower than a developer machine and nobody watches them run.
const isCI = Boolean(process.env.CI);

export default defineConfig({
  testDir: './tests/e2e',
  timeout: isCI ? 60_000 : 30_000,
  fullyParallel: false,
  workers: 1,
  // A leftover test.only would silently skip the rest of the suite.
  forbidOnly: isCI,
  retries: isCI ? 1 : 0,
  reporter: isCI ? [['github'], ['list']] : 'list',
  use: {
    viewport: { width: 1500, height: 900 },
    trace: 'retain-on-failure',
  },
  projects: [
    // Against a temporary PM2 daemon: proves the real PM2, log file and launch paths.
    { name: 'real', testMatch: 'captain.test.ts', use: { baseURL: REAL_URL } },
    // Against Captain in fake mode: UI states that tests set up with fake commands.
    { name: 'fake', testMatch: /fake.*\.test\.ts$/, use: { baseURL: FAKE_URL } },
  ],
  webServer: [
    {
      command: 'bash tests/support/start-e2e-server.sh',
      url: `${REAL_URL}/health`,
      timeout: isCI ? 60_000 : 30_000,
      reuseExistingServer: false,
    },
    {
      command: 'bash tests/support/start-fake-e2e-server.sh',
      url: `${FAKE_URL}/health`,
      timeout: isCI ? 60_000 : 30_000,
      reuseExistingServer: false,
    },
  ],
});
