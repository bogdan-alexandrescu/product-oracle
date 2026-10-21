import { defineConfig, devices } from "@playwright/test";

import { API_PORT, API_URL, DATABASE_URL, STATE_FILE, WEB_PORT } from "./e2e/real/stack";

/**
 * End-to-end against the real stack: the API (uvicorn) on a fresh database and a
 * production build of the web app proxying /v1 to it. Needs a running Postgres 16
 * (e.g. `docker compose up -d postgres`); the E2E database is dropped and recreated
 * on every run. Run with `make e2e`.
 */
export default defineConfig({
  testDir: "./e2e/real",
  outputDir: "./test-results/real",
  workers: 1,
  forbidOnly: !!process.env.CI,
  timeout: 120_000,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: `http://localhost:${WEB_PORT}`,
    viewport: { width: 1366, height: 820 },
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1366, height: 820 } } }],
  webServer: [
    {
      command: "sh e2e/real/start-api.sh",
      url: `${API_URL}/healthz`,
      env: {
        ORACLE_DATABASE_URL: DATABASE_URL,
        E2E_STATE_FILE: STATE_FILE,
        E2E_API_PORT: String(API_PORT),
        // The test build: the seeded admin is admin@example.com, a reserved example domain.
        ORACLE_ALLOW_RESERVED_EMAIL_DOMAINS: "1",
      },
      timeout: 120_000,
      reuseExistingServer: false,
      stdout: "pipe",
    },
    {
      // Rewrites are resolved at build time, so this build points at the E2E API.
      command: `next build && next start -p ${WEB_PORT}`,
      url: `http://localhost:${WEB_PORT}/login`,
      env: { API_INTERNAL_URL: API_URL, NEXT_DIST_DIR: ".next-e2e" },
      timeout: 240_000,
      reuseExistingServer: false,
    },
  ],
});
