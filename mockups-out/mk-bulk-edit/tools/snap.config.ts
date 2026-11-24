import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: '.',
  testMatch: 'snap.spec.ts',
  timeout: 1_200_000,
  workers: 1,
  reporter: 'line',
  outputDir: process.env.TMPDIR + '/mk-results',
  use: {
    baseURL: 'http://127.0.0.1:3393',
    launchOptions: { ignoreDefaultArgs: ['--hide-scrollbars'] },
    trace: 'off',
  },
});
