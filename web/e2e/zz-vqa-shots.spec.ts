import type { Page } from "@playwright/test";
import { THEME_KEY } from "../lib/theme";
import { login } from "./helpers";
import { expect, test } from "./test";

const OUT = process.env.SHOTS_DIR!;
type Shot = { name: string; email?: string; scenario?: string; fail?: string; url: string; ready: (p: Page) => Promise<void> };
const SHOTS: Shot[] = [
  { name: "st1-sources-viewer", email: "viewer@example.com", url: "/settings/sources", ready: (p) => expect(p.getByRole("list", { name: "My sources" })).toBeVisible() },
  { name: "st5-api-tokens", url: "/settings/api-tokens", ready: (p) => expect(p.getByTestId("token-row").first()).toBeVisible() },
  { name: "st6-analytics-commenter", email: "commenter@example.com", url: "/settings/analytics", ready: (p) => expect(p.getByTestId("settings-nav")).toBeVisible() },
  { name: "st7-analytics-owner", url: "/settings/analytics", ready: (p) => expect(p.getByRole("button", { name: "About analytics" })).toBeVisible() },
  { name: "st7-sources-owner", url: "/settings/sources#source-legacy", ready: async (p) => { const r = p.getByRole("listitem", { name: "Legacy all-hands chat" }); await r.scrollIntoViewIfNeeded(); await expect(r).toBeVisible(); } },
  { name: "st7-code-map", url: "/settings/sources", ready: async (p) => { const l = p.getByRole("button", { name: "About code maps" }).first(); await l.scrollIntoViewIfNeeded(); await l.click(); } },
  { name: "co1-decisions-large", email: "approver@example.com", scenario: "large", url: "/company/decisions", ready: async (p) => { await p.getByRole("group", { name: "State" }).getByRole("button", { name: /^Any state/ }).click(); await expect(p.getByTestId("decision-ref").first()).toBeVisible(); } },
  { name: "co2-updates-empty", scenario: "empty", url: "/company/updates", ready: (p) => expect(p.getByTestId("updates-empty")).toBeVisible() },
  { name: "x1-requests-failed", fail: "/v1/requests", url: "/requests", ready: (p) => expect(p.getByTestId("load-error")).toBeVisible() },
  { name: "x1-baseline-failed", fail: "/v1/baseline/graph", url: "/baseline", ready: (p) => expect(p.getByTestId("load-error")).toBeVisible() },
  { name: "x1-strategy-failed", fail: "/v1/strategy/stack", url: "/company/strategy", ready: (p) => expect(p.getByTestId("load-error")).toBeVisible() },
  { name: "x1-members-failed", fail: "/v1/members", url: "/settings/members", ready: async (p) => { await expect(p.getByTestId("load-error")).toBeVisible(); await p.getByRole("button", { name: "About the error" }).click(); } },
];
for (const scheme of ["light", "dark"] as const)
  for (const w of [1440, 390])
    for (const s of SHOTS)
      test(`${s.name} ${scheme} ${w}`, async ({ page }) => {
        await page.setViewportSize({ width: w, height: w === 390 ? 844 : 900 });
        await page.addInitScript(([k, v, sc]) => { localStorage.setItem(k, v); if (sc) localStorage.setItem("po-mock-scenario", sc); }, [THEME_KEY, scheme, s.scenario ?? ""] as const);
        await page.emulateMedia({ colorScheme: scheme });
        await login(page, s.email);
        if (s.fail) await page.evaluate((f) => localStorage.setItem("po-mock-fail", f), s.fail);
        await page.goto(s.url);
        await s.ready(page);
        await page.waitForTimeout(400);
        await page.screenshot({ path: `${OUT}/${s.name}-${w}-${scheme}.png` });
      });
