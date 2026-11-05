import { login, signOut } from "./helpers";
import { expect, test, type Page } from "./test";

/**
 * edit-decisions (the owner's picks, BGD Nov 5): ec1 b "Decision sheet" and eq2 b "Question
 * sheet", driven through Simple's Decisions page and Home on the mock's invented data (D-5 Keep
 * the free plan's five-seat limit, outside meetings; the PRD "Guided setup"'s Q5 Reminder default
 * time), desktop and phone, light and dark.
 */

const region = (page: Page, name: string) => page.getByRole("region", { name, exact: true });
const outside = (page: Page, code: string) => region(page, "Outside meetings").getByTestId("decision-row").filter({ hasText: new RegExp(`^${code} `) });
const question = (page: Page, code: string) => page.getByTestId("question-row").filter({ visible: true }).and(page.locator(`[data-code="${code}"]`));
const sheet = (page: Page) => page.getByTestId("decision-sheet");
const toast = (page: Page, text: string | RegExp) => page.getByTestId("toasts").getByText(text);

/** Signs in as `email` (signing out first when `again`; the account menu is the wide rail's) and opens Decisions. */
async function decisions(page: Page, email?: string, again = false) {
  if (again) {
    const size = page.viewportSize()!;
    await page.setViewportSize({ width: 1366, height: 820 });
    await signOut(page);
    await login(page, email);
    await page.setViewportSize(size);
  } else await login(page, email);
  await page.goto("/simple/decisions");
  await expect(page.getByRole("heading", { level: 1, name: "Decisions" })).toBeVisible();
}

for (const phone of [false, true]) {
  for (const scheme of ["light", "dark"] as const) {
    test.describe(`${phone ? "phone" : "desktop"} · ${scheme}`, () => {
      test.use({ viewport: phone ? { width: 390, height: 844 } : { width: 1366, height: 820 }, colorScheme: scheme });

      /**
       * Card ec1-sheet-edit: protects = an open decision's title opens its sheet with its question,
       * context, options, review day and who decides; Edit adds an option and moves the review day,
       * Save closes the sheet and the row reads "edited by you just now"; Reassign picks another
       * decider and the row names them; fails_when = the title is not a link, a field is missing,
       * the save or the reassign does not reach the row; no_claim = the real API's change engine.
       */
      test("ec1: a decision's sheet edits every field and reassigns it", async ({ page }) => {
        await decisions(page);
        const row = outside(page, "D-5");
        await row.getByTestId("decision-open").click();
        const s = sheet(page);
        await expect(s.getByRole("heading", { name: "D-5 Keep the free plan's five-seat limit" })).toBeVisible();
        await expect(s).toContainText("Keep the free plan's five-seat limit?");
        await expect(s).toContainText("Raised in the weekly product review.");
        await expect(s.getByRole("listitem")).toHaveText(["Yes, this quarter", "Not now"]);
        await expect(s.getByTestId("decision-sheet-decider")).toContainText("Avery Stone");
        await expect(s.getByRole("button", { name: "Withdraw" })).toBeVisible();
        await expect(s.getByRole("button", { name: "Delete" })).toBeVisible();

        await s.getByRole("button", { name: "Edit" }).click();
        await s.getByRole("button", { name: "+ Add an option" }).click();
        await s.getByRole("textbox", { name: "Option 3", exact: true }).fill("Ship to pilot customers first");
        await s.getByLabel("Review on").fill("2026-12-07");
        await s.getByRole("button", { name: "Save" }).click();
        await expect(s).toHaveCount(0);
        await expect(toast(page, "Saved D-5")).toBeVisible();
        await expect(row).toContainText("edited by you just now");

        await row.getByTestId("decision-open").click();
        await expect(s.getByRole("listitem")).toHaveText(["Yes, this quarter", "Not now", "Ship to pilot customers first"]);
        await expect(s).toContainText("Dec 7, 2026");
        await s.getByRole("button", { name: "Reassign" }).click();
        await s.getByRole("group", { name: "Who decides" }).getByRole("button", { name: "Priya Raman" }).click();
        await expect(s.getByTestId("decision-sheet-decider")).toContainText("Priya Raman");
        await expect(toast(page, "Priya Raman decides D-5")).toBeVisible();
        await page.keyboard.press("Escape");
        await expect(s).toHaveCount(0);
        await expect(row).toContainText("Priya Raman");
        await expect(row).toContainText("edited by you just now");
      });

      /**
       * Card ec1-withdraw-delete: protects = Withdraw at the sheet's foot strikes the decision through,
       * "kept in the history", with Undo that puts it back open; Delete takes it off the list with a
       * toast naming Settings › Trash, and Settings › Trash lists it as a Decision and restores it;
       * fails_when = the withdrawn row leaves or has no Undo, Undo fails, Delete leaves it listed or
       * Trash misses it or cannot restore it; no_claim = the 30-day purge.
       */
      test("ec1: Withdraw with Undo, and Delete to Settings › Trash and back", async ({ page }) => {
        await decisions(page);
        const row = outside(page, "D-5");
        await row.getByTestId("decision-open").click();
        await sheet(page).getByRole("button", { name: "Withdraw" }).click();
        await expect(sheet(page)).toHaveCount(0);
        await expect(row.getByTestId("decision-withdrawn")).toHaveText("Keep the free plan's five-seat limit");
        await expect(row).toContainText("Withdrawn by you just now · kept in the history");
        await row.getByRole("button", { name: "Undo" }).click();
        await expect(row.getByTestId("decision-open")).toBeVisible();

        await row.getByTestId("decision-open").click();
        await sheet(page).getByRole("button", { name: "Delete" }).click();
        await expect(toast(page, "D-5 is in Settings › Trash")).toBeVisible();
        await expect(row).toHaveCount(0);

        await page.goto("/settings/trash");
        const entry = page.getByTestId("trash-entry").filter({ hasText: "Keep the free plan's five-seat limit" });
        await expect(entry).toContainText("Decision");
        await expect(entry).toContainText("30 days left");
        await page.getByRole("button", { name: "Restore Keep the free plan's five-seat limit" }).click();
        await expect(entry).toHaveCount(0);
        await page.goto("/simple/decisions");
        await expect(outside(page, "D-5").getByTestId("decision-open")).toBeVisible();
      });

      /**
       * Card ec1-new: protects = + New decision opens the same sheet empty; Pick names who decides;
       * Add decision lists it in Outside meetings with its decider; fails_when = no button, no
       * Pick, or the new decision is not listed; no_claim = the meeting it later joins.
       */
      test("ec1: + New decision opens the sheet with Pick for who decides", async ({ page }) => {
        await decisions(page);
        await page.getByTestId("decisions-new").click();
        const s = sheet(page);
        await expect(s.getByRole("heading", { name: "New decision" })).toBeVisible();
        await s.getByRole("textbox", { name: "Title", exact: true }).fill("Offer a yearly plan at launch");
        await s.getByRole("textbox", { name: "Question", exact: true }).fill("Do we sell a yearly plan from day one?");
        await s.getByRole("textbox", { name: "Option 1", exact: true }).fill("Yes, at launch");
        await s.getByRole("textbox", { name: "Option 2", exact: true }).fill("After the first month");
        await s.getByRole("button", { name: "Pick" }).click();
        await s.getByRole("group", { name: "Who decides" }).getByRole("button", { name: "Priya Raman" }).click();
        await expect(s.getByTestId("decision-sheet-decider")).toContainText("Priya Raman");
        await s.getByRole("button", { name: "Add decision" }).click();
        await expect(s).toHaveCount(0);
        // The API numbers it after every decision and question, so it is first; the mock numbers Simple's own.
        const added = region(page, "Outside meetings").getByTestId("decision-row").filter({ hasText: "Offer a yearly plan at launch" });
        await expect(added).toContainText("Priya Raman");
        await expect(added.getByTestId("decision-open")).toBeVisible();
      });

      /**
       * Card eq2-sheet: protects = a PRD question's title opens the same sheet with the PRD's
       * recommendation, other answers and decider; Edit changes the text, the recommendation and
       * adds an answer, the row reads the new text "Edited by you just now"; Withdraw strikes it
       * through, "kept in the PRD's history", Undo brings it back; Delete takes it to Settings ›
       * Trash, listed as a Question; fails_when = any of those does not reach the row or Trash;
       * no_claim = the PRD document's text.
       */
      test("eq2: a question's sheet edits, withdraws with Undo and deletes to Trash", async ({ page }) => {
        await decisions(page);
        const q5 = question(page, "Q5");
        await q5.getByTestId("question-open").click();
        const s = sheet(page);
        await expect(s.getByRole("heading", { name: "Q5 Reminder default time" })).toBeVisible();
        await expect(s).toContainText("Recommended in Guided setup");
        await expect(s).toContainText("9:00 in each person's zone");
        await expect(s).toContainText("Other answers");
        await s.getByRole("button", { name: "Edit" }).click();
        await s.getByRole("textbox", { name: "Question", exact: true }).fill("Do weekly digests include muted alerts?");
        await s.getByRole("textbox", { name: "Recommendation", exact: true }).fill("Leave muted alerts out");
        await s.getByRole("button", { name: "+ Add an answer" }).click();
        const answers = s.getByRole("textbox", { name: /^Answer \d+$/ });
        await answers.last().fill("Ask each team");
        await s.getByRole("button", { name: "Save" }).click();
        await expect(s).toHaveCount(0);
        await expect(q5).toContainText("Do weekly digests include muted alerts?");
        await expect(q5.getByTestId("question-edited")).toHaveText("Edited by you just now");

        await q5.getByTestId("question-open").click();
        await expect(s).toContainText("Leave muted alerts out");
        await expect(s).toContainText("Ask each team");
        await s.getByRole("button", { name: "Withdraw" }).click();
        await expect(s).toHaveCount(0);
        await expect(q5.getByTestId("question-withdrawn")).toHaveText("Do weekly digests include muted alerts?");
        await expect(q5).toContainText("Withdrawn by you just now · kept in the PRD's history");
        await q5.getByRole("button", { name: "Undo" }).click();
        await expect(q5.getByTestId("question-open")).toBeVisible();

        await q5.getByTestId("question-open").click();
        await s.getByRole("button", { name: "Delete" }).click();
        await expect(toast(page, "Q5 is in Settings › Trash")).toBeVisible();
        await expect(q5).toHaveCount(0);
        await page.goto("/settings/trash");
        const entry = page.getByTestId("trash-entry").filter({ hasText: "Do weekly digests include muted alerts?" });
        await expect(entry).toContainText("Question");
        await page.getByRole("button", { name: "Restore Do weekly digests include muted alerts?" }).click();
        await expect(entry).toHaveCount(0);
        await page.goto("/simple/decisions");
        await expect(question(page, "Q5")).toContainText("Do weekly digests include muted alerts?");
      });

      /**
       * Card eq2-ask: protects = + Ask a question at the top of Waiting for you opens the same sheet
       * with its PRD to pick; Add question lists it with its recommendation; fails_when = no button,
       * no PRD field, or the new question is not listed; no_claim = its due date (none yet).
       */
      test("eq2: + Ask a question adds one to a PRD", async ({ page }) => {
        await decisions(page);
        await region(page, "Waiting for you").getByTestId("questions-ask").click();
        const s = sheet(page);
        await expect(s.getByRole("heading", { name: "New question" })).toBeVisible();
        await expect(s.getByLabel("PRD")).toBeVisible();
        await s.getByRole("textbox", { name: "Question", exact: true }).fill("Who can export a team's alert history?");
        await s.getByRole("textbox", { name: "Recommendation", exact: true }).fill("Owners and admins");
        await s.getByRole("textbox", { name: "Answer 1", exact: true }).fill("Everyone on the team");
        await s.getByRole("button", { name: "Add question" }).click();
        await expect(s).toHaveCount(0);
        await expect(toast(page, /^Added to /)).toBeVisible();
        const added = page.getByTestId("question-row").filter({ visible: true }).filter({ hasText: "Who can export a team's alert history?" });
        if (!(await added.count())) await region(page, "Waiting for you").getByRole("button", { name: /^Show \d+ more$/ }).click();
        await expect(added.first()).toBeVisible();
      });

      /**
       * Card ec1-eq2-propose: protects = an approver who is not the decider gets Suggest a change (no
       * Reassign, Withdraw or Delete) on D-5 and on Q5, and the sheet says who decides ("Avery Stone
       * decides"); Send sends it to Avery Stone; fails_when = Edit, Withdraw, Delete or Reassign
       * shows, or the toast does not name the decider; no_claim = the decider's inbox.
       */
      test("an approver suggests a change to whoever decides", async ({ page }) => {
        await decisions(page, "approver@example.com");
        await outside(page, "D-5").getByTestId("decision-open").click();
        const s = sheet(page);
        await expect(s.getByRole("button", { name: "Suggest a change" })).toBeVisible();
        for (const name of ["Edit", "Withdraw", "Delete", "Reassign"]) await expect(s.getByRole("button", { name, exact: true })).toHaveCount(0);
        await s.getByRole("button", { name: "Suggest a change" }).click();
        await expect(s.getByTestId("decision-sheet-foot")).toContainText("Avery Stone decides");
        await s.getByRole("textbox", { name: "Title", exact: true }).fill("Keep the free plan's five-seat limit for now");
        await s.getByRole("button", { name: "Send" }).click();
        await expect(toast(page, "Sent to Avery Stone to decide")).toBeVisible();
        await expect(outside(page, "D-5")).toContainText("Keep the free plan's five-seat limit");

        await question(page, "Q5").getByTestId("question-open").click();
        await expect(s.getByRole("button", { name: "Suggest a change" })).toBeVisible();
        await expect(s).toContainText("Avery Stone");
        for (const name of ["Edit", "Withdraw", "Delete"]) await expect(s.getByRole("button", { name, exact: true })).toHaveCount(0);
      });

      /**
       * Card ec1-eq2-read: protects = a viewer has no + New decision or + Ask a question, and the
       * titles open a sheet that reads only, with no buttons at its foot; fails_when = a write button
       * shows; no_claim = what a viewer reads elsewhere.
       */
      test("a viewer reads the sheet only", async ({ page }) => {
        await decisions(page, "viewer@example.com");
        await expect(page.getByTestId("decisions-new")).toHaveCount(0);
        await expect(page.getByTestId("questions-ask")).toHaveCount(0);
        const open = page.getByTestId("decision-open").or(page.getByTestId("question-open")).filter({ visible: true }).first();
        await open.click();
        const s = sheet(page);
        await expect(s.getByTestId("decision-sheet-body")).toBeVisible();
        await expect(s.getByTestId("decision-sheet-foot")).toHaveCount(0);
        await expect(s.getByRole("button", { name: /^(Edit|Suggest a change|Withdraw|Delete|Reassign)$/ })).toHaveCount(0);
      });

      /** Card eq2-home: protects = Home's question titles open the same sheet; fails_when = they do not. */
      test("eq2: Home's question titles open the same sheet", async ({ page }) => {
        await login(page);
        await page.goto("/simple");
        const open = page.getByTestId("home-question").getByTestId("question-open").filter({ visible: true }).first();
        await open.scrollIntoViewIfNeeded();
        const title = (await open.textContent())!.trim();
        await open.click();
        await expect(sheet(page)).toContainText(title);
        await expect(sheet(page).getByRole("button", { name: "Edit" })).toBeVisible();
      });
    });
  }
}
