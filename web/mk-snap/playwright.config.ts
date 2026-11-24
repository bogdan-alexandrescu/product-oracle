// MOCK-HOOK: mk-undo snapshot runner (mock-ups only, never merged).
import { defineConfig } from '@playwright/test'; // MOCK-HOOK
export default defineConfig({ // MOCK-HOOK
  testDir: '.', // MOCK-HOOK
  timeout: 120_000, // MOCK-HOOK
  workers: 1, // MOCK-HOOK
  reporter: 'line', // MOCK-HOOK
  outputDir: process.env.TMPDIR + '/mk-results', // MOCK-HOOK
  use: { baseURL: 'http://localhost:4317', launchOptions: { args: ['--hide-scrollbars=false'], ignoreDefaultArgs: ['--hide-scrollbars'] }, trace: 'off' }, // MOCK-HOOK
}); // MOCK-HOOK
