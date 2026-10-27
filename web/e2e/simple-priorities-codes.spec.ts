import { login } from "./helpers";
import { expect, test, type BrowserContext, type Locator, type Page } from "./test";

/**
 * Simple Priorities: stable item codes on Value / effort (#723; the owner's pick "Short code +
 * highlight"). Each mark shows a short code that never changes with rank (the feature's code,
 * F-12 for setup-import in the mock, else initials of the item's key: AS for alert-sso); the
 * ranked side list shows the same code beside the rank; the item just moved stays highlighted
 * on the chart and in the list with "moved #a → #b" until the next move. Every action is
 * driven through the UI (a mouse or finger drag, the arrow keys).
 */

const PHONE = { width: 390, height: 844 };

async function open(page: Page, email: string): Promise<Page> {
  await login(page, email);
  await page.goto("/simple/priorities?tab=value-effort");
  await expect(page.getByTestId("vxe-point").first()).toBeVisible();
  return page;
}

async function dark(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => localStorage.setItem("oracle-theme", "dark"));
}

const point = (tab: Page, code: string): Locator => tab.locator(`[data-testid="vxe-point"][data-code="${code}"]`);
const side = (tab: Page, code: string): Locator => tab.locator(`[data-testid="side-row"][data-code="${code}"]`);

/** Drags a mark `weeks` to the left (less effort), as a person does with a mouse or a finger. */
async function dragLeft(tab: Page, code: string, weeks: number): Promise<void> {
  const mark = point(tab, code);
  await mark.evaluate((e) => e.scrollIntoView({ block: "center" }));
  const plot = (await tab.getByTestId("vxe-plot").boundingBox())!;
  const at = (await mark.boundingBox())!;
  // maxE is 5 weeks across the plot's inner 92%.
  await tab.mouse.move(at.x + at.width / 2, at.y + at.height / 2);
  await tab.mouse.down();
  await tab.mouse.move(at.x + at.width / 2 - (plot.width * 0.92 * weeks) / 5, at.y + at.height / 2 + 3, { steps: 10 });
  await tab.mouse.up();
}

/** Every mark's code, by item. */
const markCodes = (tab: Page) =>
  tab.getByTestId("vxe-point").evaluateAll((els) => Object.fromEntries(els.map((e) => [e.getAttribute("data-code"), e.querySelector('[data-testid="vxe-code"]')?.textContent ?? null])));

const CODES = {
  "setup-checklist": "SC",
  "alert-rules": "AR",
  "alert-digest": "AD",
  "alert-mobile": "AM",
  "setup-import": "F-12",
  "alert-export": "AE",
  "alert-sso": "AS",
  "price-tiers": "PT",
  "setup-video": "SV",
};

test.describe("desktop", () => {
  /**
   * Card simple-priorities-codes-drag: protects = each Value / effort mark shows its short
   * stable code (F-12, AS…), never its rank; dragging setup-import across a quadrant re-ranks
   * it (#5 → #2) while every mark keeps its code, the side-list row with that code shows the
   * new rank beside the code and "moved #5 → #2", the mark is highlighted, the hover card
   * keeps the rank, and the legend says codes stay with the item; fails_when = a mark shows a
   * rank or another item's code after the move, the side list loses the code or the rank, or
   * the moved row is not highlighted; no_claim = the API's codes (pytest
   * test_short_codes_stay_when_the_rank_moves), the real scoring.
   */
  test("drag a mark to another quadrant: its code stays, the list shows moved #5 → #2", async ({ page }) => {
    const admin = await open(page, "admin@example.com");
    expect(await markCodes(admin)).toEqual(CODES);
    await expect(admin.getByLabel("Legend")).toContainText("Codes stay with the item; ranks are in the list.");
    await expect(admin.getByLabel("Legend")).not.toContainText("Numbers are ranks");
    await expect(side(admin, "setup-import").getByTestId("side-rank")).toHaveText("5");
    await expect(side(admin, "setup-import").getByTestId("side-code")).toHaveText("F-12");
    await expect(point(admin, "setup-import")).toHaveAttribute("title", /^#5 F-12 · /);

    await dragLeft(admin, "setup-import", 2);
    await expect(admin.getByText("Re-estimated setup-import: effort 1 wk")).toBeVisible();
    await expect(side(admin, "setup-import").getByTestId("side-rank")).toHaveText("2");
    expect(await markCodes(admin)).toEqual(CODES);
    await expect(side(admin, "setup-import").getByTestId("side-code")).toHaveText("F-12");
    await expect(side(admin, "setup-import").getByTestId("moved")).toHaveText("moved #5 → #2");
    await expect(side(admin, "setup-import")).toHaveAttribute("data-moved", "true");
    await expect(point(admin, "setup-import")).toHaveAttribute("data-moved", "true");
    await expect(point(admin, "setup-import")).toHaveAttribute("title", /^#2 F-12 · /);
    await expect(admin.locator('[data-moved="true"]')).toHaveCount(2);
  });

  /**
   * Card simple-priorities-codes-keys: protects = a keyboard move (an arrow key on a focused
   * mark) highlights that item the same way and replaces the previous highlight, and the
   * Ranked list tab and Goal buckets show the same short codes; fails_when = the keyboard
   * move leaves the old item highlighted or none, or the other views show item keys instead
   * of the codes; no_claim = screen-reader announcements.
   */
  test("a keyboard move highlights the moved item; the ranked list and buckets show the codes", async ({ page }) => {
    const admin = await open(page, "admin@example.com");
    await dragLeft(admin, "setup-import", 2);
    await expect(side(admin, "setup-import").getByTestId("moved")).toHaveText("moved #5 → #2");
    await expect(side(admin, "alert-sso").getByTestId("side-rank")).toHaveText("7");
    await point(admin, "alert-sso").focus();
    await admin.keyboard.press("ArrowUp");
    await admin.keyboard.press("ArrowUp");
    await admin.keyboard.press("ArrowUp");
    await expect(side(admin, "alert-sso").getByTestId("moved")).toHaveText(/^moved #7 → #\d$/);
    await expect(side(admin, "setup-import").getByTestId("moved")).toHaveCount(0);
    await expect(point(admin, "alert-sso")).toHaveAttribute("data-moved", "true");
    await expect(point(admin, "setup-import")).not.toHaveAttribute("data-moved", "true");
    expect(await markCodes(admin)).toEqual(CODES);

    await admin.getByRole("tab", { name: "Ranked list" }).click();
    const ranked = admin.locator('[data-testid="prio-row"][data-code="setup-import"]');
    await expect(ranked.getByTestId("prio-code")).toHaveText("F-12");
    await expect(ranked.getByTestId("prio-rank")).toHaveText("2");
    await admin.getByRole("tab", { name: "Goal buckets" }).click();
    await expect(admin.locator('[data-testid="goal-bucket"][data-key="faster-activation"]')).toContainText("F-12");
    await expect(admin.locator('[data-testid="goal-bucket"][data-key="faster-activation"]')).not.toContainText("setup-import");
  });

  /**
   * Card simple-priorities-codes-commenter: protects = a commenter's keyboard move is a
   * proposal: the codes show, nothing re-ranks and no item is marked moved; fails_when = a
   * proposal is shown as a move; no_claim = the decider's accept (simple-priorities.spec.ts).
   */
  test("a commenter's move is proposed and highlights nothing", async ({ page }) => {
    const cory = await open(page, "commenter@example.com");
    await point(cory, "setup-import").focus();
    await cory.keyboard.press("ArrowUp");
    await expect(cory.getByText("Proposed: waiting for the decider")).toBeVisible();
    await expect(cory.locator('[data-moved="true"]')).toHaveCount(0);
    expect(await markCodes(cory)).toEqual(CODES);
  });
});

test.describe("phone", () => {
  test.use({ viewport: PHONE });

  /**
   * Card simple-priorities-codes-phone: protects = on a phone, in dark, a finger's drag of a
   * mark keeps its code and the side list (under the chart) shows "moved #5 → #2" beside the
   * same code; fails_when = the phone shows ranks on the marks or loses the highlight;
   * no_claim = touch hardware gestures (Playwright drives pointer events).
   */
  test("drag a mark on a phone, dark: code kept, moved #5 → #2", async ({ page }) => {
    await dark(page.context());
    const admin = await open(page, "admin@example.com");
    await dragLeft(admin, "setup-import", 2);
    await expect(side(admin, "setup-import").getByTestId("moved")).toHaveText("moved #5 → #2");
    await expect(side(admin, "setup-import").getByTestId("side-code")).toHaveText("F-12");
    expect(await markCodes(admin)).toEqual(CODES);
  });
});
