import { expect, test, type Page } from "./test";

import { login, openSection, sectionAction } from "./helpers";

/**
 * #574's review (MAJOR 1): a change sent to a running agents run is not built twice. While the
 * agents' run is under way, what it was sent is listed as in that run (not ticked, not counted
 * in "· N staged"), after a reload too, and no second build of the document starts.
 *
 * Fixture ("next-draft" scenario): the fleet PRD on draft 2 with two accepted section-text
 * changes (F-33, F-34) and a whole-draft remark staged for the agents. The test starts a
 * discussion on the Problem section, and an approver stages Oracle's section edit from the
 * card under the thread, as a person would.
 */
const DOC = "/documents/fleet-next/v/2";
const EDIT = "Edit problem: say that detection follows once activation holds";
const INSTRUCTION = "Say that detection follows once activation holds.";

const thread = (page: Page) => page.getByTestId("discussion-thread").filter({ visible: true });
const card = (page: Page) => thread(page).getByTestId("changes-card");
const buildButton = (page: Page) => page.getByTestId("build-draft").filter({ visible: true });
const sheet = (page: Page) => page.getByTestId("next-draft-sheet");
const count = (page: Page) => buildButton(page).getByTestId("build-draft-count");

/** Starts a discussion on the Problem section, asks Oracle, and stages its edit of Problem. */
async function stageFromDiscussion(page: Page) {
  const s = await openSection(page, "problem");
  await sectionAction(s, "Problem", "Discuss this section");
  await page.getByTestId("start-discussion").filter({ visible: true }).getByRole("button", { name: "Start discussion" }).click();
  await expect(thread(page)).toBeVisible();
  await thread(page).getByRole("textbox", { name: "Message" }).fill("Does detection have to ship first?");
  await thread(page).getByRole("button", { name: "Send" }).click();
  await expect(thread(page).getByTestId("oracle-reply").last()).toHaveAttribute("data-status", "complete");
  await card(page).getByTestId("change-row").filter({ hasText: EDIT }).getByRole("button", { name: "Stage" }).click();
  await expect(card(page).getByTestId("changes-handled").locator("summary")).toHaveText("1 handled");
}

// Card in-run-after-reload: protects = once Build next draft sends the agents a section change
// staged through the discussion card, a reload of the document lists it as in that run (with
// its link), counts only what is still staged, and Build cannot send it (or anything) again
// while the run is under way; fails_when = the change still shows ticked as staged, is counted
// in "· N staged", or a second build can start (the change would be made twice); no_claim =
// what the agents write (the mock's runtime stands in), the API's 409
// (api/tests/test_next_draft_engine.py).
test("a change sent to the running agents run shows as in that run and cannot be built again", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("po-mock-scenario", "next-draft"));
  await login(page);
  await page.goto(DOC);
  await expect(count(page)).toHaveText("· 3 staged");
  await stageFromDiscussion(page);
  await expect(count(page)).toHaveText("· 4 staged");

  // Build draft 3 with the agents, leaving F-34's text change staged.
  await buildButton(page).click();
  const s = sheet(page);
  const row = s.getByTestId("discussion-item");
  await expect(row).toContainText(INSTRUCTION);
  await expect(row.getByRole("checkbox")).toBeChecked();
  await s.getByTestId("staged-list").getByRole("checkbox", { name: /^Include F-34/ }).uncheck();
  await s.getByRole("button", { name: "Build draft 3" }).click();
  await expect(page).toHaveURL(/\/runs\/[0-9a-f-]+$/);
  const runUrl = new URL(page.url()).pathname;
  await expect(page.getByTestId("run-status").filter({ visible: true })).toHaveText("Running");

  await page.goto(DOC);
  await page.reload();
  await expect(count(page)).toHaveText("· 1 staged");
  await buildButton(page).click();
  const inRun = sheet(page).getByTestId("in-run-list");
  await expect(inRun.getByTestId("in-run-item")).toHaveCount(3);
  const sent = inRun.getByTestId("in-run-item").filter({ hasText: INSTRUCTION });
  await expect(sent.getByRole("checkbox")).toHaveCount(0);
  await expect(sent.getByTestId("in-run-chip")).toHaveText(/^In run · Feedback loop · /);
  await expect(sheet(page).getByTestId("discussion-item")).toHaveCount(0);
  await expect(sheet(page).getByTestId("staged-item")).toHaveCount(1);
  await expect(sheet(page).getByTestId("pick-count")).toHaveText("1");
  const notice = sheet(page).getByTestId("agents-run-notice");
  await expect(notice).toContainText("The agents' run on this document is under way");
  await expect(notice.getByRole("link", { name: "Open the run" })).toHaveAttribute("href", runUrl);
  await expect(sheet(page).getByRole("button", { name: "Build draft 3" })).toBeDisabled();
});
