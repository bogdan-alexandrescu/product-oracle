// MOCK-HOOK (GM1 mock-ups, never merged): captures the goal map frames from the running mock app.
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "capture.spec.ts",
  timeout: 600_000,
  workers: 1,
  reporter: "line",
  use: { baseURL: `http://localhost:${process.env.E2E_PORT ?? 3393}`, launchOptions: { ignoreDefaultArgs: ["--hide-scrollbars"] } },
});
