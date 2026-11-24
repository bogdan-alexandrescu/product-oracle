// MOCK-HOOK: whole file. mk-palette mock-up frame capture (never merged). Serve dist on 4173 first.
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e-mk',
  workers: 1,
  timeout: 240_000,
  reporter: 'line',
  outputDir: process.env.TMPDIR + '/mk-test-results',
  use: {
    baseURL: 'http://localhost:4173',
    trace: 'off',
    launchOptions: { ignoreDefaultArgs: ['--hide-scrollbars'] },
  },
});
