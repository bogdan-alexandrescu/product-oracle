// MOCK-HOOK: mk-undo snapshot runner (mock-ups only, never merged).
import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: '.',
  timeout: 120_000,
  workers: 1,
  reporter: 'line',
  outputDir: process.env.TMPDIR + '/mk-results',
  use: { baseURL: 'http://localhost:4317', launchOptions: { args: ['--hide-scrollbars=false'], ignoreDefaultArgs: ['--hide-scrollbars'] }, trace: 'off' },
});
