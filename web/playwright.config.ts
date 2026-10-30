import { defineConfig, devices, type ReporterDescription } from "@playwright/test";

const PORT = Number(process.env.E2E_PORT ?? 3100);

// E2E_WORKERS takes a count or a percentage of cores ("50%"); E2E_RETRIES a count.
const envWorkers = process.env.E2E_WORKERS;
const WORKERS = envWorkers ? (envWorkers.endsWith("%") ? envWorkers : Number(envWorkers)) : process.env.CI ? 2 : undefined;
const RETRIES = process.env.E2E_RETRIES ? Number(process.env.E2E_RETRIES) : process.env.CI ? 1 : 0;

// A --reporter on the command line replaces this list. E2E_BLOB=1 adds a blob report
// (blob-report/) for sharded runs whose blobs are merged with `playwright merge-reports`.
const CI_REPORTERS: ReporterDescription[] = [["list"], ["html", { open: "never" }]];
if (process.env.E2E_BLOB === "1") CI_REPORTERS.push(["blob"]);

/**
 * Runs against a production build in mock mode (NEXT_PUBLIC_API_MOCKS=1), built into
 * .next-mock so it never clobbers the real build. Each test gets a fresh browser
 * context, hence freshly seeded mock data.
 */
export default defineConfig({
  testDir: "./e2e",
  // e2e/real runs against the real stack: playwright.real.config.ts (`make e2e`).
  testIgnore: "real/**",
  // Timing specs (tagged @timing, as the API's pytest `timing` mark) assert wall-clock
  // budgets: the default run skips them; E2E_TIMING=1 runs them, alone, after it
  // (`E2E_TIMING=1 npx playwright test --grep @timing --workers=1`).
  grepInvert: process.env.E2E_TIMING === "1" ? undefined : /@timing/,
  fullyParallel: true,
  workers: WORKERS,
  forbidOnly: !!process.env.CI,
  retries: RETRIES,
  reporter: process.env.CI ? CI_REPORTERS : "list",
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
