import { expect, test, type Page } from "./test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";

// E3 Changed since the last roadmap: a roadmap version's Items tab compared with the
// previous version or the approved plan, item by item.
//
// The "roadmap-diff" mock scenario: usage-alerts-roadmap v1 (approved) has Behaviour (Now),
// Success metrics (Next) and Usage exports (Later); the draft v2 adds Spend limits (Now),
// moves Behaviour to Next and drops Usage exports.

const V1 = "/documents/usage-alerts-roadmap/v/1/items";
const V2 = "/documents/usage-alerts-roadmap/v/2/items";

function scenario(page: Page) {
  return page.addInitScript((key) => localStorage.setItem(key, "roadmap-diff"), MOCK_SCENARIO_KEY);
}

// Next keeps recently visited routes mounted (hidden): only the visible page's elements.
const visible = (page: Page, testId: string) => page.getByTestId(testId).filter({ visible: true });
const row = (page: Page, title: string) => visible(page, "roadmap-item-row").filter({ hasText: title });
const chip = (page: Page, name: RegExp) => visible(page, "items-filter").getByRole("button", { name });

// Card changed-default: protects = v2 opens on its changes, with the dropped item visible in
// the horizon it had; fails_when = the default is All, a change chip is wrong or the dropped
// item is missing; no_claim = the real API (mocked; the API's rows are covered by pytest).
test("a later version opens on what changed since the previous one", async ({ page }) => {
  await scenario(page);
  await login(page);
  await page.goto(V2);
  await expect(chip(page, /^Changed/)).toHaveAttribute("aria-pressed", "true");
  await expect(visible(page, "filter-changed")).toHaveText("Changed3");
  await expect(visible(page, "items-compare-summary")).toHaveText("Since v1: 1 new · 1 dropped · 1 moved");
  await expect(row(page, "Spend limits").getByTestId("item-change")).toHaveText("New");
  await expect(row(page, "Behaviour").getByTestId("item-change")).toHaveText("Now → Next");
  await expect(row(page, "Behaviour")).toHaveAttribute("data-change", "moved");
  const ghost = visible(page, "roadmap-item-ghost");
  await expect(ghost).toHaveCount(1);
  await expect(ghost).toContainText("Usage exports");
  await expect(ghost.getByTestId("item-change")).toHaveText("Dropped");
  await expect(ghost.locator("s")).toHaveText("Usage exports");
  // In the Later group, the horizon it had.
  const group = await ghost.evaluate((el) => {
    let at = el.previousElementSibling;
    while (at && at.getAttribute("data-testid") !== "roadmap-group") at = at.previousElementSibling;
    return at?.getAttribute("data-horizon");
  });
  expect(group).toBe("later");
  // Unchanged items wait for All.
  await expect(row(page, "Success metrics")).toHaveCount(0);
  await chip(page, /^All/).click();
  await expect(row(page, "Success metrics")).toHaveCount(1);
  await expect(page).toHaveURL(/filter=all/);
});

// Card what-changed-and-history: protects = the inspector says what moved and where the item
// was version by version; fails_when = the line or an entry is missing or out of order;
// no_claim = draft entries (E1).
test("the inspector shows what changed and the item's history", async ({ page }) => {
  await scenario(page);
  await login(page);
  await page.goto(V2);
  await row(page, "Behaviour").click();
  const what = visible(page, "item-what-changed");
  await expect(what).toContainText("What changed since v1");
  await expect(what).toContainText("Horizon: Now → Next");
  await expect(visible(page, "item-history").locator("li")).toHaveText(["Roadmap v1 · Now · approved", "Roadmap v2 · Next"]);
});

// Card first-version: protects = a version with nothing before it offers no comparison;
// fails_when = a Changed chip shows or the option is enabled; no_claim = tip styling.
test("the first version has nothing to compare with", async ({ page }) => {
  await scenario(page);
  await login(page);
  await page.goto(V1);
  await expect(visible(page, "roadmap-item-row")).toHaveCount(3);
  const previous = visible(page, "compare-previous");
  await expect(previous).toHaveText("Previous version");
  await expect(previous).toBeDisabled();
  await expect(previous).toHaveAttribute("title", "No earlier version with items");
  await expect(visible(page, "compare-approved")).toBeDisabled();
  await expect(page.getByTestId("filter-changed")).toHaveCount(0);
  await expect(page.getByTestId("roadmap-item-ghost")).toHaveCount(0);
});

// Card approved-in-url: protects = "against the approved plan" is a view a person can choose
// and share; fails_when = the URL loses it or a reload drops it; no_claim = which version is
// approved (pytest).
test("comparing with the approved plan is kept in the URL", async ({ page }) => {
  await scenario(page);
  await login(page);
  await page.goto(V2);
  const approved = visible(page, "compare-approved");
  await expect(approved).toHaveText("Approved v1");
  await approved.click();
  await expect(page).toHaveURL(/compare=approved/);
  await expect(visible(page, "items-compare-summary")).toHaveText("Since approved v1: 1 new · 1 dropped · 1 moved");
  await page.reload();
  await expect(visible(page, "compare-approved")).toHaveAttribute("aria-pressed", "true");
  await expect(row(page, "Behaviour").getByTestId("item-change")).toHaveText("Now → Next");
});

// Card phone: protects = the compare control and chips fit a phone; fails_when = the page
// scrolls sideways; no_claim = the look of the wrap.
test("on a phone the compare control wraps without a sideways scroll", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await scenario(page);
  await login(page);
  await page.goto(V2);
  await expect(visible(page, "items-compare")).toBeVisible();
  await expect(row(page, "Spend limits").getByTestId("item-change")).toHaveText("New");
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});
