import { login } from "./helpers";
import { expect, test, type Page } from "./test";

/**
 * The fix2-simple-decide review's findings on the Decisions page, driven through the UI on
 * the mock's invented data, at the owner's 1512 px window, light and dark.
 *
 * qa-simple-decide-10: a row's Ask Oracle opens the panel beside the page, never over the
 * row's own buttons; a panel the person opened on purpose is still open after the next load,
 * one opened for a single question is not; leaving the page closes it.
 * Name a decider / Ask someone to answer: the picker that replaces the button takes the
 * focus, and Cancel gives it back to the button; the picker words name no role.
 * Plain words: the Board's "Decided questions"; the foot says why Oracle's own approvals
 * are not counted and that its Inbox link leaves Simple.
 */

const row = (page: Page, code: string) => page.getByTestId("question-row").filter({ visible: true }).and(page.locator(`[data-code="${code}"]`));
const panel = (page: Page) => page.getByTestId("hop-panel").filter({ visible: true });

async function decisions(page: Page, view: "list" | "board" = "list") {
  await login(page);
  await page.goto("/simple/decisions");
  await page.getByTestId(`decisions-view-${view}`).click();
}

for (const scheme of ["light", "dark"] as const) {
  test.describe(`1512 · ${scheme}`, () => {
    test.use({ viewport: { width: 1512, height: 900 }, colorScheme: scheme });

    test("Ask Oracle on a row opens the panel beside the page: the row's buttons stay clickable", async ({ page }) => {
      await decisions(page);
      const q2 = row(page, "Q2");
      await q2.getByRole("button", { name: "Ask Oracle" }).click();
      await expect(panel(page)).toBeVisible();
      const drawer = (await page.getByTestId("hop-drawer").boundingBox())!;
      for (const name of ["Decide as recommended", "Another answer", "Ask Oracle"]) {
        const b = (await q2.getByRole("button", { name }).boundingBox())!;
        expect(b.x + b.width).toBeLessThanOrEqual(drawer.x);
      }
      await q2.getByRole("button", { name: "Another answer" }).click();
      await expect(q2.getByRole("button", { name: "Another answer" })).toHaveAttribute("aria-expanded", "true");
      await expect(panel(page)).toBeVisible();
      // Leaving the page closes a panel opened for one question.
      await page.getByTestId("simple-nav-home").click();
      await expect(page).not.toHaveURL(/decisions/);
      await expect(panel(page)).toHaveCount(0);
    });

    test("a panel opened on purpose stays open after a row's Ask Oracle; the next visit starts with a clean slate", async ({ page }) => {
      await decisions(page);
      await page.getByTestId("simple-ask").click();
      await expect(panel(page)).toBeVisible();
      await row(page, "Q6").getByRole("button", { name: "Ask Oracle" }).click();
      await expect(panel(page)).toBeVisible();
      // The owner's Ask pick C (qa-simple-home-21): each visit to Simple starts with Ask closed.
      await page.reload();
      await expect(page.getByTestId("question-row").first()).toBeVisible();
      await expect(panel(page)).toHaveCount(0);
    });

    test("Name a decider and Ask someone to answer: the picker takes the focus, Cancel gives it back", async ({ page }) => {
      await decisions(page, "board");
      const q2 = row(page, "Q2");
      await q2.getByRole("button", { name: "Name a decider" }).click();
      const people = q2.getByTestId("question-people");
      await expect(people).toBeFocused();
      await expect(people).toContainText("Only the people who may decide are listed.");
      await expect(people).not.toContainText("approvers");
      await people.getByRole("button", { name: "Cancel" }).click();
      await expect(q2.getByRole("button", { name: "Name a decider" })).toBeFocused();
      const q3 = row(page, "Q3");
      await q3.getByRole("button", { name: "Ask someone to answer" }).click();
      await expect(q3.getByTestId("question-people")).toBeFocused();
      await q3.getByTestId("question-people").getByRole("button", { name: "Cancel" }).click();
      await expect(q3.getByRole("button", { name: "Ask someone to answer" })).toBeFocused();
    });

    test("plain words: the Board's decided column and the foot's Oracle approvals", async ({ page }) => {
      await decisions(page, "board");
      await expect(page.getByTestId("board-decided")).toHaveAttribute("aria-label", "Decided questions");
      const foot = page.getByTestId("decisions-approvals");
      await expect(foot).toContainText("They are not product decisions, so they are not listed or counted here.");
      await expect(foot.getByRole("link", { name: "Open the Inbox in Detailed" })).toBeVisible();
    });
  });
}

/*
 * qa-simple-decide-10 (re-review): below 1240 px a docked panel squeezed the page to a column of
 * single words (168 px at 800). There the panel is a drawer over the page with a backdrop that
 * closes it; the page keeps its width. fails_when=the page narrows when the panel opens, or the
 * backdrop does not close it; no_claim=Detailed's pages (their own strip and 1600 px rule).
 */
for (const width of [800, 1024] as const) {
  test(`${width} px: a row's Ask Oracle opens a drawer over the page, which keeps its width`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await decisions(page);
    const main = page.locator("main").first();
    const before = (await main.boundingBox())!.width;
    await row(page, "Q2").getByRole("button", { name: "Ask Oracle" }).click();
    await expect(panel(page)).toBeVisible();
    expect(Math.abs((await main.boundingBox())!.width - before)).toBeLessThan(2);
    await expect(page.getByRole("heading", { level: 1, name: "Decisions" })).toBeVisible();
    const backdrop = page.getByTestId("hop-backdrop");
    await expect(backdrop).toBeVisible();
    await backdrop.click({ position: { x: 20, y: 450 } });
    await expect(panel(page)).toHaveCount(0);
  });
}
