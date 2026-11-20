import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

// #401: display dates and times are in the Company time zone, through lib/dates.ts;
// only machine values sent to the API stay ISO/UTC.
const DATE_RULES = [
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
  // #1588: nor today from an ISO string: its day is UTC's, the wrong day near midnight.
  {
    selector:
      "CallExpression[callee.property.name=/^(slice|substring|substr|split)$/][callee.object.type='CallExpression'][callee.object.callee.property.name='toISOString']",
    message: "Today is the Company's day: use todayIn(zone) from lib/dates.ts; for arithmetic on days, utcDay or addDays.",
  },
];

// #1591: roles in the web go through can() or an item's own can_* field, never the signed-in
// person's role name (another member's role, as on Settings › Members, stays readable).
const ROLE_MESSAGE = "Gate on can() or the item's own can_* field, not on the signed-in person's role name.";
const ROLE_RULES = [
  {
    selector:
      "BinaryExpression[operator=/^[!=]==?$/]:matches([left.property.name='role'][left.object.name=/^(me|caps|current|session|user|principal)$/], [left.expression.property.name='role'][left.expression.object.name=/^(me|caps|current|session|user|principal)$/], [left.property.name='role'][left.object.expression.name=/^(me|caps|current|session|user|principal)$/], [right.property.name='role'][right.object.name=/^(me|caps|current|session|user|principal)$/], [right.expression.property.name='role'][right.expression.object.name=/^(me|caps|current|session|user|principal)$/], [right.property.name='role'][right.object.expression.name=/^(me|caps|current|session|user|principal)$/])",
    message: ROLE_MESSAGE,
  },
  {
    selector:
      "BinaryExpression[operator=/^[!=]==?$/]:matches([left.type='Identifier'][left.name='role'][right.value=/^(owner|approver|commenter|viewer)$/], [right.type='Identifier'][right.name='role'][left.value=/^(owner|approver|commenter|viewer)$/])",
    message: ROLE_MESSAGE,
  },
];

// #1579: links and navigation come from lib/nav.ts only, so a move off Next changes one file.
// A lane that brings in a next/* import runs `node scripts/nav-codemod.mjs` to re-point it.
const NAV_RULE = [
  "error",
  {
    paths: ["next/link", "next/navigation"].map((name) => ({
      name,
      message: "Import links and navigation from @/lib/nav (node scripts/nav-codemod.mjs re-points them).",
    })),
  },
];

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      // Ask in the page (confirmInPage, components/ds): a browser dialog blocks the tab,
      // and browser automation with it (UI test finding E5, 2026-10-20).
      "no-alert": "error",
      "no-restricted-globals": ["error", "confirm", "alert", "prompt"],
      "no-restricted-syntax": ["error", ...DATE_RULES],
      "no-restricted-imports": NAV_RULE,
    },
  },
  {
    files: ["lib/nav.ts"],
    rules: { "no-restricted-imports": "off" },
  },
  {
    files: ["app/**", "components/**"],
    rules: { "no-restricted-syntax": ["error", ...DATE_RULES, ...ROLE_RULES] },
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
