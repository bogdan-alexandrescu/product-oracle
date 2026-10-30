import { expect, test, type Page } from "./test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { V2_IDS } from "../lib/api/mock/v2";

import { login } from "./helpers";

/*
 * QA pass 4 on the brief page, /intakes/<id> (qa-work-2, 3, 28, 29, 30, 31; qa-onboarding-22,
 * 23), driven through the UI on the mock: the default scenario's "Saved addresses" brief (a
 * critical question answered "I don't know"), and a new company's first brief ("empty").
 */

const PHONE = { width: 390, height: 844 };
const SAVED = "Saved addresses";
const UNSURE = "Which metric shows repeat checkout got faster?";

async function openSaved(page: Page) {
  await page.addInitScript(() => localStorage.setItem("po-interview-follow-up", "off"));
  await login(page);
  await page.goto(`/intakes/${V2_IDS.intake}`);
  await expect(page.getByRole("heading", { level: 1, name: SAVED })).toBeAttached();
  await expect(page.getByTestId("intake-thread")).toBeVisible();
}

const inspector = (page: Page) => page.getByTestId("intake-inspector").filter({ visible: true });
const readLine = (page: Page) => page.getByTestId("intake-read");

/** The number the Gaps tab shows beside its name. */
async function gapsTabCount(page: Page): Promise<number> {
  const text = (await page.getByRole("tab", { name: /^Gaps/ }).textContent()) ?? "";
  return Number(text.match(/(\d+)\s*$/)?.[1] ?? NaN);
}

test("qa-work-2: an I don't know answer counts as answered, and the status chip agrees with the counts", async ({ page }) => {
  await openSaved(page);
  await expect(inspector(page).getByTestId("stat-open")).toContainText("0");
  await expect(inspector(page).getByTestId("stat-answered")).toContainText("1");
  await expect(inspector(page).getByTestId("stat-critical")).toContainText("1");
  // Nothing waits on anyone: the chip does not say "Waiting for answers".
  await expect(page.getByTestId("intake-status")).toHaveText("Waiting for a decision");
  await expect(inspector(page).getByTestId("answered-unknown")).toHaveText(
    "1 answered “I don't know”: what it asks stays a gap until someone answers or decides",
  );
});

test("qa-work-2, qa-work-29 (phone): the summary card says what the inspector says, with no second way to Gaps", async ({ page }) => {
  await page.setViewportSize(PHONE);
  await openSaved(page);
  const card = page.getByTestId("intake-readiness");
  await expect(card).toContainText("Before drafting");
  await expect(card.getByRole("heading", { level: 2 })).toHaveText(/^(Not ready to draft|Can draft, with gaps|Ready to draft)$/);
  await expect(card).not.toContainText("Ready to draft?");
  await expect(card.getByTestId("intake-readiness-counts")).toHaveText("0 open · 1 answered · 1 critical open");
  await expect(card).toContainText("1 answered “I don't know”");
  await expect(page.getByTestId("intake-status")).toHaveText("Waiting for a decision");
  await expect(card.getByRole("button", { name: /^Gaps/ })).toHaveCount(0);
  // The same title as the inspector in its sheet.
  const title = await card.getByRole("heading", { level: 2 }).textContent();
  await card.getByRole("button", { name: "Show details" }).click();
  const sheet = page.getByTestId("intake-sheet");
  await expect(sheet.getByTestId("intake-inspector")).toContainText(title!);
  await expect(sheet.getByTestId("stat-open")).toContainText("0");
  await expect(sheet.getByTestId("stat-answered")).toContainText("1");
});

for (const size of [null, PHONE] as const) {
  test(`qa-work-28: an I don't know answer offers Change answer, under my own initials${size ? " (phone)" : ""}`, async ({ page }) => {
    if (size) await page.setViewportSize(size);
    await openSaved(page);
    const q = page.getByTestId("intake-thread").getByTestId("question").filter({ hasText: UNSURE });
    await expect(q.getByTestId("answer")).toContainText("I don't know");
    await expect(q.getByRole("button", { name: "Answer", exact: true })).toHaveCount(0);
    await expect(q.getByRole("button", { name: "Change answer" })).toBeVisible();
    // The rail's account button shows admin@example.com as "AD"; so does my answer.
    const avatar = q.getByTestId("answer").getByRole("img", { name: "You" });
    await expect(avatar).toHaveText("AD");
    await expect(avatar).not.toHaveText("YO");
  });
}

test("qa-work-30: the Gaps tab names a gap's section in words, never the raw key", async ({ page }) => {
  await openSaved(page);
  await page.getByRole("tab", { name: /^Gaps/ }).click();
  const row = page.getByTestId("gap-row").filter({ hasText: "No baseline for repeat checkout time" });
  await expect(row.getByTestId("gap-sections")).toHaveText("Section: Metrics");
  await expect(row).not.toContainText(/\bmetrics\b/);
});

test("qa-onboarding-22, 23, qa-work-3, 31: a new company's first brief, from New PRD to Draft with Oracle's estimate", async ({ page }) => {
  await page.context().addInitScript(
    ([key, value]) => {
      if (!sessionStorage.getItem("fix4-intake")) {
        localStorage.removeItem("po-mock-db-v2");
        sessionStorage.setItem("fix4-intake", "1");
      }
      localStorage.setItem(key, value);
      localStorage.setItem("po-interview-follow-up", "off");
    },
    [MOCK_SCENARIO_KEY, "empty"],
  );
  await login(page);

  // New PRD: a title and the problem, then Continue.
  await page.goto("/documents/new?kind=prd");
  await expect(page.getByRole("heading", { level: 1, name: "New PRD" })).toBeVisible();
  await page.getByRole("textbox", { name: "Title" }).fill("Saved addresses at checkout");
  await page.getByRole("textbox", { name: "What problem does it solve?" }).fill("Returning buyers retype their address at every checkout.");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page).toHaveURL(/\/intakes\/[0-9a-f-]+$/);
  await expect(page.getByRole("heading", { level: 1, name: "Saved addresses at checkout" })).toBeAttached();

  // qa-onboarding-22: the line under the title says Oracle asked its questions.
  const thread = page.getByTestId("intake-thread");
  await expect(thread.getByTestId("batch").first()).toBeVisible();
  const asked = await thread.getByTestId("question").count();
  expect(asked).toBeGreaterThan(0);
  await expect(readLine(page)).toContainText(`Oracle asked ${asked} question${asked === 1 ? "" : "s"} from what the brief says`);
  await expect(readLine(page)).not.toContainText("Oracle hasn't read this brief");
  // No confirmed goal: Oracle does not ask which one it serves.
  await expect(thread).not.toContainText("Which confirmed company goal");
  await page.getByRole("tab", { name: "Questions" }).click();

  // qa-work-31: the cap says what it counts.
  await expect(readLine(page).getByTestId("intake-read-count")).toHaveText("3 analyses left today");

  // qa-work-3: after Analyse with Oracle the line counts the Gaps tab's open gaps.
  await readLine(page).getByRole("button", { name: "Analyse with Oracle" }).click();
  await expect(readLine(page)).toContainText("Oracle assumed", { timeout: 25_000 });
  const gaps = await gapsTabCount(page);
  expect(gaps).toBeGreaterThan(0);
  await expect(readLine(page)).toContainText(`${gaps} open gap${gaps === 1 ? "" : "s"}`);
  await expect(readLine(page)).not.toContainText("0 open gaps");
  await expect(readLine(page).getByTestId("intake-read-count")).toHaveText("2 analyses left today");

  // qa-onboarding-23: the estimate in the baseline dialog's words.
  await page.getByRole("button", { name: "Draft with Oracle" }).click();
  const sheet = page.getByRole("dialog", { name: "Draft with Oracle" });
  await expect(sheet.getByTestId("draft-baseline-none")).toContainText("Build the baseline ($7.00)");
  await sheet.getByRole("button", { name: "Estimate" }).click();
  await expect(sheet.getByTestId("draft-estimate")).toHaveText(
    /^\$[\d,]+\.\d{2} estimated \(\$7\.00 to build the baseline, \$[\d,]+\.\d{2} to draft the PRD\) · (below the \$50 approval line · starts at once|above the \$50 approval line · an owner approves it before it starts)$/,
  );
});
