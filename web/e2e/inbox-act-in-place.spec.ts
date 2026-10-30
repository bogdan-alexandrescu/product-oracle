import { expect, test, type Locator, type Page } from "./test";

import { feedbackState, login, openSection, openTab } from "./helpers";

/*
 * D14: the Inbox acts on Oracle's suggestions where they arrive. A feedback row offers
 * Accept (section text), Send answer (an answer), Close (nothing to change) or Merge (a
 * duplicate), with Decline and Open; a row without a suggestion offers Decline and Open.
 * The "suggestions" mock (inbox-feedback.spec.ts's seed) has every kind: Clinic outreach's
 * open metric request and the Fleet next version change requests (section text), Team
 * workspaces' custom roles (Oracle pushed back), its demand duplicate, a question Oracle
 * answered and a remark with nothing to change, and Checkout redesign's comment (none).
 */

async function suggestions(page: Page) {
  await page.addInitScript(() => localStorage.setItem("po-mock-scenario", "suggestions"));
  await login(page);
}

const tabs = (page: Page) => page.getByTestId("inbox-state-tabs");
const tab = (page: Page, name: string) => tabs(page).getByRole("tab", { name: new RegExp(`^${name}`) });
const tabCount = async (page: Page, name: string) => Number((await tab(page, name).innerText()).replace(/\D+/g, "") || "0");
// The rail's badge, or the phone tab bar's.
const badge = (page: Page) => page.getByTestId(/^(nav|tab)-inbox-badge$/).filter({ visible: true });
const feedbackRows = (page: Page, state: string) =>
  page.getByTestId(`inbox-tab-${state}`).getByTestId("inbox-feedback").locator("tr[data-row]");
const row = (page: Page, text: string, state = "new") => feedbackRows(page, state).filter({ hasText: text });
const notice = (page: Page) => page.getByTestId("inbox-acted");

const METRIC = "Add a metric that shows the outbound check works";
const ROLES = "Add custom roles to the first release";
const QUANTIFY = "Can we quantify the demand from the sales calls?";
const QUESTION = "Who can see a workspace's billing page?";
const REMARK = "The scope reads well as it is.";
const ADDRESS = "Should the most recently used address be selected by default?";
const DEPOT = "Depot handover needs a count check";
const FAILED = "Limit how many times a customer can move a failed delivery.";

async function inbox(page: Page) {
  await page.goto("/inbox");
  await expect(tab(page, "New")).toHaveAttribute("aria-selected", "true");
  await expect(row(page, METRIC)).toHaveCount(1);
  // A row draws only what the signed-in role may do (qa-company-3), so until the role's
  // capabilities load it offers Open alone: read the rows once they have.
  await expect(row(page, METRIC).getByRole("button", { name: "Accept", exact: true })).toBeVisible();
}

/** Buttons a row offers, in order, by their visible text. */
const buttons = (r: Locator) => r.locator("td").last().locator("button, a").allInnerTexts();

// Criteria 2-6 and 8 at the desktop and the phone width alike.
for (const [width, height] of [
  [1366, 820],
  [390, 844],
] as const) {
  test.describe(`${width} px`, () => {
    test.use({ viewport: { width, height } });

  test("Accept stages section text: the row moves to Staged as Draft N+1, Build draft counts it, the badge drops", async ({ page }) => {
    await suggestions(page);
    await inbox(page);
    const before = Number(await badge(page).innerText());
    const newBefore = await tabCount(page, "New");
    const metric = row(page, METRIC);
    expect(await buttons(metric)).toEqual(["Accept", "Decline", "Open"]);

    // Hover or focus the item: Oracle's suggested text in a popover.
    await metric.getByRole("link", { name: `${METRIC}.`, exact: true }).hover();
    const peek = metric.getByTestId("suggestion-peek");
    await expect(peek).toBeVisible();
    await expect(peek).toContainText("Calls blocked by the outbound check: counted weekly.");

    await metric.getByRole("button", { name: "Accept", exact: true }).click();
    await expect(notice(page)).toContainText("Staged for draft 6");
    // Undo after Accept (inbox-undo-accept.spec.ts drives it).
    await expect(notice(page).getByRole("button", { name: "Undo" })).toBeVisible();
    // No reload: the row left New, the counts and the badge follow.
    await expect(row(page, METRIC)).toHaveCount(0);
    await expect(tab(page, "New")).toHaveText(`New${newBefore - 1}`);
    await expect(badge(page)).toHaveText(String(before - 1));

    await tab(page, "Staged").click();
    const staged = page.getByTestId("inbox-tab-staged").locator("tr[data-row]");
    await expect(staged.filter({ hasText: METRIC })).toContainText("Draft 6");
    const docRow = staged.filter({ has: page.getByTestId("staged-row-label") }).filter({ hasText: "Clinic outreach PRD" });
    // Build draft's row counts the change: two seeded, now three.
    await expect(docRow.getByTestId("staged-row-label")).toHaveText("3 changes staged for draft 6");
  });

  test("pushback: Accept asks why you keep your call, sends nothing without a reason, then stages it", async ({ page }) => {
    await suggestions(page);
    await inbox(page);
    const roles = row(page, ROLES);
    await roles.getByRole("button", { name: "Accept", exact: true }).click();
    const why = roles.getByLabel("Why keep your call?");
    await expect(why).toBeVisible();
    // Required: Accept without a reason says so and calls nothing (the API's own refusal reads
    // "Oracle pushed back on this feedback…").
    await roles.getByRole("button", { name: "Accept", exact: true }).click();
    await expect(roles.getByTestId("inbox-action-error")).toHaveText("Say why you keep your call.");
    await expect(roles.getByLabel("Why keep your call?")).toBeFocused();
    await expect(row(page, ROLES)).toHaveCount(1);

    await why.fill("Big teams in the pilot need custom roles from day one.");
    await roles.getByRole("button", { name: "Accept", exact: true }).click();
    await expect(notice(page)).toContainText("Staged for draft 3");
    await expect(row(page, ROLES)).toHaveCount(0);
    await tab(page, "Staged").click();
    await expect(row(page, ROLES, "staged")).toContainText("Draft 3");
  });

  test("Decline with a note moves the row to Declined with the note; Undo within 10 s reopens it", async ({ page }) => {
    await suggestions(page);
    await inbox(page);
    const before = Number(await badge(page).innerText());
    const failed = row(page, FAILED);
    // Cancel closes the field and does nothing.
    await failed.getByRole("button", { name: "Decline", exact: true }).click();
    await expect(failed.getByLabel("Why? (optional)")).toBeVisible();
    await failed.getByRole("button", { name: "Cancel" }).click();
    await expect(failed.getByLabel("Why? (optional)")).toHaveCount(0);

    await failed.getByRole("button", { name: "Decline", exact: true }).click();
    await failed.getByLabel("Why? (optional)").fill("Ops want no cap until the pilot ends.");
    await failed.getByRole("button", { name: "Decline", exact: true }).click();
    await expect(notice(page)).toContainText("Declined");
    await expect(row(page, FAILED)).toHaveCount(0);
    await expect(badge(page)).toHaveText(String(before - 1));
    await tab(page, "Declined").click();
    const declined = row(page, FAILED, "declined");
    await expect(declined.getByTestId("decline-note")).toHaveText("Ops want no cap until the pilot ends.");

    // Undo: the item is open again (Oracle's suggestion stays dismissed: Decline and Open).
    await notice(page).getByRole("button", { name: "Undo" }).click();
    await expect(row(page, FAILED, "declined")).toHaveCount(0);
    await expect(badge(page)).toHaveText(String(before));
    await tab(page, "New").click();
    await expect(row(page, FAILED)).toHaveCount(1);
    expect(await buttons(row(page, FAILED))).toEqual(["Stage for agents", "Decline", "Open"]);

    // Undo shows for 10 s only.
    const depot = row(page, DEPOT);
    await depot.getByRole("button", { name: "Decline", exact: true }).click();
    await depot.getByRole("button", { name: "Decline", exact: true }).click();
    await expect(notice(page).getByRole("button", { name: "Undo" })).toBeVisible();
    await expect(notice(page)).toHaveCount(0, { timeout: 12_000 });
  });

  test("Send answer replies on the thread and closes the item; Close and Merge settle theirs as Done", async ({ page }) => {
    await suggestions(page);
    await inbox(page);
    const question = row(page, QUESTION);
    expect(await buttons(question)).toEqual(["Send answer", "Decline", "Stage for agents", "Open"]);
    const remark = row(page, REMARK);
    expect(await buttons(remark)).toEqual(["Close", "Decline", "Stage for agents", "Open"]);
    const duplicate = row(page, QUANTIFY);
    expect(await buttons(duplicate)).toEqual(["Merge", "Open"]);

    await question.getByRole("button", { name: "Send answer" }).click();
    await expect(notice(page)).toContainText("Answer sent");
    await expect(row(page, QUESTION)).toHaveCount(0);
    await row(page, REMARK).getByRole("button", { name: "Close", exact: true }).click();
    await expect(notice(page)).toContainText("Nothing to change");
    await expect(row(page, REMARK)).toHaveCount(0);
    await row(page, QUANTIFY).getByRole("button", { name: "Merge" }).click();
    await expect(notice(page)).toContainText("Merged");
    await expect(row(page, QUANTIFY)).toHaveCount(0);

    await tab(page, "Done").click();
    for (const text of [QUESTION, REMARK, QUANTIFY]) await expect(row(page, text, "done")).toHaveCount(1);

    // The answer is a reply on the comment's thread in the document.
    await row(page, QUESTION, "done").getByRole("link", { name: /^Open/ }).click();
    await expect(page).toHaveURL(/\/documents\/team-workspaces\/v\/2/);
    // On a phone the review panel is a sheet behind its Review button.
    if (page.viewportSize()!.width <= 600) await page.getByRole("button", { name: /^Review ·/ }).filter({ visible: true }).click();
    await openTab(page, "Feedback");
    await feedbackState(page, "Done");
    const answered = page.getByTestId("feedback-item").filter({ visible: true }).filter({ hasText: QUESTION });
    await expect(answered.getByTestId("comment")).toContainText("Workspace owners and billing admins see it; members do not.");
  });

  test("a row without a suggestion offers Stage for agents (first), Decline and Open; Decline declines the item", async ({ page }) => {
    await suggestions(page);
    await inbox(page);
    const address = row(page, ADDRESS);
    expect(await buttons(address)).toEqual(["Stage for agents", "Decline", "Open"]);
    await address.getByRole("button", { name: "Decline", exact: true }).click();
    await address.getByLabel("Why? (optional)").fill("The last address is often a gift address.");
    await address.getByRole("button", { name: "Decline", exact: true }).click();
    await expect(row(page, ADDRESS)).toHaveCount(0);
    await tab(page, "Declined").click();
    await expect(row(page, ADDRESS, "declined").getByTestId("decline-note")).toHaveText("The last address is often a gift address.");
  });

  test("an error shows on the row and the row stays: Accept on a section approved since", async ({ page }) => {
    await suggestions(page);
    // An approver approves F-36 in the document: it is locked.
    await page.goto("/documents/fleet-next/v/2");
    const s = await openSection(page, "f-36");
    const bar = s.getByTestId("review-bar");
    await bar.getByRole("button", { name: "Approve" }).click();
    await bar.getByRole("button", { name: /^Save/ }).click();
    await expect(bar.getByTestId("verdict-state")).toContainText("Locked");

    await page.goto("/inbox");
    const depot = row(page, DEPOT);
    await depot.getByRole("button", { name: "Accept", exact: true }).click();
    await expect(depot.getByTestId("inbox-action-error")).toContainText("approved and locked");
    await expect(row(page, DEPOT)).toHaveCount(1);
    await expect(notice(page)).toHaveCount(0);
  });
  });
}

test("phone (390 px): the buttons stack full width and the field opens under the row; Home has one action per row", async ({ page }) => {
  await suggestions(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/inbox");
  const metric = row(page, METRIC);
  const accept = metric.getByRole("button", { name: "Accept", exact: true });
  const decline = metric.getByRole("button", { name: "Decline", exact: true });
  await expect(accept).toBeVisible();
  const a = (await accept.boundingBox())!;
  const d = (await decline.boundingBox())!;
  const r = (await metric.boundingBox())!;
  // Stacked, each about the row's width.
  expect(d.y).toBeGreaterThan(a.y + a.height - 1);
  expect(a.width).toBeGreaterThan(r.width * 0.8);
  await decline.click();
  const field = metric.getByLabel("Why? (optional)");
  await expect(field).toBeVisible();
  const title = (await metric.getByRole("link", { name: `${METRIC}.`, exact: true }).boundingBox())!;
  expect((await field.boundingBox())!.y).toBeGreaterThan(title.y);
  await metric.getByRole("button", { name: "Decline", exact: true }).click();
  await expect(row(page, METRIC)).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);

  // Home's Needs you: the same rows, one action each. A feedback row is one Open, to the
  // section where it is decided (qa-company-10); Accept and Decline stay the Inbox's.
  await page.setViewportSize({ width: 1366, height: 820 });
  await page.goto("/home");
  const home = page.getByTestId("home-needs-table").locator("tr[data-row]");
  const depot = home.filter({ hasText: DEPOT });
  await expect(depot).toHaveCount(1);
  expect(await buttons(depot)).toEqual(["Open"]);
  await expect(depot.getByRole("button", { name: /^(Accept|Decline)$/ })).toHaveCount(0);
  await depot.getByRole("link", { name: `Open ${DEPOT}` }).click();
  await expect(page).toHaveURL(/\/documents\/fleet-next\/v\/\d+\?feedback=open/);
});
