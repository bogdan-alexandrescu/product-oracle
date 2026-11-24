// MOCK-HOOK: whole file. Captures the mk-mentions mock-up frames from the mock app on MK_BASE.
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: 'capture.spec.ts',
  timeout: 20 * 60_000,
  workers: 1,
  reporter: 'line',
  outputDir: `${process.env.TMPDIR ?? '.'}/mk-test-results`,
  use: {
    baseURL: process.env.MK_BASE ?? 'http://127.0.0.1:3393',
    trace: 'off',
    launchOptions: { ignoreDefaultArgs: ['--hide-scrollbars'] },
  },
});
