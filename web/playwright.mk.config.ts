// MOCK-HOOK: mk-roadmap-edit only (never merged): captures the mock-up frames from the running mock
// build (npm run start:mock -- --port 4173). Run: npx playwright test -c playwright.mk.config.ts
import { defineConfig } from '@playwright/test'; // MOCK-HOOK

export default defineConfig({ // MOCK-HOOK
  testDir: './e2e', // MOCK-HOOK
  testMatch: /mk-roadmap-edit\.capture\.ts/, // MOCK-HOOK
  timeout: 1_200_000, // MOCK-HOOK
  workers: 1, // MOCK-HOOK
  use: { baseURL: 'http://localhost:4173', launchOptions: { args: ['--hide-scrollbars=false'], ignoreDefaultArgs: ['--hide-scrollbars'] } }, // MOCK-HOOK
}); // MOCK-HOOK
