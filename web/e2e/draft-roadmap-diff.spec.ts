import { expect, test, type Page } from "@playwright/test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";

// E3b Roadmap diffs for PRD drafts: a PRD draft's Roadmap tab compared with the previous
// draft or the approved plan, item by item.
//
// The default mock seeds checkout-redesign v1 (Cart review and Shipping step in Now, Guest
// checkout in Next, One-tap wallet pay in Later) and v2 (Guest checkout moved to Now, the
// Shipping step's date removed, Saved addresses new, wallet pay gone). The "approved-plan"
// scenario adds usage-alerts-roadmap v1 approved (Behaviour in Now, Success metrics in Next)
// and usage-alerts v2, a draft whose items move Behaviour to Next and add Spend limits.

const V1 = "/documents/checkout-redesign/v/1/roadmap";
const V2 = "/documents/checkout-redesign/v/2/roadmap";
const ALERTS_V2 = "/documents/usage-alerts/v/2/roadmap";

// Next keeps recently visited routes mounted (hidden): only the visible page's elements.
const visible = (page: Page, testId: string) => page.getByTestId(testId).filter({ visible: true });
const row = (page: Page, title: string) => visible(page, "roadmap-item-row").filter({ hasText: title });
const chip = (page: Page, name: RegExp) => visible(page, "items-filter").getByRole("button", { name });

// Card draft-changed-default (#177 criterion 6): protects = a draft's Roadmap tab opens on
// what changed since the previous draft, with the dropped item struck in the horizon it had;
// fails_when = the default is All, a change chip is wrong or the dropped item is missing;
// no_claim = the real API (mocked; its rows are covered by pytest).
test("a draft's Roadmap tab opens on what changed since the previous draft", async ({ page }) => {
  await login(page);
  await page.goto("/documents/checkout-redesign/v/2");
  await visible(page, "version-tab-roadmap").click();
  await expect(page).toHaveURL(new RegExp(`${V2}$`));
  await expect(visible(page, "compare-previous")).toHaveText("Draft v1");
  await expect(visible(page, "compare-previous")).toHaveAttribute("aria-pressed", "true");
  await expect(chip(page, /^Changed/)).toHaveAttribute("aria-pressed", "true");
  await expect(visible(page, "filter-changed")).toHaveText("Changed4");
  await expect(visible(page, "items-compare-summary")).toHaveText("Since draft v1: 1 new · 1 dropped · 1 moved · 1 changed");
  await expect(row(page, "Guest checkout").getByTestId("item-change")).toHaveText("Next → Now");
  await expect(row(page, "Shipping step").getByTestId("item-change")).toHaveText("Date removed");
  await expect(row(page, "Saved addresses").getByTestId("item-change")).toHaveText("New");
  const ghost = visible(page, "roadmap-item-ghost");
  await expect(ghost).toHaveCount(1);
  await expect(ghost.locator("s")).toHaveText("One-tap wallet pay");
  await expect(ghost.getByTestId("item-change")).toHaveText("Dropped");
  const group = await ghost.evaluate((el) => {
    let at = el.previousElementSibling;
    while (at && at.getAttribute("data-testid") !== "roadmap-group") at = at.previousElementSibling;
    return at?.getAttribute("data-horizon");
  });
  expect(group).toBe("later");
  // The unchanged item waits for All.
  await expect(row(page, "Cart review")).toHaveCount(0);
  await chip(page, /^All/).click();
  await expect(page).toHaveURL(/filter=all/);
  await expect(row(page, "Cart review")).toHaveCount(1);
});

// Card draft-inspector (#177 criterion 7): protects = the inspector says what changed since
// the previous draft and where the item was draft by draft; fails_when = a line or an entry is
// missing or out of order; no_claim = the history route's ordering rules (pytest).
test("the inspector shows what changed since draft v1 and the item's history", async ({ page }) => {
  await login(page);
  await page.goto(V2);
  await row(page, "Guest checkout").click();
  const what = visible(page, "item-what-changed");
  await expect(what).toContainText("What changed since draft v1");
  await expect(what).toContainText("Horizon: Next → Now");
  await expect(what).toContainText("Rank: 3 → 2");
  await expect(visible(page, "item-history").locator("li")).toHaveText(["Draft v1 · Next", "Draft v2 · Now"]);
});

// Card draft-first: protects = the first draft offers nothing to compare with, and says why;
// fails_when = an option is enabled or a Changed chip shows; no_claim = tip styling.
test("the first draft has nothing to compare with", async ({ page }) => {
  await login(page);
  await page.goto(V1);
  await expect(visible(page, "roadmap-item-row")).toHaveCount(4);
  const previous = visible(page, "compare-previous");
  await expect(previous).toHaveText("Previous draft");
  await expect(previous).toBeDisabled();
  await expect(previous).toHaveAttribute("title", "No earlier draft with items");
  const approved = visible(page, "compare-approved");
  await expect(approved).toHaveText("Approved plan");
  await expect(approved).toBeDisabled();
  await expect(approved).toHaveAttribute("title", "No approved roadmap for this PRD yet");
  await expect(page.getByTestId("filter-changed")).toHaveCount(0);
  await expect(page.getByTestId("roadmap-item-ghost")).toHaveCount(0);
});

// Card draft-approved-plan (#177 criteria 10, 13–16): protects = a person compares a draft
// with the approved plan, sees what the draft would move and add, the choice kept in the URL
// across a reload, and the item's history across the roadmap and the draft; fails_when = the
// option is missing, a chip is wrong or a reload drops the choice; no_claim = which roadmap
// is the approved plan when there are several (pytest).
test("a draft compared with the approved plan, kept in the URL", async ({ page }) => {
  await page.addInitScript((key) => localStorage.setItem(key, "approved-plan"), MOCK_SCENARIO_KEY);
  await login(page);
  await page.goto(ALERTS_V2);
  await expect(visible(page, "compare-previous")).toBeDisabled();
  const approved = visible(page, "compare-approved");
  await expect(approved).toHaveText("Approved plan · roadmap v1");
  await approved.click();
  await expect(page).toHaveURL(/compare=approved/);
  await expect(visible(page, "items-compare-summary")).toHaveText("Since the approved plan · roadmap v1: 1 new · 1 moved");
  await expect(chip(page, /^Changed/)).toHaveAttribute("aria-pressed", "true");
  await expect(row(page, "Spend limits").getByTestId("item-change")).toHaveText("New");
  await expect(row(page, "Behaviour").getByTestId("item-change")).toHaveText("Now → Next");
  await expect(row(page, "Success metrics")).toHaveCount(0);
  await page.reload();
  await expect(visible(page, "compare-approved")).toHaveAttribute("aria-pressed", "true");
  await row(page, "Behaviour").click();
  await expect(visible(page, "item-what-changed")).toContainText("What changed since the approved plan · roadmap v1");
  await expect(visible(page, "item-history").locator("li")).toHaveText(["Roadmap v1 · Now · approved", "Draft v2 · Next"]);
});

// Card draft-phone: protects = the compare control and chips fit a phone; fails_when = the
// page scrolls sideways; no_claim = the look of the wrap.
test("on a phone the draft's compare control wraps without a sideways scroll", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  await page.goto(V2);
  await expect(visible(page, "items-compare")).toBeVisible();
  await expect(row(page, "Saved addresses").getByTestId("item-change")).toHaveText("New");
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});
