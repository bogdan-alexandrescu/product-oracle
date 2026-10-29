import { expect, test, type Page } from "./test";

import { MOCK_SCENARIO_KEY, STORED_REFUSALS_SCENARIO } from "../lib/api/mock/server";
import { login, openSection, openTab, sectionAction } from "./helpers";

/**
 * #561 review (MAJOR 1): every surface that shows a stored Claude-pool refusal says when it
 * failed, in the Company time zone, and words the refusal as what was so then: nothing on the
 * page says every account is spent now. The "stored-refusals" scenario: a feedback loop, its
 * segment, checkout-redesign v2's roadmap items and Clinic outreach's draft 6 build failed on
 * Oct 18 on a refusal stored before #403's wording; a refinement asked for now is refused.
 */
const FAILED = "Failed Oct 18, 4:12 PM PDT";
const THEN =
  "No Claude account could take this call: every Claude account was spent; the earliest window was due to clear Sun Oct 25, 3:00 PM PDT.";

async function noCurrentRefusal(page: Page) {
  const shown = page.locator("main");
  await expect(shown).not.toContainText("is spent");
  await expect(shown).not.toContainText("can take this call");
  await expect(shown).not.toContainText("2026-10-25T");
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(([key, value]) => localStorage.setItem(key, value), [MOCK_SCENARIO_KEY, STORED_REFUSALS_SCENARIO]);
  await login(page);
});

test("a failed run and its segment say when they failed, the refusal in the past", async ({ page }) => {
  await page.goto("/runs");
  await page.locator('[data-testid="run-row"][data-document="checkout-redesign"]').filter({ hasText: "Failed" }).getByRole("link").first().click();

  const notes = page.getByTestId("failed-at");
  await expect(notes).toHaveCount(2);
  await expect(notes).toHaveText([`${FAILED}.`, `${FAILED}.`]);
  // The run's note, then the segment's: when, then what was so.
  await expect(page.getByText(THEN)).toHaveCount(2);
  await noCurrentRefusal(page);
});

test("roadmap items that failed say when, the refusal in the past", async ({ page }) => {
  await page.goto("/documents/checkout-redesign/v/2/roadmap");
  const status = page.getByTestId("draft-roadmap-status").filter({ visible: true });
  await expect(status).toHaveAttribute("data-status", "failed");
  await expect(status.getByTestId("failed-at")).toHaveText(`${FAILED}.`);
  await expect(status).toContainText(`Oracle could not build the draft roadmap: ${THEN}`);
  await noCurrentRefusal(page);
});

test("a next-draft build that failed says when on its chip, the refusal in the past", async ({ page }) => {
  await page.goto("/documents/clinic-outreach/v/5");
  await page.getByTestId("build-draft").filter({ visible: true }).click();
  const sheet = page.getByTestId("next-draft-sheet");
  await expect(sheet.getByTestId("job-failed")).toHaveText(FAILED);
  await expect(sheet).toContainText(`${THEN} Every Claude account was out of quota when this ran.`);
  await expect(sheet).not.toContainText("is spent");
  await expect(sheet).not.toContainText("can take this call");
});

test("a refinement the pool refused says when it failed, the refusal in the past", async ({ page }) => {
  await page.goto("/documents/checkout-redesign/v/2");
  const users = await openSection(page, "users");
  await sectionAction(users, "3. Users and jobs", /^Refine section/);
  const refine = users.getByTestId("refine-panel");
  await refine.getByLabel("Instruction").fill("Name the first-time buyer segment explicitly.");
  await refine.getByRole("button", { name: "Refine", exact: true }).click();

  const status = users.getByTestId("refine-status");
  await expect(status.getByTestId("job-failed")).toHaveText(/^Failed Oct \d+, \d+:\d{2} [AP]M PDT$/);
  await expect(status).toContainText(`${THEN} Every Claude account was out of quota when this ran.`);
  await expect(status).not.toContainText("is spent");
});

test("an interview guide the pool refused says when it failed, the refusal in the past", async ({ page }) => {
  // #604 re-review (MAJOR 1, the last surface): the guide's failure notice reads its stored
  // refusal through the same rewrite as the other surfaces.
  await page.goto("/requests");
  await page.getByRole("button", { name: "Interview a customer" }).click();
  const dialog = page.getByRole("dialog", { name: "Interview a customer" });
  await dialog.getByLabel("Customer name").fill("Sam Okafor");
  await dialog.getByRole("button", { name: "A topic" }).click();
  await dialog.getByLabel("Topic in your words").fill("Paying suppliers");
  await dialog.getByRole("button", { name: "Next" }).click();

  const guide = page.getByRole("dialog", { name: "Draft questions" });
  const failed = guide.getByTestId("guide-failed");
  await expect(failed.getByTestId("failed-at")).toHaveText(/^Failed Oct \d+, \d+:\d{2} [AP]M PDT\.\s*$/);
  await expect(failed).toContainText(`Oracle could not draft the questions: ${THEN}`);
  await expect(guide.getByRole("button", { name: "Draft again" })).toBeVisible();
  await expect(guide).not.toContainText("is spent");
  await expect(guide).not.toContainText("can take this call");
  await expect(guide).not.toContainText("2026-10-25T");
});

test("a triage the pool refused says when it failed, the refusal in the past", async ({ page }) => {
  // #633 re-review (MAJOR 1 a): the Requests header's status line reads the run's stored
  // refusal as the run page does, with when it failed.
  await page.getByTestId("nav-requests").filter({ visible: true }).first().click();
  await page.getByTestId("triage-menu").click();
  await page.getByRole("button", { name: "Sort now", exact: true }).click();
  const status = page.getByTestId("triage-status");
  await expect(status.getByTestId("failed-at")).toHaveText(/^Failed Oct \d+, \d+:\d{2} [AP]M PDT\.\s*$/, { timeout: 15_000 });
  await expect(status).toContainText(`Oracle's last triage did not finish. Failed`);
  await expect(status).toContainText(`triage: ${THEN}`);
  await noCurrentRefusal(page);
});

test("a code map the pool refused says when it failed, the refusal in the past", async ({ page }) => {
  // #633 re-review (MAJOR 1 b): Settings › Sources' code map line reads the stored
  // "The code map run failed: …" through the same rewrite, with when it failed.
  await page.goto("/settings/sources");
  const line = page.getByRole("listitem", { name: "Example repo" }).getByTestId("code-map-example-org/example-app");
  await line.getByRole("button", { name: "Map the code" }).click();
  await expect(line.getByTestId("failed-at")).toHaveText(/^Failed Oct \d+, \d+:\d{2} [AP]M PDT\.\s*$/, { timeout: 15_000 });
  await expect(line).toContainText(`The code map run failed: index: ${THEN}`);
  await expect(line.getByRole("button", { name: "Map the code" })).toBeVisible();
  await noCurrentRefusal(page);
});

test("a discussion reply the pool refused reads the refusal in the past", async ({ page }) => {
  // #644 re-review (MAJOR 1): an approver opening a discussion whose Oracle reply failed on a
  // stored refusal reads it as what was so then, its time in words, not "is spent" now.
  await page.goto("/documents/team-workspaces/v/2");
  await openTab(page, "Feedback");
  const panel = page.getByRole("complementary", { name: "Review panel" }).filter({ visible: true });
  await panel.getByTestId("feedback-discussions").click();
  await panel.getByTestId("discussion-row").filter({ hasText: "Caps: ship without detection?" }).first().click();
  const thread = page.getByTestId("discussion-thread").filter({ visible: true });
  await expect(thread.getByTestId("oracle-reply").last().getByTestId("oracle-reply-error")).toHaveText(THEN);
  await expect(thread).not.toContainText("is spent");
  await expect(thread).not.toContainText("can take this call");
  await expect(thread).not.toContainText("2026-10-25T");
});
