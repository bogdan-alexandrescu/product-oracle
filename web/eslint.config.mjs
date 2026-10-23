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
        // #447: nor in the browser's zone. A number's toLocaleString("en-US") stays allowed.
        {
          selector: "CallExpression[callee.property.name=/^toLocale(Date|Time)String$/]",
          message: "Show dates in the Company time zone: use lib/dates.ts or lib/format.ts, not toLocaleDateString/toLocaleTimeString.",
        },
        {
          selector:
            "CallExpression[callee.property.name='toLocaleString']:matches([arguments.length=0], [callee.object.type='NewExpression'], :has(Property[key.name=/^(year|month|day|weekday|hour|minute|second|dateStyle|timeStyle|timeZone|timeZoneName)$/]))",
          message: "Show dates in the Company time zone: use lib/dates.ts or lib/format.ts, not toLocaleString.",
        },
        {
          selector: ":matches(NewExpression, CallExpression)[callee.object.name='Intl'][callee.property.name='DateTimeFormat']",
          message: "Show dates in the Company time zone: use lib/dates.ts or lib/format.ts, not new Intl.DateTimeFormat.",
        },
      ],
    },
  },
  {
    // The shared formatter, the mock API (it stands in for the server) and the tests (they
    // work out the strings a screen should show).
    files: ["lib/dates.ts", "lib/api/mock/**", "e2e/**"],
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
