import { expect, test, type Page } from "./test";

import { V2_IDS } from "../lib/api/mock/v2";

import { login } from "./helpers";

/*
 * QA pass 4 on the brief page, /intakes/<id> (qa4-work-1, 3, 4, 6, 8, 9, 10, 12), driven
 * through the UI on the mock: the default scenario's "Saved addresses" brief, whose critical
 * question was answered "I don't know", opened from the Inbox as a person would.
 */

const PHONE = { width: 390, height: 844 };
const SAVED = "Saved addresses";
const UNSURE = "Which metric shows repeat checkout got faster?";

/** Signs in with Oracle's follow-ups off (the answer goes straight in). */
async function signIn(page: Page) {
  await page.addInitScript(() => localStorage.setItem("po-interview-follow-up", "off"));
  await login(page);
}

/** Inbox › the "Oracle asks" row › Open. */
async function openFromInbox(page: Page) {
  await page.goto("/inbox");
  await expect(page.getByTestId("inbox-needs")).toBeVisible();
  const row = page.locator("[role=tabpanel]").getByTestId("inbox-questions").locator("tr[data-row]").filter({ hasText: UNSURE });
  await expect(row).toContainText("Oracle asks");
  await row.getByRole("link", { name: `Open Before drafting · ${SAVED}` }).click();
  await expect(page).toHaveURL(new RegExp(`/intakes/${V2_IDS.intake}$`));
  await expect(page.getByRole("heading", { level: 1, name: SAVED })).toBeAttached();
  await expect(page.getByTestId("intake-thread")).toBeVisible();
}

async function openDirect(page: Page) {
  await page.goto(`/intakes/${V2_IDS.intake}`);
  await expect(page.getByRole("heading", { level: 1, name: SAVED })).toBeAttached();
  await expect(page.getByTestId("intake-thread")).toBeVisible();
}

const question = (page: Page) => page.getByTestId("intake-thread").getByTestId("question").filter({ hasText: UNSURE });
const back = (page: Page) => page.getByTestId("intake-back").filter({ visible: true });
const readLine = (page: Page) => page.getByTestId("intake-read");

for (const size of [null, PHONE] as const) {
  test(`qa4-work-10: opened from the Inbox the back link reads Inbox and goes back there${size ? " (phone)" : ""}`, async ({ page }) => {
    if (size) await page.setViewportSize(size);
    await signIn(page);
    await openFromInbox(page);
    await expect(back(page)).toHaveText("Inbox");
    await expect(back(page)).toHaveAttribute("href", /^\/inbox(\?|$)/);
    await back(page).click();
    await expect(page).toHaveURL(/\/inbox(\?|$)/);
    await expect(page.getByTestId("inbox-needs")).toBeVisible();
  });
}

test("qa4-work-10: opened any other way the back link still leads to PRDs", async ({ page }) => {
  await signIn(page);
  await openDirect(page);
  await expect(back(page)).toHaveText("PRDs");
  await expect(back(page)).toHaveAttribute("href", "/documents");
});

test("qa4-work-6: an I don't know answer says it once, with no Unknown tag", async ({ page }) => {
  await signIn(page);
  await openFromInbox(page);
  const answer = question(page).getByTestId("answer");
  await expect(answer).toHaveCount(1);
  await expect(answer).toContainText("I don't know");
  await expect(answer).not.toContainText("Unknown");
});

test("qa4-work-4: Send answer waits until something is written", async ({ page }) => {
  await signIn(page);
  await openFromInbox(page);
  await question(page).getByRole("button", { name: "Change answer" }).click();
  const form = question(page).getByTestId("answer-question");
  const send = form.getByRole("button", { name: "Send answer" });
  await expect(send).toBeDisabled();
  await form.getByLabel("Your answer").fill("   ");
  await expect(send).toBeDisabled();
  await form.getByLabel("Your answer").fill("Median repeat checkout time.");
  await expect(send).toBeEnabled();
  await form.getByLabel("Your answer").fill("");
  await expect(send).toBeDisabled();
});

test("qa4-work-1, qa4-work-3: after Defer the status says the question is deferred, and the deferral is a tag, not an answer", async ({ page }) => {
  await signIn(page);
  await openFromInbox(page);
  await expect(page.getByTestId("intake-status")).toHaveText("Waiting for answers");
  await question(page).getByRole("button", { name: "Change answer" }).click();
  await question(page).getByTestId("answer-question").getByRole("button", { name: "Defer", exact: true }).click();

  // qa4-work-3: the question carries the Deferred tag; the thread keeps only the real answers.
  const card = question(page).getByRole("article", { name: UNSURE });
  await expect(card).toContainText("Deferred");
  const answers = question(page).getByTestId("answer");
  await expect(answers).toHaveCount(1);
  await expect(answers).toContainText("I don't know");
  await expect(answers.filter({ hasText: "Deferred" })).toHaveCount(0);
  await expect(page.getByTestId("intake-thread")).not.toContainText("Unknown");
  // It can still be answered later.
  await expect(question(page).getByRole("button", { name: "Answer", exact: true })).toBeVisible();

  // qa4-work-1: the status still says a question was asked, and that it is deferred.
  await expect(page.getByTestId("intake-status")).toHaveText("1 question deferred");
  await expect(page.getByTestId("intake-status")).not.toHaveText("Nothing asked yet");
});

test("qa4-work-8, qa4-work-9: Analyse with Oracle says what it found, in plain words, and Findings says what to do next", async ({ page }) => {
  await signIn(page);
  await openFromInbox(page);
  await readLine(page).getByRole("button", { name: "Analyse with Oracle" }).click();

  // qa4-work-9: a note says the read is done and what it found.
  await expect(page.getByTestId("intake-read-done")).toHaveText("Oracle read the brief: nothing new found.");
  // qa4-work-8: no "0 things", no unexplained "private to you".
  const gapsTab = (await page.getByRole("tab", { name: /^Gaps/ }).textContent()) ?? "";
  const gaps = Number(gapsTab.match(/(\d+)\s*$/)?.[1] ?? 0);
  await expect(readLine(page)).toContainText(`Oracle assumed nothing; ${gaps === 0 ? "no gaps open" : `${gaps} gap${gaps === 1 ? "" : "s"} still open`}`);
  await expect(readLine(page)).not.toContainText("0 things");
  await expect(readLine(page)).not.toContainText("private to you");

  // qa4-work-9: the empty Findings tab says what to do next.
  await page.getByRole("tab", { name: "Findings" }).click();
  const empty = page.getByTestId("findings-empty");
  await expect(empty).toContainText("Oracle has found nothing in your own sources yet.");
  await expect(empty).toContainText("Pin new sources");
  await expect(page.getByTestId("intake-findings")).not.toContainText("No findings from private sources");
});

for (const size of [null, PHONE] as const) {
  test(`qa4-work-12: the Gaps tab says when a gap is closed, its PRD section, and what the edit button does${size ? " (phone)" : ""}`, async ({ page }) => {
    if (size) await page.setViewportSize(size);
    await signIn(page);
    await openFromInbox(page);
    await page.getByRole("tab", { name: /^Gaps/ }).click();
    const row = page.getByTestId("gap-row").filter({ hasText: "No baseline for repeat checkout time" });
    await expect(row).toContainText("Closed when: A named metric with a baseline value");
    await expect(row).not.toContainText("Stop when");
    await expect(row.getByTestId("gap-sections")).toHaveText("PRD section: Metrics");
    await expect(row.getByRole("button", { name: "Triage" })).toHaveCount(0);
    await row.getByRole("button", { name: "Set importance and owner" }).click();
    const form = row.getByTestId("gap-triage");
    await expect(form.getByLabel("Closed when")).toHaveValue("A named metric with a baseline value");
    await expect(form).not.toContainText("Stop condition");
  });
}
