// MOCK-HOOK: snapshots the mock-up frames (mockups-out/), never part of the e2e suite.
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e-frames",
  workers: 1,
  timeout: 30 * 60_000,
  reporter: "list",
  use: {
    baseURL: `http://127.0.0.1:${process.env.E2E_PORT ?? 3393}`,
    // The owner's format: Chromium with its scrollbars shown.
    launchOptions: { ignoreDefaultArgs: ["--hide-scrollbars"] },
  },
});
