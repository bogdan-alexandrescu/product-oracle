import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login, openRoadmapItem } from "./helpers";
import { expect, test, type Page } from "./test";

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

/** From Simple's roadmap, an item's card, then its "Open the detailed view". */
async function openDetailed(page: Page, key: string, title: string, email?: string) {
  await login(page, email);
  await page.goto("/simple/roadmap");
  await expect(page.getByTestId("simple-roadmap")).toBeVisible();
  await openRoadmapItem(page, key);
  const card = page.getByTestId("floating-card");
  await expect(card.getByRole("heading", { name: title, exact: true })).toBeVisible();
  await card.getByRole("link", { name: "Open the detailed view" }).click();
  await expect(page).toHaveURL(new RegExp(`/plan\\?item=${key}&prd=[0-9a-f-]{36}&roadmap=[a-z-]+$`));
}

for (const [where, use] of [
  ["desktop", {}],
  ["phone", PHONE],
] as const) {
  test.describe(where, () => {
    test.use(use);

    test("the detailed view opens the item, though the Plan reads it under another PRD", async ({ page }) => {
      await openDetailed(page, "alert-digest", DIGEST);
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
      await openDetailed(page, "setup-ideas", "Team invite nudges");
      const line = page.getByTestId("plan-missing-item");
      await expect(line).toBeVisible();
      await expect(line).toContainText("Team invite nudges is not on the Plan yet: it is in Guided setup's draft");
      await expect(line).toBeInViewport();
      // Nothing unrelated stands in for it.
      await expect(page.locator('[data-testid="plan-row"][aria-selected="true"]')).toHaveCount(0);
      await expect(page.getByTestId("sheet-plan-item")).not.toBeVisible();
      await line.getByRole("link", { name: "Open it on the roadmap" }).click();
      await expect(page).toHaveURL(/\/simple\/roadmap\?item=[0-9a-f-]{36}$/);
      await expect(page.getByTestId("floating-card").getByRole("heading", { name: "Team invite nudges", exact: true })).toBeVisible();
    });

    for (const [who, email] of [
      ["owner", undefined],
      ["approver", APPROVER],
    ] as const) {
      test(`as the ${who}, a key two roadmaps hold opens the one in the card's roadmap`, async ({ page }) => {
        await inScenario(page, "plan-same-key");
        await openDetailed(page, "threshold-alerts", "Free shipping threshold alert", email);
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
        await expect(line).toContainText("Quiet hours for alerts is not on the Plan yet: it is in Usage alerts's draft");
        await expect(line).toBeInViewport();
        await expect(page.locator('[data-testid="plan-row"][aria-selected="true"]')).toHaveCount(0);
        await line.getByRole("link", { name: "Open it on the roadmap" }).click();
        await expect(page).toHaveURL(/\/simple\/roadmap\?item=[0-9a-f-]{36}$/);
        await expect(page.getByTestId("floating-card").getByRole("heading", { name: "Quiet hours for alerts", exact: true })).toBeVisible();
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
