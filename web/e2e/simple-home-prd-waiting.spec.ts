import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { QUESTIONS_NO_UNDO_SCENARIO } from "../lib/api/mock/simple-questions";
import { login } from "./helpers";
import { expect, test, type Page } from "./test";

/**
 * build-rundecide RD3 a "Waiting for you + agenda": the PRD questions a person owns wait on their
 * Simple Home in a card of the PRD's own ("Waiting for you: Guided setup"), decided with the
 * buttons Simple's questions already have; and every open question of the PRD is on its review
 * meeting's agenda, soonest first, whoever owns it. Driven through the UI on the mock's invented
 * questions (lib/api/mock/simple-questions.ts), desktop and phone.
 *
 * Card home-prd-waiting: protects = the card is headed "Waiting for you: <PRD>", says how many the
 * person owns and that they are also on its review meeting's agenda, lists the late one first, and
 * deciding one there ("Another answer", then an answer) lowers the Decisions count; the meeting's
 * agenda lists all 15 open questions, the approver's included; fails_when = the card is missing,
 * lists someone else's question, or the agenda leaves out a question of a later milestone;
 * no_claim = the Decisions page's own lists (simple-decisions-questions.spec.ts).
 *
 * build-rundecide review: protects = with only a PRD's questions waiting (the approver decides
 * their one other decision first), the Decisions tile still shows and takes the person to the
 * PRD's card; fails_when = the tile links to the Decisions card that is not drawn.
 *
 * vqa-simple-runs review: protects = a question decided on the card is shown as decided only
 * while Home is open: leaving through the nav and coming back reads the card again (the row is
 * gone, the count one lower); and a decision the API says cannot be undone gets no decided row
 * with an Undo, only the toast; fails_when = the decided row (with its Undo) comes back from
 * before, or is drawn with an Undo that cannot work.
 */

const region = (page: Page, name: string) => page.getByRole("region", { name, exact: true });
const nav = (page: Page, name: string) => page.getByRole("navigation", { name: "Simple" }).getByRole("link", { name, exact: true }).filter({ visible: true });

for (const phone of [false, true]) {
  test.describe(phone ? "phone" : "desktop", () => {
    test.use({ viewport: phone ? { width: 390, height: 844 } : { width: 1440, height: 900 } });

    test("Home: a PRD's questions you own wait in its own card; deciding one lowers the count", async ({ page }) => {
      await login(page);
      await page.goto("/simple");
      const card = region(page, "Waiting for you: Guided setup");
      await expect(card.getByRole("heading", { name: "Waiting for you: Guided setup" })).toBeVisible();
      await expect(card).toContainText("9 decisions you own · also on its review meeting's agenda");
      const rows = card.getByTestId("home-question");
      await expect(rows).toHaveCount(phone ? 2 : 3);
      await expect(rows.first()).toContainText("Reminder default time");
      await expect(rows.first().getByTestId("question-due")).toHaveAttribute("data-late", "true");
      await expect(rows.nth(1)).toContainText("Invite limit on the free plan");
      // Someone else's question (the approver's Q7) is not on my card.
      await expect(card).not.toContainText("Legal input on health notes");
      await expect(card.getByTestId("home-more")).toHaveText(`${phone ? 7 : 6} more ->`);

      const count = page.getByTestId("home-summary-decisions").locator(".simple-number");
      await expect(count).toHaveText(/^\d+$/);
      const n = Number(await count.textContent());
      const row = rows.filter({ hasText: "Invite limit on the free plan" });
      await row.getByRole("button", { name: "Another answer" }).click();
      await row.getByRole("group", { name: /^Answers for / }).getByRole("button", { name: "3 invites" }).click();
      await expect(count).toHaveText(String(n - 1));
      // vqa-simple-runs (RD3 a, frame "done"): the decided question stays where it was, with the
      // answer, who and when, and Undo in its row; the card still counts it.
      await expect(row.getByTestId("question-decided")).toHaveText(/^3 invites · Avery Stone · \w{3} \w{3} \d{1,2}, \d{1,2}:\d{2} [AP]M$/);
      await expect(row.getByRole("button", { name: "Another answer" })).toHaveCount(0);
      await expect(card).toContainText("9 decisions you own · also on its review meeting's agenda");
      await expect(page.getByText(/Decided Q6: 3 invites/)).toHaveCount(0);
      // Undo puts it back as it was, to decide again.
      await row.getByRole("button", { name: "Undo" }).click();
      await expect(row.getByRole("button", { name: "Another answer" })).toBeVisible();
      await expect(count).toHaveText(String(n));
    });

    test("a question decided on the card is not shown decided again after leaving Home and coming back", async ({ page }) => {
      await login(page);
      await page.goto("/simple");
      const card = region(page, "Waiting for you: Guided setup");
      await expect(card).toContainText("9 decisions you own · also on its review meeting's agenda");
      const row = card.getByTestId("home-question").filter({ hasText: "Invite limit on the free plan" });
      await row.getByRole("button", { name: "Another answer" }).click();
      await row.getByRole("group", { name: /^Answers for / }).getByRole("button", { name: "3 invites" }).click();
      await expect(row.getByTestId("question-decided")).toBeVisible();

      await nav(page, "Decisions").click();
      await expect(page).toHaveURL(/\/simple\/decisions/);
      await nav(page, "Home").click();
      await expect(page).toHaveURL(/\/simple$/);
      await expect(card).toContainText("8 decisions you own · also on its review meeting's agenda");
      await expect(card).not.toContainText("Invite limit on the free plan");
      await expect(card.getByTestId("question-decided")).toHaveCount(0);
      await expect(card.getByRole("button", { name: "Undo" })).toHaveCount(0);
    });

    test("a decision that cannot be undone gets the toast, not a decided row with Undo", async ({ page }) => {
      await page.context().addInitScript(([key, value]) => localStorage.setItem(key, value), [MOCK_SCENARIO_KEY, QUESTIONS_NO_UNDO_SCENARIO] as const);
      await login(page);
      await page.goto("/simple");
      const card = region(page, "Waiting for you: Guided setup");
      const row = card.getByTestId("home-question").filter({ hasText: "Invite limit on the free plan" });
      await row.getByRole("button", { name: "Another answer" }).click();
      await row.getByRole("group", { name: /^Answers for / }).getByRole("button", { name: "3 invites" }).click();
      await expect(page.getByText("Decided Q6: 3 invites")).toBeVisible();
      await expect(card).toContainText("8 decisions you own · also on its review meeting's agenda");
      await expect(card).not.toContainText("Invite limit on the free plan");
      await expect(card.getByTestId("question-decided")).toHaveCount(0);
      await expect(card.getByRole("button", { name: "Undo" })).toHaveCount(0);
    });

    test("the Decisions tile goes to the PRD's card when only its questions wait", async ({ page }) => {
      await login(page, "approver@example.com");
      await page.goto("/simple");
      const card = region(page, "Waiting for you: Guided setup");
      await expect(card).toBeVisible();
      // Decide the approver's one other decision: the Decisions card goes, the PRD's card stays.
      const other = page.getByTestId("home-decisions").getByTestId("home-decision");
      await expect(other).toHaveCount(1);
      await other.getByRole("button", { name: /^Decide: / }).click();
      await expect(page.getByTestId("home-decisions")).toHaveCount(0);
      await expect(card).toBeVisible();

      const tile = page.getByTestId("home-summary-decisions");
      await expect(tile).toBeVisible();
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await tile.click();
      await expect(page).toHaveURL(/#waiting-guided-setup$/);
      await expect(card).toBeInViewport();
      await expect(card.getByRole("heading", { name: "Waiting for you: Guided setup" })).toBeInViewport();
    });

    test("the PRD's review meeting: every open question on the agenda, soonest first", async ({ page }) => {
      await login(page);
      await page.goto("/simple/prds/guided-setup");
      // vqa-simple-runs: the PRD page's button reads "Start a review meeting" since train AH.
      await page.getByRole("button", { name: "Start a review meeting" }).click();
      await page.getByRole("dialog", { name: "Start a review" }).getByRole("button", { name: "Start", exact: true }).click();
      await expect(page.getByRole("heading", { name: "Review: Guided setup" })).toBeVisible();
      await page.getByRole("navigation", { name: "Steps" }).getByRole("button", { name: "3 Decisions" }).click();
      const due = region(page, "On the agenda");
      await expect(due.getByTestId("decisions-due-summary")).toContainText("15 decisions");
      await due.getByRole("button", { name: /^11 more: Q/ }).click();
      const rows = due.getByTestId("question-row");
      await expect(rows).toHaveCount(15);
      await expect(rows.first()).toContainText("Q5 Reminder default time");
      // Whoever owns it: the approver's, an unowned one, and the later milestones' questions.
      await expect(due.locator('[data-code="Q7"]')).toBeVisible();
      await expect(due.locator('[data-code="Q2"]')).toBeVisible();
      await expect(due.locator('[data-code="Q16"]')).toBeVisible();
      await expect(rows.last()).toContainText("Q16 Self-serve plan cancel");
    });
  });
}
