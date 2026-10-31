import { expect, test, type Locator, type Page } from "./test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { ADMIN } from "./helpers";

/*
 * QA pass 4 fixes on Simple Home's "Walk me through it" (mock-backed, desktop and phone):
 * - qa4-simple-home-1: an answer typed on a decision is recorded as the decision's answer.
 * - qa4-simple-home-33: that answer never turns up in Ask Oracle's Recent chats.
 * - qa4-simple-home-9: the walk's summary counts decisions as Home's tile does; an agenda item apart.
 * - qa4-simple-home-10: Done gives the focus back to "Walk me through it".
 * - qa4-simple-home-14: Another answer offers only the other answers beside Decide as recommended.
 * - qa4-simple-home-31: "Recommended in <document>", never "<document> recommends".
 * no_claim: the real API's decide_question with the person's own words (api/tests/test_simple_prd_questions.py).
 */

async function signIn(page: Page, scenario: string) {
  await page.context().addInitScript(([key, value]) => localStorage.setItem(key, value), [MOCK_SCENARIO_KEY, scenario] as const);
  await page.goto("/login");
  await page.getByLabel("Email").fill(ADMIN.email);
  await page.getByLabel("Password").fill(ADMIN.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).not.toHaveURL(/\/login/);
  await page.goto("/simple");
  await expect(page.getByTestId("home-greeting")).toBeVisible();
}

/** Clicks `l` once it is scrolled to the middle (on a phone the tab bar covers the bottom of the screen). */
async function tap(l: Locator) {
  await l.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await l.click();
}

const step = (page: Page) => page.getByTestId("walk-step");

/** Starts the walk and skips to its first decision step; returns that decision's title. */
async function toFirstDecision(page: Page): Promise<string> {
  await tap(page.getByRole("button", { name: "Walk me through it" }));
  await expect(page.getByTestId("walk-progress")).toHaveText(/^1 of \d+$/);
  for (let n = 0; n < 30; n++) {
    if ((await step(page).getAttribute("data-kind")) === "decision") return (await step(page).getByTestId("walk-step-title").textContent())!;
    const was = await page.getByTestId("walk-progress").textContent();
    await tap(page.getByTestId("walk").getByRole("button", { name: "Skip" }));
    await expect(page.getByTestId("walk-progress")).not.toHaveText(was!);
  }
  throw new Error("no decision step in the walk");
}

for (const [device, size] of [
  ["desktop", { width: 1512, height: 900 }],
  ["phone", { width: 390, height: 844 }],
] as const) {
  test(`qa4-simple-home-1 and -33 (${device}): a typed answer is the decision's answer, kept after a reload, and makes no chat`, async ({ page }) => {
    // fails_when: the walk sends the typed answer to Oracle's chat ("I could not tell what to change"), so the decision stays open and a Home chat appears
    await page.setViewportSize(size);
    await signIn(page, "simple-chat");
    const title = await toFirstDecision(page);
    const box = step(page).getByTestId("walk-type").getByRole("textbox");
    await expect(box).toHaveAttribute("placeholder", "Or type your answer");
    await box.fill("Seven steps");
    await tap(step(page).getByTestId("walk-type").getByRole("button", { name: /^(Decide|Propose)$/ }));
    await expect(page.getByText(/^Decided .*: Seven steps$/)).toBeVisible();
    await expect(page.getByText("I could not tell what to change")).toHaveCount(0);

    await page.reload();
    await expect(page.getByTestId("home-greeting")).toBeVisible();
    await page.goto("/simple/decisions");
    await expect(page.getByRole("listitem").filter({ hasText: title.replace(/^Q\d+ /, "") }).filter({ hasText: "Seven steps" }).filter({ visible: true })).not.toHaveCount(0);

    // No chat was made of it.
    await page.goto("/simple");
    await tap(page.getByTestId(device === "phone" ? "phone-ask" : "simple-ask").filter({ visible: true }).first());
    const panel = page.getByTestId("hop-panel").filter({ visible: true });
    await expect(panel.getByTestId("ask-chat")).toBeVisible();
    await panel.getByRole("button", { name: /Recent chats/ }).click();
    await expect(panel.getByTestId("ask-recent-row").filter({ hasText: "Seven steps" })).toHaveCount(0);
  });
}

test("qa4-simple-home-9: skipping every step, the walk counts decisions as Home's tile, a meeting agenda item apart", async ({ page }) => {
  // fails_when: the summary says "10 decisions" (an agenda item counted as a decision) while Home's tile says 9
  await signIn(page, "simple-chat");
  const number = page.getByTestId("home-summary-decisions").locator(".simple-number");
  await expect(number).toHaveText(/^\d+$/);
  const tile = Number((await number.textContent())!.trim());
  await tap(page.getByRole("button", { name: "Walk me through it" }));
  const progress = page.getByTestId("walk-progress");
  await expect(progress).toHaveText(/^1 of \d+$/);
  const total = Number((await progress.textContent())!.split(" of ")[1]);
  let agenda = 0;
  for (let n = 1; n <= total; n++) {
    await expect(progress).toHaveText(`${n} of ${total}`);
    if ((await step(page).getAttribute("data-kind")) === "agenda_decision") agenda++;
    await tap(page.getByTestId("walk").getByRole("button", { name: "Skip" }));
  }
  expect(agenda).toBeGreaterThan(0);
  const left = page.getByTestId("walk-left");
  await expect(left).toContainText(`${tile} ${tile === 1 ? "decision" : "decisions"}`);
  await expect(left).toContainText(`${agenda} meeting agenda ${agenda === 1 ? "item" : "items"}`);
});

test("qa4-simple-home-10: Done gives the keyboard focus back to Walk me through it", async ({ page }) => {
  // fails_when: after Done the focus drops to the page body
  await signIn(page, "simple-chat");
  const open = page.getByRole("button", { name: "Walk me through it" });
  await open.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("walk-progress")).toBeVisible();
  await page.getByTestId("walk").getByRole("button", { name: "Done" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("walk")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Walk me through it" })).toBeFocused();
});

for (const [device, size] of [
  ["desktop", { width: 1512, height: 900 }],
  ["phone", { width: 390, height: 844 }],
] as const) {
  test(`qa4-simple-home-14 and -31 (${device}): Another answer lists only the other answers; the row says where it is recommended`, async ({ page }) => {
    // fails_when: the chips repeat "9:00 in each person's zone (recommended)" beside Decide as recommended, or the row reads "Guided setup recommends:"
    await page.setViewportSize(size);
    await signIn(page, "simple-home");
    const row = page.getByTestId("home-question").filter({ hasText: "Reminder default time" });
    await expect(row.locator(".simple-rec")).toHaveText("Recommended in Guided setup: 9:00 in each person's zone");
    await expect(row).not.toContainText("Guided setup recommends");
    await tap(row.getByRole("button", { name: "Another answer" }));
    const answers = row.getByRole("group", { name: /^Answers for / });
    await expect(answers.getByRole("button")).toHaveText(["Noon", "Let each person pick", "Something else…"]);
    await expect(row.getByRole("button", { name: "Decide as recommended" })).toBeVisible();
  });
}
