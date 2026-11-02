import base from "../../playwright.config";
import { defineConfig } from "@playwright/test";

// Visual QA captures only (never in the default run): npx playwright test -c e2e/vqa/vqa.config.ts
export default defineConfig({ ...base, testDir: ".", testMatch: /\.vqa\.ts$/, testIgnore: [], retries: 0 });
