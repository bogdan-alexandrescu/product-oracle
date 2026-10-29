import { login, signOut } from "./helpers";
import { expect, test, type Page } from "./test";

/**
 * prd-questions: a PRD's open questions read in as decisions, driven through Simple's UI on
 * the mock's invented PRD "Guided setup" (Q1..Q16, ./lib/api/mock/simple-questions.ts; the
 * mock's today is Thu 22 Oct 2026), desktop and phone, light and dark.
 */

const region = (page: Page, name: string) => page.getByRole("region", { name, exact: true });
/** "Waiting for you" says its count in the yellow chip beside its title (none when nothing waits). */
async function waiting(page: Page, n: number) {
  const chip = region(page, "Waiting for you").getByTestId("questions-mine-count");
  if (n > 0) await expect(chip).toHaveText(String(n));
  else await expect(chip).toHaveCount(0);
}
/** A decision taken outside meetings (a PRD's question keeps its code). */
const outside = (page: Page, code: string) => region(page, "Outside meetings").getByTestId("decision-row").filter({ hasText: new RegExp(`^${code} `) });
const row = (page: Page, code: string) => page.getByTestId("question-row").filter({ visible: true }).and(page.locator(`[data-code="${code}"]`));

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
       * Card questions-list: protects = List is the default view; "Waiting for you" with its count
       * chip lists the questions I decide, soonest first, a late one in the late tone with its due
       * label, what it blocks and what the PRD recommends; the first five, then "Show N more"; then
       * waiting for others, the meetings, a decided question outside meetings (its code and answer)
       * and the run-approvals note; fails_when = a count, the order, the late label or a section is
       * wrong or missing, or Ask Oracle does not open the Ask panel with the question in its box;
       * no_claim = the real API's due-day maths.
       */
      test("List: waiting for you, a late row, Show N more, others and decided", async ({ page }) => {
        await decisions(page);
        await expect(page.getByRole("group", { name: "Show decisions as" }).getByRole("button", { name: "List" })).toHaveAttribute("aria-pressed", "true");
        const mine = region(page, "Waiting for you");
        await expect(mine.getByRole("heading", { name: "Waiting for you" })).toBeVisible();
        await waiting(page, 9);
        await expect(mine.getByTestId("question-row")).toHaveCount(5);
        const first = mine.getByTestId("question-row").first();
        await expect(first).toContainText("Q5 Reminder default time");
        await expect(first.getByTestId("question-due")).toHaveText("Late · due Fri Oct 16");
        await expect(first.getByTestId("question-due")).toHaveAttribute("data-late", "true");
        await expect(first).toContainText("Blocks M1: F-03 Health log");
        await expect(first).toContainText("PRD recommends 9:00 in each person's zone");
        await expect(mine.getByTestId("question-row").nth(1).getByTestId("question-due")).toHaveText("Due Mon Oct 26");
        await mine.getByRole("button", { name: "Show 4 more" }).click();
        await expect(mine.getByTestId("question-row")).toHaveCount(9);
        await expect(mine.getByTestId("question-row").last()).toContainText("Q16 Self-serve plan cancel");
        await expect(region(page, "Waiting for others")).toContainText("Q7 Legal input on health notes");
        await expect(region(page, "Waiting for others")).toContainText("No decider yet");
        await expect(outside(page, "Q1")).toContainText("Q1 Data retention period");
        await expect(outside(page, "Q1")).toContainText("Keep 90 days · Admin");
        await expect(page.getByTestId("decisions-approvals")).toContainText("1 approval for Oracle's own work waits in your Inbox.");
        await expect(page.getByTestId("decisions-approvals").getByRole("link", { name: "Open the Inbox" })).toBeVisible();
        await expect(region(page, "Review: Usage alerts")).toBeVisible();
        // Ask Oracle opens Simple's Ask panel with the question in its box.
        await row(page, "Q5").getByRole("button", { name: "Ask Oracle" }).click();
        await expect(page.getByRole("textbox", { name: "Message Oracle" }).filter({ visible: true })).toHaveValue(/^Q5 Reminder default time in Guided setup: what should we decide\?/);
      });

      /**
       * Card questions-board: protects = Board shows Needs input, Recommended and Decided with
       * their counts (one column at a time behind tabs on a phone); "Name a decider" picks a person
       * and the question moves to Recommended; the view is remembered after a reload; fails_when =
       * a column, a count, the phone tabs, the picker or the remembered view is wrong;
       * "Name a person" on a question with no recommendation names who answers it;
       * no_claim = Ask Oracle's reply.
       */
      test("Board: columns (tabs on a phone), Name a decider, remembered after reload", async ({ page }) => {
        await decisions(page);
        await page.getByRole("group", { name: "Show decisions as" }).getByRole("button", { name: "Board" }).click();
        const needs = page.getByTestId("board-needs_input");
        const recommended = page.getByTestId("board-recommended");
        const decided = page.getByTestId("board-decided");
        await expect(needs).toContainText("Needs input 3");
        if (phone) {
          await expect(needs).toBeVisible();
          await expect(recommended).toBeHidden();
          await page.getByTestId("board-tab-recommended").click();
          await expect(recommended).toBeVisible();
          await expect(needs).toBeHidden();
          await expect(recommended.getByTestId("question-row")).toHaveCount(12);
          await page.getByTestId("board-tab-decided").click();
          await expect(decided).toContainText("Q1 Data retention period");
          await page.getByTestId("board-tab-needs_input").click();
        } else {
          await expect(recommended).toContainText("Recommended 12");
          await expect(decided).toContainText("Decided questions 1");
          await expect(needs).toBeVisible();
          await expect(recommended).toBeVisible();
          await expect(decided).toBeVisible();
        }
        const q2 = needs.locator('[data-code="Q2"]');
        const q3 = needs.locator('[data-code="Q3"]');
        await q3.getByRole("button", { name: "Ask someone to answer" }).click();
        await q3.getByRole("group", { name: "Who answers Q3" }).getByRole("button", { name: "Approver", exact: true }).click();
        await expect(page.getByText("Approver decides Q3")).toBeVisible();
        await expect(needs.locator('[data-code="Q3"]')).toContainText("Approver decides");
        await q2.getByRole("button", { name: "Name a decider" }).click();
        await q2.getByRole("group", { name: "Who decides Q2" }).getByRole("button", { name: "Approver" }).click();
        await expect(page.getByText("Approver decides Q2")).toBeVisible();
        await expect(needs.locator('[data-code="Q2"]')).toHaveCount(0);
        await expect(recommended.locator('[data-code="Q2"]')).toContainText("Approver decides");

        await page.reload();
        await expect(page.getByRole("group", { name: "Show decisions as" }).getByRole("button", { name: "Board" })).toHaveAttribute("aria-pressed", "true");
        await expect(needs).toBeVisible();
        await page.getByRole("group", { name: "Show decisions as" }).getByRole("button", { name: "By meeting" }).click();
        await expect(region(page, "Review: Usage alerts")).toBeVisible();
        await expect(page.getByTestId("question-row")).toHaveCount(0);
      });

      /**
       * Card questions-decide: protects = an owner (and the decider) applies "Decide as
       * recommended" at once, with an Undo that brings it back; a commenter's "Propose as
       * recommended" is sent to the decider; a viewer sees no button to decide or propose;
       * fails_when = the role's button, the result or Undo is wrong; no_claim = the API's checks.
       */
      test("Decide as recommended: applied with Undo, proposed by a commenter, read by a viewer", async ({ page }) => {
        await decisions(page);
        const mine = region(page, "Waiting for you");
        await row(page, "Q5").getByRole("button", { name: "Decide as recommended" }).click();
        await expect(page.getByText("Decided Q5: 9:00 in each person's zone")).toBeVisible();
        await waiting(page, 8);
        await expect(outside(page, "Q5")).toContainText("9:00 in each person's zone");
        await page.getByRole("button", { name: "Undo" }).click();
        await waiting(page, 9);
        await expect(mine.locator('[data-code="Q5"]')).toBeVisible();
        await expect(outside(page, "Q5")).toHaveCount(0);

        // The decider (an approver) applies their own question.
        await decisions(page, "approver@example.com", true);
        await waiting(page, 4);
        await row(page, "Q7").getByRole("button", { name: "Decide as recommended" }).click();
        await expect(page.getByText("Decided Q7: Ask outside counsel")).toBeVisible();
        await waiting(page, 3);

        await decisions(page, "commenter@example.com", true);
        await waiting(page, 0);
        await expect(page.getByRole("button", { name: "Decide as recommended" })).toHaveCount(0);
        await row(page, "Q6").getByRole("button", { name: "Propose as recommended" }).click();
        await expect(page.getByText("Sent to Admin to decide")).toBeVisible();
        await expect(row(page, "Q6").getByTestId("question-pending")).toHaveText("Commenter proposed: 5 invites");

        await decisions(page, "viewer@example.com", true);
        await expect(region(page, "Waiting for others")).toContainText("Q5 Reminder default time");
        await expect(page.locator("main").getByRole("button", { name: /Decide|Propose|Another answer|Name a/ })).toHaveCount(0);
      });

      /**
       * Card questions-another: protects = "Another answer" offers the PRD's alternatives as chips
       * under "Another answer:" and "Something else…" (a field and Decide); either decides the
       * question with that answer, which then shows outside meetings;
       * fails_when = an alternative is missing, or the answer recorded is not the one chosen;
       * no_claim = how the API words the decision.
       */
      test("Another answer: an alternative, and Something else…", async ({ page }) => {
        await decisions(page);
        await row(page, "Q5").getByRole("button", { name: "Another answer" }).click();
        await expect(row(page, "Q5").getByRole("button", { name: "Another answer" })).toHaveAttribute("aria-pressed", "true");
        await expect(row(page, "Q5").getByTestId("question-answers")).toContainText("Another answer:");
        await row(page, "Q5").getByRole("group", { name: "Answers for Q5" }).getByRole("radio", { name: "Noon" }).click();
        await expect(page.getByText("Decided Q5: Noon")).toBeVisible();
        await expect(outside(page, "Q5")).toContainText("Noon · Admin");

        await row(page, "Q6").getByRole("button", { name: "Another answer" }).click();
        await row(page, "Q6").getByRole("radio", { name: "Something else…" }).click();
        await row(page, "Q6").getByLabel("Your answer to Q6").fill("Ten invites");
        await row(page, "Q6").getByRole("button", { name: "Decide", exact: true }).click();
        await expect(outside(page, "Q6")).toContainText("Ten invites · Admin");
        await waiting(page, 7);
      });

      /**
       * Card questions-home: protects = Home's "Decisions waiting for you" counts what
       * /v1/simple/decisions/waiting counts, lists the late question first with its late due chip,
       * the same row as Decisions (Decide as recommended, Another answer, Ask Oracle), and the
       * summary line and the rail's Decisions count say the same number; deciding from Home lowers
       * all three; fails_when = the counts differ or the row is missing; no_claim = the Inbox's
       * other rows.
       */
      test("Home: the count, the late row first, the rail; Decide as recommended from Home", async ({ page }) => {
        await login(page);
        await page.goto("/simple");
        const card = page.getByTestId("home-decisions");
        const count = card.getByTestId("home-decisions-count");
        await expect(count).toHaveText(/^\d+$/);
        const n = Number(await count.textContent());
        expect(n).toBeGreaterThanOrEqual(9);
        await expect(page.getByTestId("home-summary-decisions")).toContainText(String(n));
        if (!phone) await expect(page.getByTestId("simple-nav-decisions-count")).toHaveText(String(n));
        const q5 = card.getByTestId("home-question").first();
        await expect(q5).toContainText("Q5 Reminder default time");
        await expect(q5.getByTestId("question-due")).toHaveText("Late · due Fri Oct 16");
        await expect(q5.getByTestId("question-due")).toHaveAttribute("data-late", "true");
        await expect(q5).toContainText("Blocks M1: F-03 Health log");
        await expect(q5.getByRole("button", { name: "Another answer" })).toBeVisible();
        await expect(q5.getByRole("button", { name: "Ask Oracle" })).toBeVisible();
        await q5.getByRole("button", { name: "Decide as recommended" }).click();
        await expect(page.getByText("Decided Q5: 9:00 in each person's zone")).toBeVisible();
        await expect(count).toHaveText(String(n - 1));
        await expect(card.locator('[data-late="true"]')).toHaveCount(0);
        if (!phone) await expect(page.getByTestId("simple-nav-decisions-count")).toHaveText(String(n - 1));
      });

      /**
       * Card questions-meeting: protects = a review meeting's Decisions step has "On the agenda":
       * the open questions due by the end of the milestone the soonest one blocks, whoever decides
       * them (code and title, due label, what it blocks); Decide as recommended there lands in the
       * meeting's decisions and the question stays on the agenda, decided, with Undo, which opens
       * it again; fails_when = the block is missing, a decided question leaves it or the decision
       * is not the meeting's; no_claim = the minutes' wording after End.
       */
      test("a review meeting's Decisions due, decided in the meeting", async ({ page }) => {
        await login(page);
        await page.goto("/simple/prds/guided-setup");
        await page.getByRole("button", { name: "Start review" }).click();
        await page.getByRole("dialog", { name: "Start a review" }).getByRole("button", { name: "Start", exact: true }).click();
        await expect(page.getByRole("heading", { name: "Review: Guided setup" })).toBeVisible();
        await page.getByRole("navigation", { name: "Steps" }).getByRole("button", { name: "3 Decisions" }).click();
        const due = region(page, "On the agenda");
        await expect(due.getByTestId("question-row").first()).toContainText("Q5 Reminder default time");
        await expect(due.getByTestId("question-row").first()).toContainText("Late · due Fri Oct 16");
        await expect(due.getByTestId("question-row").first()).toContainText("Blocks M1: F-03 Health log");
        // The PRD's open questions, whoever decides them (Q7 is the approver's), not only mine.
        await expect(due.locator('[data-code="Q7"]')).toContainText("Q7 Legal input on health notes");
        await due.getByTestId("question-row").first().getByRole("button", { name: "Decide as recommended" }).click();
        await expect(region(page, "All decisions")).toContainText("Decided Q5 Reminder default time: 9:00 in each person's zone");
        const q5 = due.locator('[data-code="Q5"]');
        await expect(q5.getByTestId("question-decided")).toContainText("Decided in this meeting: 9:00 in each person's zone · Admin ·");
        await q5.getByRole("button", { name: "Undo" }).click();
        await expect(q5.getByRole("button", { name: "Decide as recommended" })).toBeVisible();
        await expect(q5.getByTestId("question-due")).toHaveText("Late · due Fri Oct 16");
      });

      /**
       * Card prd-decisions-fidelity (the owner's pick A "Imported as decisions", frames A1-A4):
       * protects = the page reads as the mock-up: its lead; the compact List | Board | By meeting
       * switch at the filters' end (full width on a phone, never stretched across a desktop);
       * "Waiting for you" with its flag, count chip and "From Guided setup draft 3 · read Oct 21";
       * each row's buttons in a right-hand column (under the row on a phone); "Show 4 more" a
       * text link; the run-approvals note last; Home's card with the soonest three (two on a
       * phone); the meeting's "On the agenda" with "Due by Tue Nov 3 · 5 decisions · from Guided
       * setup draft 3", four rows and "1 more: Q9"; fails_when = a part is missing, placed
       * elsewhere or the switch spans the page; no_claim = pixel sizes beyond the layout.
       */
      test("A: Decisions, Home and the meeting's agenda as the mock-up draws them", async ({ page }) => {
        await decisions(page);
        await expect(page.getByText("What waits for you, soonest first. Then every decision, beside the meeting that took it.")).toBeVisible();
        const sw = page.getByRole("group", { name: "Show decisions as" });
        const swBox = (await sw.boundingBox())!;
        const prdBox = (await page.getByRole("combobox").first().boundingBox())!;
        if (phone) expect(swBox.width).toBeGreaterThan(340);
        else {
          expect(swBox.width).toBeLessThan(320);
          // On the filters' row, at its end.
          expect(Math.abs(swBox.y + swBox.height - (prdBox.y + prdBox.height))).toBeLessThan(8);
          expect(swBox.x).toBeGreaterThan(prdBox.x + 600);
        }
        const mine = region(page, "Waiting for you");
        await expect(mine.getByTestId("questions-source")).toHaveText("From Guided setup draft 3 · read Oct 21");
        await waiting(page, 9);
        const first = mine.getByTestId("question-row").first();
        const title = (await first.getByText("Reminder default time").boundingBox())!;
        const decide = (await first.getByRole("button", { name: "Decide as recommended" }).boundingBox())!;
        const firstBox = (await first.boundingBox())!;
        if (phone) {
          expect(decide.y).toBeGreaterThan(title.y + title.height);
          // qa-simple-decide-23: a compact row on a phone, not full-width buttons.
          expect(decide.width).toBeLessThan(firstBox.width - 4);
        } else {
          expect(decide.x).toBeGreaterThan(title.x + title.width);
          expect(Math.abs(decide.y - title.y)).toBeLessThan(24);
        }
        const more = mine.getByRole("button", { name: "Show 4 more" });
        await expect(more).toHaveCSS("border-top-width", "0px");
        const note = page.getByTestId("decisions-approvals");
        const outsideBox = (await region(page, "Outside meetings").boundingBox())!;
        expect((await note.boundingBox())!.y).toBeGreaterThan(outsideBox.y + outsideBox.height);
        await expect(note.getByRole("link", { name: "Open the Inbox" })).toBeVisible();

        await page.goto("/simple");
        const card = page.getByTestId("home-decisions");
        await expect(card.getByTestId("home-question")).toHaveCount(phone ? 2 : 3);
        await expect(card.getByTestId("home-more")).toHaveText(/^\d+ more ->$/);
        await expect(card.getByRole("link", { name: "All ->" })).toBeVisible();

        await page.goto("/simple/prds/guided-setup");
        await page.getByRole("button", { name: "Start review" }).click();
        await page.getByRole("dialog", { name: "Start a review" }).getByRole("button", { name: "Start", exact: true }).click();
        await expect(page.getByRole("heading", { name: "Review: Guided setup" })).toBeVisible();
        await page.getByRole("navigation", { name: "Steps" }).getByRole("button", { name: "3 Decisions" }).click();
        const due = region(page, "On the agenda");
        await expect(due.getByRole("heading", { name: "On the agenda" })).toBeVisible();
        await expect(due.getByTestId("decisions-due-summary")).toHaveText("Due by Tue Nov 3 · 5 decisions · from Guided setup draft 3");
        await expect(due.getByTestId("question-row")).toHaveCount(4);
        await due.getByRole("button", { name: "1 more: Q9" }).click();
        await expect(due.getByTestId("question-row")).toHaveCount(5);
        await expect(due.getByTestId("question-row").last()).toContainText("Q9 Onboarding checklist length");
      });
    });
  }
}
