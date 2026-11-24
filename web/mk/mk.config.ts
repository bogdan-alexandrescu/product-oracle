// MOCK-HOOK (whole file): snapshots the mk-linked-pr mock-up frames; local only, never merged.
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  workers: 1,
  timeout: 240_000,
  reporter: 'line',
  outputDir: `${process.env.TMPDIR ?? '.'}/mk-test-results`,
  use: {
    baseURL: 'http://localhost:3100',
    trace: 'off',
    // The owner's format: scrollbars shown.
    launchOptions: { ignoreDefaultArgs: ['--hide-scrollbars'] },
  },
  webServer: {
    command: 'npm run start:mock -- --port 3100',
    url: 'http://localhost:3100/login',
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
