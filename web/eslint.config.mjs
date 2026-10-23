import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      // Ask in the page (confirmInPage, components/ds): a browser dialog blocks the tab,
      // and browser automation with it (UI test finding E5, 2026-10-20).
      "no-alert": "error",
      "no-restricted-globals": ["error", "confirm", "alert", "prompt"],
      // #401: display dates and times are in the Company time zone, through lib/dates.ts;
      // only machine values sent to the API stay ISO/UTC.
      "no-restricted-syntax": [
        "error",
        {
          selector: "Property[key.name='timeZone'][value.value=/^(UTC|Etc\\/UTC|GMT)$/i]",
          message: "Show dates in the Company time zone: use lib/dates.ts, not timeZone \"UTC\".",
        },
      ],
    },
  },
  {
    // The shared formatter (plain calendar days) and the mock API (it stands in for the server).
    files: ["lib/dates.ts", "lib/api/mock/**"],
    rules: { "no-restricted-syntax": "off" },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Playwright builds (mock and real-stack) and output.
    ".next-mock/**",
    ".next-e2e/**",
    ".next-local/**",
    ".next-check/**",
    "test-results/**",
    "playwright-report/**",
  ]),
]);

export default eslintConfig;
