import { readFile } from "node:fs/promises";

import { expect, test, type Page } from "./test";

import { BEFORE_DRAFTING } from "../lib/api/mock/intake";
import { feedbackState, login, openSection, openTab, sectionAction, showAll } from "./helpers";

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
    await page.goto("/documents/checkout-redesign/v/2");
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

/*
 * #595 re-review: a late answer someone acted on stays on the PRD when its finding goes
 * back to private: it keeps its triage (here a Decline with a note) and only its quote is
 * withheld; shared again, it reads in full.
 *
 * Test card: protects=what others did on a late answer survives a change of level;
 * fails_when=the declined item disappears, or still quotes the answer while private, or
 * does not read in full once shared again; no_claim=suggestions on it (api
 * tests/test_late_answers_feedback.py covers the rule).
 */
test("a late answer someone declined stays, its quote withheld, while its finding is private", async ({ page }) => {
  await login(page);
  await page.goto(`/intakes/${BEFORE_DRAFTING.intakeId}`);
  const mine = bubble(page, ANSWER_ME);
  await mine.getByRole("button", { name: "Answer", exact: true }).click();
  await mine.getByTestId("answer-question").getByLabel("Your answer").fill(REPLY);
  await mine.getByTestId("answer-question").getByRole("button", { name: "Send answer" }).click();
  await expect(drafting(page).getByTestId("late-answers-feedback")).toContainText("1 became feedback for the next draft");

  await page.goto("/inbox");
  const late = page.getByTestId("inbox-tab-new").getByTestId("inbox-feedback").locator("tr[data-row]").filter({ hasText: REPLY });
  await late.getByRole("button", { name: "Decline", exact: true }).click();
  await late.getByLabel("Why? (optional)").fill("Settled in the security review.");
  await late.getByRole("button", { name: "Decline", exact: true }).click();
  await expect(page.getByTestId("inbox-acted")).toContainText("Declined");

  const level = async (name: "Private" | "Full") => {
    await page.goto(`/intakes/${BEFORE_DRAFTING.intakeId}`);
    await page.getByRole("tab", { name: /^Findings/ }).click();
    const finding = page.getByTestId("intake-findings").getByTestId("finding").filter({ hasText: "checkout timing export" });
    await finding.getByRole("group", { name: "Who sees this finding" }).getByRole("button", { name }).click();
    await expect(finding.getByRole("button", { name })).toHaveAttribute("aria-pressed", "true");
  };
  const declined = async () => {
    await page.goto("/documents/checkout-redesign/v/2");
    await openTab(page, "Feedback");
    await feedbackState(page, "Declined");
    await showAll(page);
    return page.getByTestId("feedback-item").filter({ visible: true }).filter({ hasText: "Settled in the security review." });
  };

  await level("Private");
  const kept = await declined();
  await expect(kept).toHaveCount(1);
  await expect(kept).toContainText("withheld while its finding is not shared in full");
  await expect(kept).not.toContainText(REPLY);

  await level("Full");
  await expect(await declined()).toContainText(REPLY);
});

/*
 * #636 re-review MAJOR 1: Oracle's suggestion on a late answer was written from the
 * summary that quoted it, and an approver's accepted text may restate it too. While the
 * finding is private the kept item withholds them with its quote; shared in full again,
 * they read in full.
 *
 * Test card: protects=a private answer is not read through the suggestion on its kept item;
 * fails_when=the accepted answer text (or the note Accept wrote from it) still shows while
 * the finding is private, or does not show once it is shared in full again; no_claim=other
 * roles and outputs (api tests/test_late_answers_feedback.py lists Feedback, suggestions,
 * the Inbox and staged changes as a viewer, a commenter and an approver).
 */
test("a late answer's accepted suggestion is withheld with it while its finding is private", async ({ page }) => {
  const ACCEPTED = `Noted for Success metrics: ${REPLY}`;
  await login(page);
  await page.goto(`/intakes/${BEFORE_DRAFTING.intakeId}`);
  const mine = bubble(page, ANSWER_ME);
  await mine.getByRole("button", { name: "Answer", exact: true }).click();
  await mine.getByTestId("answer-question").getByLabel("Your answer").fill(REPLY);
  await mine.getByTestId("answer-question").getByRole("button", { name: "Send answer" }).click();
  await expect(drafting(page).getByTestId("late-answers-feedback")).toContainText("1 became feedback for the next draft");

  // Oracle's review answered it; the approver accepts an edited answer restating it.
  await page.goto("/documents/checkout-redesign/v/2");
  await openTab(page, "Feedback");
  await feedbackState(page, "Open");
  const open = page.getByTestId("feedback-item").filter({ visible: true }).filter({ hasText: REPLY });
  await open.getByRole("button", { name: "Edit and accept" }).click();
  await open.getByLabel("Answer").fill(ACCEPTED);
  await open.getByRole("button", { name: "Accept edited text" }).click();
  await expect(open).toContainText(`Resolution: Answered: ${ACCEPTED}`);

  const level = async (name: "Private" | "Full") => {
    await page.goto(`/intakes/${BEFORE_DRAFTING.intakeId}`);
    await page.getByRole("tab", { name: /^Findings/ }).click();
    const finding = page.getByTestId("intake-findings").getByTestId("finding").filter({ hasText: "checkout timing export" });
    await finding.getByRole("group", { name: "Who sees this finding" }).getByRole("button", { name }).click();
    await expect(finding.getByRole("button", { name })).toHaveAttribute("aria-pressed", "true");
  };
  const done = async () => {
    await page.goto("/documents/checkout-redesign/v/2");
    await openTab(page, "Feedback");
    await feedbackState(page, "Done");
    await showAll(page);
    return page.getByTestId("feedback-item").filter({ visible: true }).filter({ hasText: "Answered after drafting started" });
  };
  await expect((await done()).getByTestId("suggestion-text")).toContainText(ACCEPTED);

  await level("Private");
  const kept = await done();
  await expect(kept).toHaveCount(1);
  await expect(kept).toContainText("withheld while its finding is not shared in full");
  await expect(kept.getByTestId("suggestion")).toBeVisible();
  await expect(kept).toContainText("Resolution: Withheld while its finding is not shared in full");
  await expect(kept).not.toContainText(REPLY);

  await level("Full");
  await expect((await done()).getByTestId("suggestion-text")).toContainText(ACCEPTED);
});

test("a late answer's lines in a version's reports and their export are withheld while its finding is private", async ({ page }) => {
  const ACCEPTED = `Noted for Success metrics: ${REPLY}`;
  await login(page);
  await page.goto(`/intakes/${BEFORE_DRAFTING.intakeId}`);
  const mine = bubble(page, ANSWER_ME);
  await mine.getByRole("button", { name: "Answer", exact: true }).click();
  await mine.getByTestId("answer-question").getByLabel("Your answer").fill(REPLY);
  await mine.getByTestId("answer-question").getByRole("button", { name: "Send answer" }).click();
  await expect(drafting(page).getByTestId("late-answers-feedback")).toContainText("1 became feedback for the next draft");

  // The answer is accepted on v2, then a refinement makes v3, whose reports read the item.
  await page.goto("/documents/checkout-redesign/v/2");
  await openTab(page, "Feedback");
  await feedbackState(page, "Open");
  const open = page.getByTestId("feedback-item").filter({ visible: true }).filter({ hasText: REPLY });
  await open.getByRole("button", { name: "Edit and accept" }).click();
  await open.getByLabel("Answer").fill(ACCEPTED);
  await open.getByRole("button", { name: "Accept edited text" }).click();
  await expect(open).toContainText(`Resolution: Answered: ${ACCEPTED}`);
  const users = await openSection(page, "users");
  await sectionAction(users, "3. Users and jobs", /^Ask Oracle to rewrite/);
  const refine = users.getByTestId("refine-panel");
  await refine.getByLabel("Instruction").fill("Name the first-time buyer segment explicitly.");
  await refine.getByRole("button", { name: "Refine", exact: true }).click();
  await refine.getByRole("button", { name: "Accept as next version" }).click();
  await expect(page).toHaveURL(/\/documents\/checkout-redesign\/v\/3/);

  const reports = async () => {
    await page.goto("/documents/checkout-redesign/v/3");
    await openTab(page, "History");
    const panel = page.getByTestId("reports-panel").filter({ visible: true });
    await panel.getByRole("tab", { name: "Resolution report" }).click();
    return panel;
  };
  const exported = async (panel: Awaited<ReturnType<typeof reports>>) => {
    const download = page.waitForEvent("download");
    await panel.getByRole("button", { name: "Export reports MD" }).click();
    return readFile((await (await download).path())!, "utf8");
  };
  let panel = await reports();
  await expect(panel.getByRole("region", { name: "Resolution report" })).toContainText(REPLY);
  expect(await exported(panel)).toContain(REPLY);

  await page.goto(`/intakes/${BEFORE_DRAFTING.intakeId}`);
  await page.getByRole("tab", { name: /^Findings/ }).click();
  const finding = page.getByTestId("intake-findings").getByTestId("finding").filter({ hasText: "checkout timing export" });
  await finding.getByRole("group", { name: "Who sees this finding" }).getByRole("button", { name: "Private" }).click();
  await expect(finding.getByRole("button", { name: "Private" })).toHaveAttribute("aria-pressed", "true");

  panel = await reports();
  const resolution = panel.getByRole("region", { name: "Resolution report" });
  await expect(resolution).toContainText("Answered after drafting started (withheld while its finding is not shared in full)");
  // The narrative was written from every line, so it is withheld with this one.
  await expect(resolution).toContainText("the rest of this summary is withheld while one of them is not shared in full");
  await expect(resolution).not.toContainText(REPLY);
  const md = await exported(panel);
  expect(md).toContain("Answered after drafting started (withheld while its finding is not shared in full)");
  expect(md).not.toContain(REPLY);
});
