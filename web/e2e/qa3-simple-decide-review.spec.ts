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

    test("a panel opened on purpose stays open after a row's Ask Oracle and the next load", async ({ page }) => {
      await decisions(page);
      await page.getByTestId("simple-ask").click();
      await expect(panel(page)).toBeVisible();
      await row(page, "Q6").getByRole("button", { name: "Ask Oracle" }).click();
      await expect(panel(page)).toBeVisible();
      await page.reload();
      await expect(page.getByTestId("question-row").first()).toBeVisible();
      await expect(panel(page)).toBeVisible();
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
      await expect(foot.getByRole("link", { name: "Open the Inbox (it leaves Simple)" })).toBeVisible();
    });
  });
}
