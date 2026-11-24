// MOCK-HOOK: mk-predicted mock-up frames only (never run in CI); serves nothing, reads the running mock app.
import { defineConfig } from '@playwright/test'; // MOCK-HOOK
export default defineConfig({ // MOCK-HOOK
  testDir: './e2e-mk', // MOCK-HOOK
  testMatch: /.*\.mk\.ts/, // MOCK-HOOK
  outputDir: `${process.env.TMPDIR}/mk-results`, // MOCK-HOOK
  workers: 1, // MOCK-HOOK
  timeout: 540_000, // MOCK-HOOK
  reporter: 'list', // MOCK-HOOK
  use: { actionTimeout: 15_000, baseURL: 'http://localhost:3100', launchOptions: { ignoreDefaultArgs: ['--hide-scrollbars'] } }, // MOCK-HOOK
}); // MOCK-HOOK
