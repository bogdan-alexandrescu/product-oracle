import { expect, test, type Page } from "./test";

import { BEFORE_DRAFTING } from "../lib/api/mock/intake";
import { feedbackState, login, openTab, showAll } from "./helpers";

/*
 * C5 late answers: an answer given after drafting started becomes a feedback item on the
 * draft, linked back to its question, so the next draft takes it. The "late-answers" mock
 * scenario is "before-drafting" with its brief drafting into the Checkout redesign PRD: the
 * answers given by then are the draft run's; admin@example.com still has two questions.
 *
 * Test card: protects=a late answer reaches the PRD's feedback and leads back to its
 * question; fails_when=no item appears, "I don't know" makes one, the inspector does not say
 * so, or the item's link misses the question; no_claim=what the next draft writes, the
 * draft's import raising the answers given while it was written (api
 * tests/test_late_answers_feedback.py).
 */

const ANSWER_ME = "Which metric shows this worked, what is its value today, and what target by when?";
const REPLY = "Repeat checkout time: 95 s today, 45 s by March.";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("po-mock-scenario", "late-answers");
    localStorage.setItem("po-interview-follow-up", "off");
  });
});

const drafting = (page: Page) => page.getByTestId("intake-inspector").filter({ visible: true }).getByTestId("answers-since");
const bubble = (page: Page, prompt: string) => page.getByTestId("intake-thread").getByTestId("question").filter({ hasText: prompt });

test("a late answer becomes feedback on the PRD and links back to its question", async ({ page }) => {
  await login(page);
  await page.goto(`/intakes/${BEFORE_DRAFTING.intakeId}`);
  await expect(page.getByTestId("intake-thread")).toBeVisible();
  await expect(drafting(page)).toContainText("0 answers since drafting started");
  await expect(drafting(page).getByTestId("late-answers-feedback")).toHaveCount(0);

  const mine = bubble(page, ANSWER_ME);
  await mine.getByRole("button", { name: "Answer", exact: true }).click();
  const form = mine.getByTestId("answer-question");
  await form.getByLabel("Your answer").fill(REPLY);
  await form.getByRole("button", { name: "Send answer" }).click();
  await expect(mine.getByTestId("answer")).toContainText(REPLY);
  await expect(drafting(page)).toContainText("1 answer since drafting started");
  await expect(drafting(page).getByTestId("late-answers-feedback")).toContainText("1 became feedback for the next draft");

  // "I don't know" is counted but makes no feedback item.
  const other = page.getByTestId("intake-thread").getByTestId("question").filter({ hasText: "Asked you" }).filter({ hasNot: page.getByTestId("answer") }).first();
  await other.getByRole("button", { name: "Answer", exact: true }).click();
  await other.getByTestId("answer-question").getByRole("button", { name: /^I don't know/ }).click();
  await expect(drafting(page)).toContainText("2 answers since drafting started");
  await expect(drafting(page).getByTestId("late-answers-feedback")).toContainText("1 became feedback for the next draft");

  // The PRD's Feedback lists it as a whole-draft item, open.
  await drafting(page).getByRole("link", { name: "Open the PRD's feedback" }).click();
  await expect(page).toHaveURL(/\/documents\/checkout-redesign\/v\/\d+\?feedback=open/);
  await openTab(page, "Feedback");
  await feedbackState(page, "Open");
  const item = page.getByTestId("feedback-item").filter({ visible: true }).filter({ hasText: REPLY });
  await expect(item).toHaveCount(1);
  await expect(item).toContainText(`Answered after drafting started: ${ANSWER_ME} ${REPLY}`);
  await expect(item).toContainText("General");

  // Back to its question on the brief.
  await item.getByTestId("feedback-from-question").click();
  await expect(page).toHaveURL(new RegExp(`/intakes/${BEFORE_DRAFTING.intakeId}#q-`));
  const id = new URL(page.url()).hash.slice(1);
  await expect(page.locator(`[id="${id}"]`)).toContainText(ANSWER_ME);
  await expect(page.locator(`[id="${id}"]`)).toBeInViewport();
});

/*
 * #587 review MAJOR 2: the item quotes the answer only while its finding is shared from summary
 * up. Set back to private (or counts), the item leaves the PRD's feedback; shared in full again,
 * it comes back, once. The success-metric gap is the owner's finding shared in full.
 *
 * Test card: protects=an answer to a finding its author takes back is no longer quoted to PRD
 * readers; fails_when=the item stays listed after the finding goes private, or does not come
 * back when shared again; no_claim=what the draft already took (api
 * tests/test_late_answers_feedback.py covers counts and an answer given while private).
 */
test("a late answer leaves the PRD's feedback when its finding goes back to private", async ({ page }) => {
  await login(page);
  await page.goto(`/intakes/${BEFORE_DRAFTING.intakeId}`);
  const mine = bubble(page, ANSWER_ME);
  await mine.getByRole("button", { name: "Answer", exact: true }).click();
  await mine.getByTestId("answer-question").getByLabel("Your answer").fill(REPLY);
  await mine.getByTestId("answer-question").getByRole("button", { name: "Send answer" }).click();
  await expect(drafting(page).getByTestId("late-answers-feedback")).toContainText("1 became feedback for the next draft");

  const level = async (name: "Private" | "Full") => {
    await page.getByRole("tab", { name: /^Findings/ }).click();
    const finding = page.getByTestId("intake-findings").getByTestId("finding").filter({ hasText: "checkout timing export" });
    await finding.getByRole("group", { name: "Who sees this finding" }).getByRole("button", { name }).click();
    await expect(finding.getByRole("button", { name })).toHaveAttribute("aria-pressed", "true");
  };
  const listed = async () => {
    await page.goto("/documents/checkout-redesign");
    await openTab(page, "Feedback");
    await feedbackState(page, "Open");
    await showAll(page);
    // Loaded: the open comment on the address cards is listed whatever the late answer does.
    await expect(page.getByTestId("feedback-item").filter({ visible: true }).filter({ hasText: "most recently used address" })).toHaveCount(1);
    return page.getByTestId("feedback-item").filter({ visible: true }).filter({ hasText: REPLY });
  };
  await expect(await listed()).toHaveCount(1);

  await page.goto(`/intakes/${BEFORE_DRAFTING.intakeId}`);
  await level("Private");
  await page.reload();
  await expect(drafting(page).getByTestId("late-answers-feedback")).toHaveCount(0);
  await expect(await listed()).toHaveCount(0);

  await page.goto(`/intakes/${BEFORE_DRAFTING.intakeId}`);
  await level("Full");
  await page.reload();
  await expect(drafting(page).getByTestId("late-answers-feedback")).toContainText("1 became feedback for the next draft");
  await expect(await listed()).toHaveCount(1);
});
