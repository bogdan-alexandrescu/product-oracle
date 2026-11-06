import { stableUuid } from "../lib/api/mock/ids";
import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";
import { expect, test, type Locator, type Page } from "./test";

/**
 * Card plan-open-from-simple: protects = Simple's "Open the detailed view" lands on that item
 * on the Plan, selected, in view and open in the inspector (a phone: the bottom sheet), even when
 * the Plan reads it under another PRD than the card's link names; an item only in a draft gets
 * one line saying so, with a link back to its card; fails_when = the Plan shows its first row or
 * nothing; no_claim = the inspector's own parts (plan-inspector-actions).
 * Keys are unique only per roadmap: the link names the item's roadmap, and the Plan picks the row
 * in it ("plan-same-key"). A report's "<prd>:<key>" link to an item only in a draft names it, with
 * a link to its card ("report-draft-item"). Each as the owner and as an approver.
 * Invented data: the mock's Alerts, Onboarding and Checkout roadmaps (web/lib/api/mock).
 */

const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true };
const APPROVER = "approver@example.com";
/** The digest as Simple's card and the Plan both name it: one item, one name. */
const DIGEST = "Weekly alert digest";

const inScenario = (page: Page, s: string) => page.addInitScript(([key, v]) => localStorage.setItem(key, v), [MOCK_SCENARIO_KEY, s] as const);

/** The Plan's inspector: the phone's bottom sheet, or the desktop's side panel. */
const inspector = (page: Page, where: "desktop" | "phone") =>
  where === "phone" ? page.getByTestId("sheet-plan-item").getByTestId("plan-inspector") : page.getByTestId("plan-inspector").filter({ visible: true });

/**
 * The PRD id Simple's card carries for an item of the mock's roadmap `key` (the mock's item.prd,
 * ./lib/api/mock/simple-roadmap.ts itemPrd): the card's real one, which is not the id the Plan
 * reads the item under.
 */
const cardPrd = (key: string) => stableUuid(`simple-prd/${key}`);

/**
 * Simple's card "Open the detailed view" link: /plan?item=<key>&prd=<id>&roadmap=<slug>. The card
 * that emits &roadmap= is the Simple lane's part (this line's card names no roadmap yet), so the
 * Plan is opened by that link, with the card's own PRD id.
 */
async function openDetailed(page: Page, key: string, prd: string, roadmap: string, email?: string) {
  await login(page, email);
  await page.goto(`/plan?item=${key}&prd=${cardPrd(prd)}&roadmap=${roadmap}`);
}

/**
 * "Open it on the roadmap" names the item's card by its id. Simple's reader of ?item= (AN
 * 1b8d555db and 775ac69ed) is left for the Simple port, so only the link's target is checked.
 */
const toCard = (line: Locator) =>
  expect(line.getByRole("link", { name: "Open it on the roadmap" })).toHaveAttribute("href", /^\/simple\/roadmap\?item=[0-9a-f-]{36}$/);

for (const [where, use] of [
  ["desktop", {}],
  ["phone", PHONE],
] as const) {
  test.describe(where, () => {
    test.use(use);

    test("the detailed view opens the item, though the Plan reads it under another PRD", async ({ page }) => {
      await openDetailed(page, "alert-digest", "alerts-roadmap", "usage-alerts-roadmap");
      // The Plan's own row for the key, not its first row.
      const row = page.locator('[data-testid="plan-row"][data-item="alert-digest"]');
      await expect(row).toHaveAttribute("aria-selected", "true");
      await expect(page.locator('[data-testid="plan-row"][aria-selected="true"]')).toHaveCount(1);
      await expect(row).toBeInViewport();
      if (where === "phone") {
        const sheet = page.getByTestId("sheet-plan-item");
        await expect(sheet).toBeVisible();
        await expect(sheet.getByTestId("plan-inspector")).toContainText(DIGEST);
      } else {
        const inspector = page.getByTestId("plan-inspector").filter({ visible: true });
        await expect(inspector).toContainText(DIGEST);
        await expect(inspector).toBeInViewport();
      }
      await expect(page.getByTestId("plan-missing-item")).toHaveCount(0);
    });

    test("an item only in a draft says where it is, with a link to its card", async ({ page }) => {
      await openDetailed(page, "setup-ideas", "onboarding-roadmap", "onboarding-roadmap");
      const line = page.getByTestId("plan-missing-item");
      await expect(line).toBeVisible();
      await expect(line).toContainText("Team invite nudges is not on the Plan yet: it is in the draft of Guided setup");
      await expect(line).toBeInViewport();
      // Nothing unrelated stands in for it.
      await expect(page.locator('[data-testid="plan-row"][aria-selected="true"]')).toHaveCount(0);
      await expect(page.getByTestId("sheet-plan-item")).not.toBeVisible();
      await toCard(line);
    });

    for (const [who, email] of [
      ["owner", undefined],
      ["approver", APPROVER],
    ] as const) {
      test(`as the ${who}, a key two roadmaps hold opens the one in the card's roadmap`, async ({ page }) => {
        await inScenario(page, "plan-same-key");
        await openDetailed(page, "threshold-alerts", "checkout-redesign-roadmap", "checkout-redesign-roadmap", email);
        // Both roadmaps' rows are on the Plan; the Checkout one is picked, not Usage alerts' first row.
        await expect(page.locator('[data-testid="plan-row"][data-item="threshold-alerts"]').filter({ visible: true })).toHaveCount(2);
        const picked = page.locator('[data-testid="plan-row"][aria-selected="true"]').filter({ visible: true });
        await expect(picked).toHaveCount(1);
        await expect(picked).toContainText("Free shipping threshold alert");
        await expect(picked).toBeInViewport();
        await expect(inspector(page, where)).toContainText("Free shipping threshold alert");
        await expect(inspector(page, where)).not.toContainText("Threshold alerts on spend");
        await expect(page.getByTestId("plan-missing-item")).toHaveCount(0);
      });

      test(`as the ${who}, a report's link to an item only in a draft names it, with a link to its card`, async ({ page }) => {
        await inScenario(page, "report-draft-item");
        await login(page, email);
        await page.goto("/plan/reports");
        await page.getByRole("link", { name: /week of Oct 12/ }).first().click();
        const track = page.getByTestId("report-track").filter({ visible: true }).first();
        await track.getByTestId("report-drift").getByRole("link", { name: "Quiet hours for alerts" }).click();
        await expect(page).toHaveURL(/\/plan\?item=usage-alerts:alert-quiet-hours$/);
        const line = page.getByTestId("plan-missing-item");
        await expect(line).toContainText("Quiet hours for alerts is not on the Plan yet: it is in the draft of Usage alerts");
        await expect(line).toBeInViewport();
        await expect(page.locator('[data-testid="plan-row"][aria-selected="true"]')).toHaveCount(0);
        await toCard(line);
      });
    }
  });
}

/** A weekly report's item link names the PRD by its slug ("/plan?item=<prd>:<key>"): it lands on that item too. */
test("a report's item link opens that item on the Plan", async ({ page }) => {
  await page.addInitScript(([key, s]) => localStorage.setItem(key, s), [MOCK_SCENARIO_KEY, "alignment-report"] as const);
  await login(page);
  await page.goto("/plan/reports");
  await page.getByRole("link", { name: /week of Oct 12/ }).first().click();
  const track = page.getByTestId("report-track").filter({ visible: true }).first();
  await track.getByTestId("needs-attention").getByRole("link", { name: DIGEST }).click();
  await expect(page).toHaveURL(/\/plan\?item=usage-alerts:alert-digest$/);
  await expect(page.locator('[data-testid="plan-row"][data-item="alert-digest"]')).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("plan-inspector").filter({ visible: true })).toContainText(DIGEST);
  await expect(page.getByTestId("plan-missing-item")).toHaveCount(0);
});
