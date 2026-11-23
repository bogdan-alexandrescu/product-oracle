// MOCK-HOOK: mk-panel-edit mock-up capture (throwaway branch, never merged).
import { defineConfig } from '@playwright/test'; // MOCK-HOOK
export default defineConfig({ // MOCK-HOOK
  testDir: '.', // MOCK-HOOK
  testMatch: /.*\.cap\.ts/, // MOCK-HOOK
  workers: 1, // MOCK-HOOK
  timeout: 420_000, // MOCK-HOOK
  outputDir: process.env.TMPDIR + '/mk-results', // MOCK-HOOK
  reporter: 'list', // MOCK-HOOK
  use: { actionTimeout: 15_000, navigationTimeout: 20_000, baseURL: 'http://localhost:4173', launchOptions: { args: ['--hide-scrollbars=false'] }, ignoreDefaultArgs: ['--hide-scrollbars'] } as never, // MOCK-HOOK
}); // MOCK-HOOK
