// MOCK-HOOK: mk-runplan mock-up capture only (never merged): drives the running mock app on
// E2E_PORT and snapshots each frame; scrollbars shown.
import { defineConfig, devices } from "@playwright/test"; // MOCK-HOOK

export default defineConfig({ // MOCK-HOOK
  testDir: ".", // MOCK-HOOK
  testMatch: /.*\.mk\.ts$/, // MOCK-HOOK
  workers: 1, // MOCK-HOOK
  timeout: 90_000, // MOCK-HOOK
  reporter: "list", // MOCK-HOOK
  use: { baseURL: `http://localhost:${process.env.E2E_PORT ?? 3393}`, ...devices["Desktop Chrome"], launchOptions: { ignoreDefaultArgs: ["--hide-scrollbars"] } }, // MOCK-HOOK
}); // MOCK-HOOK
