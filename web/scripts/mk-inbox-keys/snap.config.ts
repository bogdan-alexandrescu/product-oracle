// MOCK-HOOK (whole file): mk-inbox-keys frame snapshots; serves the mock build like e2e does.
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: 'snap.spec.ts',
  timeout: 20 * 60_000,
  workers: 1,
  reporter: 'line',
  outputDir: process.env.TMPDIR + '/mk-snap-results',
  use: {
    baseURL: 'http://localhost:4310',
    launchOptions: { ignoreDefaultArgs: ['--hide-scrollbars'] },
    trace: 'off',
  },
});
