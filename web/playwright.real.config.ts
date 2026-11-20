import { defineConfig, devices } from '@playwright/test';

import {
  API_PORT,
  API_URL,
  DATABASE_URL,
  FAKE_CLAUDE_PORT,
  STATE_FILE,
  WEB_PORT,
} from './e2e/real/stack';

/**
 * End-to-end against the real stack: the API (uvicorn) on a fresh database and a
 * production build of the web app, served by nginx, proxying /v1 to it. Needs a running Postgres 16
 * (e.g. `docker compose up -d postgres`); the E2E database is dropped and recreated
 * on every run. Run with `make e2e`.
 */
export default defineConfig({
  testDir: './e2e/real',
  outputDir: './test-results/real',
  workers: 1,
  forbidOnly: !!process.env.CI,
  timeout: 120_000,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://localhost:${WEB_PORT}`,
    viewport: { width: 1366, height: 820 },
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1366, height: 820 } },
    },
  ],
  webServer: [
    {
      command: 'sh e2e/real/start-api.sh',
      url: `${API_URL}/healthz`,
      env: {
        ORACLE_DATABASE_URL: DATABASE_URL,
        E2E_STATE_FILE: STATE_FILE,
        E2E_API_PORT: String(API_PORT),
        // The test build: the seeded admin is admin@example.com, a reserved example domain.
        ORACLE_ALLOW_RESERVED_EMAIL_DOMAINS: '1',
        // Oracle's model in discussion-stream.spec.ts: a fake Messages API the spec starts.
        ORACLE_ANTHROPIC_API_URL: `http://127.0.0.1:${FAKE_CLAUDE_PORT}`,
        // Agent runs (slice.spec.ts) on the deterministic FakeRuntime, never SwarmCloud.
        ORACLE_RUNTIME: 'fake',
      },
      timeout: 120_000,
      reuseExistingServer: false,
      stdout: 'pipe',
    },
    {
      // The production build (dist-e2e) behind nginx with the image's config, /v1 to the E2E API.
      command: 'sh e2e/real/start-web.sh',
      url: `http://localhost:${WEB_PORT}/login`,
      env: { E2E_API_URL: API_URL, E2E_WEB_PORT: String(WEB_PORT) },
      timeout: 240_000,
      reuseExistingServer: false,
    },
  ],
});
