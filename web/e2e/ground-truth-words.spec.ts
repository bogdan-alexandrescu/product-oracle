import { expect, test, type Page } from "./test";

import { MOCK_ROLE_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";

/**
 * Owner's decision (Nov 5): Oracle's cited graph is the Ground Truth in every word a person
 * reads. Detailed's page and nav say "Ground Truth", its two tabs "Ground Truth" and "Running
 * today"; no page says "Desired state", "Current state" or "Baseline" for the graph: not its
 * text, its title, an aria-label, a tooltip or a field's hint. Walks Detailed and Simple as the
 * owner and as a viewer, desktop and phone, light and dark. Mock API, made-up data.
 */

/** The old names. "Baseline" stays only for a measure's starting value ("Baseline value", "Baseline 12"). */
const OLD = /desired state|current state|\bbaseline\b(?! value| ?[:=]? ?[-+]?\d)/i;

const DETAILED = [
  "/home",
  "/requests",
  "/ground-truth",
  "/ground-truth?view=current",
  "/documents",
  "/priorities",
  "/plan",
  "/runs",
  "/inbox",
  "/company",
  "/settings",
];
const SIMPLE = ["/simple", "/simple/goals", "/simple/roadmap", "/simple/priorities", "/simple/decisions", "/simple/meetings"];

const VIEWS = [
  { name: "desktop light", viewport: { width: 1440, height: 900 }, colorScheme: "light" },
  { name: "desktop dark", viewport: { width: 1440, height: 900 }, colorScheme: "dark" },
  { name: "phone light", viewport: { width: 390, height: 844 }, colorScheme: "light" },
  { name: "phone dark", viewport: { width: 390, height: 844 }, colorScheme: "dark" },
] as const;

/** Every word on the page a person reads or hears: its text, title, labels, tooltips and hints. */
async function words(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out = [document.title, document.body.innerText];
    for (const el of Array.from(document.querySelectorAll("[aria-label], [title], [placeholder], [alt], [aria-description]"))) {
      for (const name of ["aria-label", "title", "placeholder", "alt", "aria-description"]) {
        const v = el.getAttribute(name);
        if (v) out.push(v);
      }
    }
    return out;
  });
}

async function saysNoOldName(page: Page, url: string) {
  await page.goto(url);
  await expect(page.locator("main").first()).toBeVisible();
  await page.waitForLoadState("networkidle");
  const said = (await words(page)).flatMap((w) => w.split("\n")).filter((line) => OLD.test(line));
  expect(said, `${url} says an old name`).toEqual([]);
}

for (const role of ["owner", "viewer"] as const) {
  for (const view of VIEWS) {
    test.describe(`${role}, ${view.name}`, () => {
      test.use({ viewport: view.viewport, colorScheme: view.colorScheme });

      test(`Detailed and Simple say Ground Truth, never Desired state, Current state or Baseline (${role}, ${view.name})`, async ({ page }) => {
        test.setTimeout(240_000);
        if (role === "viewer") await page.addInitScript(([key]) => localStorage.setItem(key, "viewer"), [MOCK_ROLE_KEY] as const);
        await login(page);

        // The page and its two tabs have their new names; an old /baseline link lands there.
        await page.goto("/baseline");
        await expect(page).toHaveURL(/\/ground-truth$/);
        await expect(page.getByRole("heading", { level: 1, name: "Ground Truth" })).toBeVisible();
        const tabs = page.getByTestId("cs-tabs");
        await expect(tabs.getByRole("tab", { name: /^Ground Truth/ })).toHaveAttribute("aria-selected", "true");
        await tabs.getByRole("tab", { name: /^Running today/ }).click();
        await expect(page).toHaveURL(/\/ground-truth\?view=current$/);
        await expect(page.getByRole("heading", { level: 1, name: "Ground Truth" })).toBeVisible();
        await expect(tabs.getByRole("tab", { name: /^Running today/ })).toHaveAttribute("aria-selected", "true");

        for (const url of [...DETAILED, ...SIMPLE]) await saysNoOldName(page, url);
      });
    });
  }
}
