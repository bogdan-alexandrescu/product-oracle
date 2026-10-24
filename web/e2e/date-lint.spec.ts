import path from "node:path";

import { expect, test } from "./test";

/**
 * #447: `npm run lint` refuses a date shown outside lib/dates.ts (toLocaleString and its
 * kin, new Intl.DateTimeFormat), so no screen falls back to the browser's zone. Lints the
 * code as written; no browser.
 */

const WEB = path.resolve(__dirname, "..");

async function lint(code: string, file: string) {
  const { ESLint } = await import("eslint");
  const eslint = new ESLint({ cwd: WEB });
  const [result] = await eslint.lintText(code, { filePath: path.join(WEB, file) });
  return result.messages.filter((m) => m.ruleId === "no-restricted-syntax").map((m) => m.message);
}

// protects: the lint rule against browser-zone date display.
// fails_when: a toLocaleString/toLocaleDateString/toLocaleTimeString date or a new
// Intl.DateTimeFormat in display code passes lint, or numbers and lib/dates.ts are refused.
// no_claim: dates formatted some other way (string slicing).
test("lint refuses browser-zone date display outside lib/dates.ts", async () => {
  const refused = [
    "export const a = (iso: string) => new Date(iso).toLocaleString();",
    'export const a = (d: Date) => d.toLocaleString("en-US", { month: "short", day: "numeric" });',
    'export const a = (d: Date) => d.toLocaleDateString("en-GB");',
    "export const a = (d: Date) => d.toLocaleTimeString([], { hour: \"numeric\" });",
    'export const a = new Intl.DateTimeFormat("en-US", { month: "short" });',
  ];
  for (const code of refused) {
    const messages = await lint(code, "app/runs/_lint-probe.tsx");
    expect(messages, code).toHaveLength(1);
    expect(messages[0], code).toContain("lib/dates.ts");
  }
  // A number's thousands are not a date.
  expect(await lint('export const n = (v: number) => v.toLocaleString("en-US");', "app/runs/_lint-probe.tsx")).toEqual([]);
  // lib/dates.ts is the formatter, and the mock API stands in for the server.
  expect(await lint('export const a = new Intl.DateTimeFormat("en-US", { month: "short" });', "lib/dates.ts")).toEqual([]);
  expect(await lint("export const a = (iso: string) => new Date(iso).toLocaleString();", "lib/api/mock/_lint-probe.ts")).toEqual([]);
});
