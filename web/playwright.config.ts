import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.E2E_PORT ?? 3100);

/**
 * Runs against a production build in mock mode (NEXT_PUBLIC_API_MOCKS=1), built into
 * .next-mock so it never clobbers the real build. Each test gets a fresh browser
 * context, hence freshly seeded mock data.
 */
export default defineConfig({
  testDir: "./e2e",
  // e2e/real runs against the real stack: playwright.real.config.ts (`make e2e`).
  testIgnore: "real/**",
  fullyParallel: true,
  workers: process.env.CI ? 2 : undefined,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: `http://localhost:${PORT}`,
    viewport: { width: 1366, height: 820 },
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1366, height: 820 } } }],
  webServer: {
    command: `npm run build:mock && npm run start:mock -- -p ${PORT}`,
    url: `http://localhost:${PORT}/login`,
    timeout: 180_000,
    reuseExistingServer: !process.env.CI,
  },
});
