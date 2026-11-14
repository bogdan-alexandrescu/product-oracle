import { expect, test, type Locator, type Page } from "./test";

import { RUN_DISCUSSION_OPEN } from "../lib/api/mock/discussions";
import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";

/*
 * ask-phone QA (Nov 14): Ask Oracle, linked discussions and Share as discussion in Simple, driven
 * through the UI against the mock (invented data). Desktop = 1440x900, phone = 390x844.
 *
 * Each test's card: protects=<the observable>; fails_when=<the wrong result>; no_claim=<what
 * green does not prove>. The API's names are covered by api/tests/test_ask_phone_api.py.
 */

const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };
// The run the "feature-set" scenario seeds (web/lib/api/mock/runs.ts FEATURE_SET_RUN).
const RUN = "7a11c0de-0000-4000-8000-0000000000f5";
const APPROVER = "approver@example.com";
const COMMENTER = "commenter@example.com";

const scenario = (page: Page, name: string) => page.addInitScript(([k, v]) => localStorage.setItem(k, v), [MOCK_SCENARIO_KEY, name] as const);

async function openAsk(page: Page): Promise<Locator> {
  // The rail's Ask Oracle; on a phone, the header's Ask.
  await page.locator('[data-testid="simple-ask"], [data-testid="phone-ask"]').filter({ visible: true }).first().click();
  const panel = page.getByTestId("hop-panel").filter({ visible: true });
  await expect(panel.getByTestId("ask-chat")).toBeVisible();
  return panel;
}

// protects=QA row 1: Ask on the Goal map and the Inbox names the page, and Recent chats names the
// Goal map's chat so; fails_when="New chat about /simple/goals" or a Recent row of "Home";
// no_claim=the API's page_name (pytest).
test("row 1: Ask names the Goal map and the Inbox, never their path", async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await login(page);
  await page.goto("/simple/goals");
  await expect(page.getByTestId("gm-grid")).toBeVisible();
  let panel = await openAsk(page);
  await expect(panel.getByTestId("ask-about")).toHaveText("New chat about Goal map");
  const box = panel.getByRole("textbox", { name: "Message Oracle" });
  await expect(box).toHaveAttribute("placeholder", "Ask about the goal map, or ask for a change…");
  await box.fill("what is Weekly alert digest about?");
  await panel.getByRole("button", { name: "Send" }).click();
  await expect(panel.getByTestId("ask-chat-thread").getByTestId("ask-answer").last()).toHaveAttribute("data-status", "complete", { timeout: 15_000 });
  await panel.getByTestId("ask-new-chat").click();
  await panel.getByRole("button", { name: "Recent chats" }).click();
  await expect(panel.getByTestId("ask-recent-row").first()).toContainText("Goal map · Today");

  await page.goto("/simple/inbox");
  await expect(page.getByTestId("inbox-needs")).toBeVisible();
  panel = await openAsk(page);
  await expect(panel.getByTestId("ask-about")).toHaveText("New chat about Inbox");
  await expect(panel.getByRole("textbox", { name: "Message Oracle" })).toHaveAttribute("placeholder", "Ask about your inbox, or ask for a change…");
});

// protects=QA rows 2 and 6: a run's discussion link on a phone names the item ("Bulk address
// edit") under the title, and the "1 person" pill is chip height inside its 44 px target;
// fails_when=the line ends in the slug bulk-address-edit or the pill is a 44 px oval;
// no_claim=a feature's code (this item has no Ground Truth feature).
test("rows 2 and 6: a run's discussion names its item and its people pill is chip height", async ({ page }) => {
  await page.setViewportSize(PHONE);
  await scenario(page, "run-discussions");
  await login(page, COMMENTER);
  await page.goto(`/runs/${RUN}?discussion=${RUN_DISCUSSION_OPEN}`);
  const thread = page.getByTestId("run-discussion-sheet").getByTestId("discussion-thread");
  await expect(thread).toContainText("Bulk edit: keep it without the export?");
  await expect(thread).toContainText("Feature set · Bulk address edit");
  await expect(thread).not.toContainText("bulk-address-edit");
  const pill = (await thread.getByTestId("discussion-people-pill").boundingBox())!;
  const chip = (await thread.getByTestId("discussion-visibility").boundingBox())!;
  expect(pill.height).toBeLessThanOrEqual(chip.height + 2);
  expect((await thread.getByTestId("discussion-people").boundingBox())!.height).toBeGreaterThanOrEqual(44);
});

// protects=QA row 3 and missing feature 2: Review changes from Simple's Inbox stays in Simple and
// opens the thread on its changes there; fails_when=it goes to Detailed's /priorities or Simple's
// page opens no thread; no_claim=Apply (the changes card's own specs).
for (const [where, size] of [["desktop", DESKTOP], ["phone", PHONE]] as const) {
  test(`row 3: Review changes from Simple's Inbox opens the thread in Simple (${where})`, async ({ page }) => {
    await page.setViewportSize(size);
    await scenario(page, "discussions");
    await login(page, APPROVER);
    await page.goto("/simple/inbox");
    const row = page.locator("tr[data-row], li[data-row], [data-row]").filter({ hasText: "Order: put Guest checkout first? · 1 change proposed" }).filter({ visible: true }).first();
    await row.getByRole("link", { name: "Review changes" }).click();
    await expect(page).toHaveURL(/\/simple\/priorities\?discussion=[^&]+&changes=1/);
    const card = page.getByTestId("linked-discussion-sheet").getByTestId("changes-card");
    await expect(card).toBeVisible();
    await expect(card.getByRole("list", { name: "Open changes" }).getByTestId("change-row")).toContainText("Move Guest checkout above Saved carts");
  });
}

// protects=QA row 4: on a phone a Goal map feature's name wraps to 2 lines, not cut with "…";
// fails_when=a name is cut on one line; no_claim=names longer than 2 lines.
test("row 4: on a phone the Goal map's feature names wrap, not cut", async ({ page }) => {
  await page.setViewportSize(PHONE);
  await login(page);
  await page.goto("/simple/goals");
  const names = page.getByTestId("goal-map-feature-name");
  await expect(names.first()).toBeVisible();
  const cut = await names.evaluateAll((els) => els.filter((e) => e.scrollWidth > e.clientWidth + 1).map((e) => e.textContent));
  expect(cut).toEqual([]);
});

// protects=QA row 4: on desktop a Dates row's why wraps instead of being cut; fails_when=it is
// cut on one line; no_claim=a why longer than 2 lines.
test("row 4: on desktop a Dates row's why is not cut on one line", async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await login(page);
  await page.goto("/simple/inbox");
  const basis = page.getByTestId("date-suggestion-basis").filter({ visible: true });
  await expect(basis.first()).toBeVisible();
  const cut = await basis.evaluateAll((els) => els.filter((e) => e.scrollWidth > e.clientWidth + 1).map((e) => e.textContent));
  expect(cut).toEqual([]);
});

// protects=missing feature 1: Simple's Ask offers Share as discussion under a chat Oracle answered;
// Post opens the shared thread, Open, over the page; fails_when=no Share in Simple's panel;
// no_claim=who may share (the API's can_manage).
for (const [where, size] of [["desktop", DESKTOP], ["phone", PHONE]] as const) {
  test(`Simple's Ask shares a chat as a discussion (${where})`, async ({ page }) => {
    await page.setViewportSize(size);
    await login(page);
    await page.goto("/simple/roadmap");
    const panel = await openAsk(page);
    const box = panel.getByRole("textbox", { name: "Message Oracle" });
    // The person's rights are read (a question goes to Oracle's Ask only then).
    await expect(box).toHaveAttribute("placeholder", "Ask about the roadmap, or ask for a change…");
    await box.fill("what is Weekly alert digest about?");
    await panel.getByRole("button", { name: "Send" }).click();
    await expect(panel.getByTestId("ask-chat-thread").getByTestId("ask-answer").last()).toHaveAttribute("data-status", "complete", { timeout: 15_000 });
    await panel.getByTestId("ask-share").click();
    const form = panel.getByTestId("hop-share-form");
    await expect(form.getByLabel("First message")).not.toHaveValue("");
    await expect(form.getByLabel("First message")).not.toHaveValue(/\[c:\d+\]/);
    await form.getByRole("button", { name: "Post" }).click();
    await expect(page).toHaveURL(/\/simple\/roadmap\?discussion=/);
    const thread = page.getByTestId("linked-discussion-sheet").getByTestId("discussion-thread");
    await expect(thread.getByTestId("discussion-visibility")).toHaveText("Open");
  });
}
