import { login } from "./helpers";
import { expect, test, type Page } from "./test";

/**
 * QA pass 4, simple-decide lane: Simple's Decisions page (List, Board, By meeting) on the
 * mock's invented data, driven through the UI at the owner's 1512 px window and on a phone.
 *
 * protects = qa4-simple-decide-6 (the Board says "Decide for Priya Raman" as the List does),
 * -8 (the Board's first column says it holds questions missing a decider or a recommendation),
 * -9 (the Board's decided column says "Decided questions" on a phone's tab too), -10 (a row's
 * "Blocks" line in plain words), -21 (a meeting's date line does not repeat the PRD's name its
 * title already has), -37 (every PRD whose questions are shown is in the PRD filter), -38 (the
 * footer's Inbox link in plain words; a neutral Decided count).
 */

async function decisions(page: Page, view: "list" | "board" | "meetings" = "list", email?: string) {
  await login(page, email);
  await page.goto("/simple/decisions");
  await expect(page.getByTestId("questions-mine")).toBeVisible();
  if (view !== "list") await page.getByTestId(`decisions-view-${view}`).click();
}

const row = (page: Page, code: string) => page.getByTestId("question-row").filter({ visible: true }).and(page.locator(`[data-code="${code}"]`));

for (const phone of [false, true]) {
  test.describe(phone ? "phone" : "desktop", () => {
    test.use({ viewport: phone ? { width: 390, height: 844 } : { width: 1512, height: 900 } });

    test("qa4-simple-decide-6: the Board says Decide for Priya Raman on the approver's question, as the List does", async ({ page }) => {
      await decisions(page, "list");
      await expect(row(page, "Q7").getByRole("button", { name: "Decide for Priya Raman" })).toBeVisible();
      await page.getByTestId("decisions-view-board").click();
      await expect(page.getByTestId("questions-board")).toBeVisible();
      if (phone) await page.getByTestId("board-tab-recommended").click();
      const q7 = row(page, "Q7");
      await expect(q7).toBeVisible();
      await expect(q7.getByRole("button", { name: "Decide for Priya Raman" })).toBeVisible();
      await expect(q7.getByRole("button", { name: "Decide for Priya Raman" })).not.toHaveClass(/simple-button-primary/);
      await expect(q7.getByRole("button", { name: "Decide as recommended" })).toHaveCount(0);
    });

    test("qa4-simple-decide-8: the Board's first column says it holds questions missing a decider or a recommendation", async ({ page }) => {
      await decisions(page, "board");
      const column = page.getByTestId("board-needs_input");
      await expect(column).toHaveAttribute("aria-label", "Missing a decider or a recommendation");
      if (phone) await expect(page.getByTestId("board-tab-needs_input")).toHaveText(/^Missing \d+$/);
      else await expect(column.locator("header")).toContainText("Missing a decider or a recommendation");
      // Q2 has a recommendation but no decider: it sits here, and the column's name fits it.
      const q2 = row(page, "Q2");
      await expect(q2).toContainText("No decider yet");
      await expect(q2).toContainText("CSV first");
      await expect(page.getByTestId("questions-board")).not.toContainText("Needs input");
    });

    test("qa4-simple-decide-9: the Board's decided count says it counts questions, on a phone's tab too", async ({ page }) => {
      await decisions(page, "board");
      if (phone) {
        await expect(page.getByTestId("board-tab-decided")).toHaveText(/^Decided questions \d+$/);
        expect(await page.evaluate(() => document.scrollingElement!.scrollWidth)).toBeLessThanOrEqual(390);
        await page.getByTestId("board-tab-decided").click();
      } else {
        await expect(page.getByTestId("board-decided").locator("header")).toContainText(/^Decided questions\s*\d+$/);
      }
      await expect(page.getByTestId("board-decided")).toHaveAttribute("aria-label", "Decided questions");
      await expect(row(page, "Q1")).toBeVisible();
    });

    test("qa4-simple-decide-10: a question's Blocks line reads in plain words, no codes", async ({ page }) => {
      await decisions(page, "list");
      await expect(row(page, "Q5")).toContainText("Blocks Health log, first milestone");
      await expect(page.getByTestId("questions-mine")).not.toContainText(/Blocks M\d|F-\d+/);
      await page.getByTestId("decisions-view-board").click();
      if (phone) await page.getByTestId("board-tab-recommended").click();
      await expect(row(page, "Q7")).toContainText("Blocks Health log, first milestone");
      await expect(page.getByTestId("questions-board")).not.toContainText(/Blocks M\d/);
    });

    test("qa4-simple-decide-21: By meeting, a meeting's date line leaves out the PRD its title names", async ({ page }) => {
      await decisions(page, "meetings");
      const group = page.getByTestId("meeting-group").filter({ has: page.getByRole("link", { name: "Review: Usage alerts" }) });
      await expect(group).toBeVisible();
      const when = group.getByTestId("meeting-group-when");
      await expect(when).toHaveText(/^\w{3} \w{3} \d+/);
      await expect(when).not.toContainText("Usage alerts");
    });

    test("qa4-simple-decide-37: a commenter's PRD filter lists the PRD whose questions they see", async ({ page }) => {
      await decisions(page, "list", "commenter@example.com");
      await expect(page.getByTestId("questions-others")).toBeVisible();
      await expect(page.getByTestId("questions-source")).toContainText("Guided setup");
      const filter = page.getByRole("group", { name: "Filters" }).getByRole("combobox", { name: /^PRD\b/ });
      await expect(filter.locator("option", { hasText: "Guided setup" })).toHaveCount(1);
    });

    test("qa4-simple-decide-38: the footer's Inbox link in plain words; the Decided count is neutral", async ({ page }) => {
      await decisions(page, "list");
      const foot = page.getByTestId("decisions-approvals");
      await expect(foot.getByRole("link", { name: "Open the Inbox in Detailed" })).toBeVisible();
      await expect(foot).not.toContainText("it leaves Simple");
      await page.getByTestId("decisions-view-board").click();
      await expect(page.getByTestId("board-decided-count")).toHaveClass(/simple-count-quiet/);
      await expect(page.getByTestId("board-recommended-count")).not.toHaveClass(/simple-count-quiet/);
      if (!phone) await expect(page.getByTestId("board-decided-count")).toBeVisible();
    });
  });
}
