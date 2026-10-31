import { expect, test, type Locator, type Page } from "./test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { ENG_CHECK_RUN, ENG_DATES_RUN, PRIORITY_RUN } from "../lib/api/mock/runs";
import { login, openSection } from "./helpers";

/**
 * Minor fixes on a Baseline to PRD run's stops (production, 2026-10-31), driven as a person on
 * the mock layer, each on a desktop and on a phone. Test cards (protects / fails_when / no_claim):
 * - "unreadable briefs" (8): protects=the run page and the check say the briefs could not be read
 *   and that the way on is Send back; fails_when="0 features · Waiting for you", "0 of 0 decided",
 *   or an Approve that can never open; no_claim=the API's briefs check.
 * - "send back" (9): protects=Send back to architect is a secondary button; fails_when=it is the
 *   grey ghost that reads as disabled; no_claim=its decide call.
 * - "long key" (10): protects=a feature's key stays inside its own cell; fails_when=it runs into
 *   the Approach column; no_claim=other columns.
 * - "answered" (11): protects=an answered question shows the answer, who answered and Edit, no
 *   empty box; Edit reopens it filled; fails_when=the empty box and Answer stay under the answer.
 * - "not decided" (12): protects=a row with no verdict reads "Not decided" as text; fails_when=a
 *   "Decide" button that only selects the row.
 * - "answer draft" (13): protects=an answer being typed survives a verdict saved meanwhile and a
 *   visit to another feature; fails_when=the box is emptied.
 * - "priority order" (14): protects=goal chips wrap between words only, the header counts the
 *   run's own list; fails_when=a word breaks across lines or the header counts the live ranking.
 * - "dates change" (15): protects=Change is a centred dialog on a desktop, a bottom sheet on a
 *   phone; fails_when=a full-width bottom sheet on a desktop.
 * - "review bar" (16): protects=one Approve per section bar, the saved date never under the
 *   buttons; fails_when=two Approve buttons, or the date overlaps them.
 * - "new items" (17): protects=the freshness line says the count is since the sources the draft
 *   read, and when; fails_when=it reads as "since draft v2" with no moment.
 */

const DESKTOP = { width: 1366, height: 820 };
const PHONE = { width: 390, height: 844 };

const withScenario = (page: Page, scenario: string) => page.addInitScript(([key, s]) => localStorage.setItem(key, s), [MOCK_SCENARIO_KEY, scenario]);
const briefRow = (page: Page, key: string) => page.locator(`[data-testid="brief-row"][data-feature="${key}"]`);
const inspector = (page: Page) => page.getByTestId("brief-inspector");
const bar = (page: Page) => page.getByTestId("decision-bar");
const box = async (l: Locator) => (await l.boundingBox())!;
const SANDBOX = "Does the payment sandbox take test orders without a live account?";
const PHONES = "Show the checklist on phones too?";

/** The lead opens the run's Engineering check from the run page's Review. */
async function openCheck(page: Page, scenario: string) {
  await withScenario(page, scenario);
  await login(page, "commenter@example.com");
  await page.goto(`/runs/${ENG_CHECK_RUN}`);
  const line = page.getByTestId("review-screen-line").filter({ visible: true });
  await line.getByRole("link", { name: "Review" }).click();
  await expect(page).toHaveURL(/\/runs\/[0-9a-f-]+\/review\/[0-9a-f-]+$/);
  await expect(bar(page)).toBeVisible();
}

async function select(page: Page, key: string) {
  await briefRow(page, key).getByRole("button").first().click();
  await expect(page.locator(`[data-testid="brief-row"][data-feature="${key}"][aria-current="true"]`)).toHaveCount(1);
}

for (const [name, viewport] of [
  ["desktop", DESKTOP],
  ["phone", PHONE],
] as const) {
  test.describe(name, () => {
    test.use({ viewport });

    test("unreadable briefs: the run page and the check say so, and Send back is the way on", async ({ page }) => {
      await withScenario(page, "eng-check-unreadable");
      await login(page, "commenter@example.com");
      await page.goto(`/runs/${ENG_CHECK_RUN}`);
      const line = page.getByTestId("review-screen-line").filter({ visible: true });
      await expect(line).toContainText("The briefs could not be read");
      await expect(line).toContainText("Send them back to the architect");
      await expect(line).not.toContainText("0 features");
      await expect(line).not.toContainText("Waiting for you");

      await line.getByRole("link", { name: "Review" }).click();
      await expect(page.getByTestId("briefs-problem")).toContainText("The briefs could not be read");
      await expect(bar(page).getByTestId("eng-tally")).toHaveText("The briefs could not be read");
      await expect(bar(page)).not.toContainText("0 of 0 decided");
      await expect(bar(page).getByRole("button", { name: "Approve" })).toHaveCount(0);
      await expect(bar(page).getByTestId("approve-why")).toHaveText("Send the briefs back to the architect to write them again");

      const sendBack = bar(page).getByRole("button", { name: "Send back to architect" });
      await sendBack.click();
      await bar(page).getByRole("textbox", { name: "Note to the architect" }).fill("Write the briefs file again, one brief per feature.");
      await sendBack.click();
      await expect(page).toHaveURL(new RegExp(`/runs/${ENG_CHECK_RUN}$`));
    });

    test("send back: Send back to architect is a normal secondary button", async ({ page }) => {
      await openCheck(page, "eng-check");
      const sendBack = bar(page).getByRole("button", { name: "Send back to architect" });
      await expect(sendBack).toBeEnabled();
      await expect(sendBack).toHaveAttribute("data-variant", "secondary");
    });

    test("long key: a feature's key stays inside its own cell", async ({ page }) => {
      await openCheck(page, "eng-check-long-key");
      const row = briefRow(page, "f.guided_setup_with_test_order_and_sample_catalogue");
      const key = row.getByTestId("brief-key");
      await expect(key).toBeVisible();
      const cell = await box(row.getByRole("button").first());
      const k = await box(key);
      expect(k.x + k.width, "the key runs out of its cell").toBeLessThanOrEqual(cell.x + cell.width + 1);
      const approach = await box(row.getByText("Reuse the onboarding checklist and add the test-order step."));
      if (viewport === DESKTOP) expect(k.x + k.width, "the key runs into Approach").toBeLessThanOrEqual(approach.x);
      const sideways = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(sideways).toBeLessThanOrEqual(0);
    });

    test("answered: the answer, who answered and Edit; no empty box until Edit", async ({ page }) => {
      await openCheck(page, "eng-check");
      await select(page, "f.guided-setup");
      await inspector(page).getByRole("textbox", { name: `Answer: ${SANDBOX}` }).fill("Yes, the sandbox takes test orders.");
      await inspector(page).getByRole("button", { name: "Answer", exact: true }).first().click();
      const answered = inspector(page).getByTestId("answer");
      await expect(answered).toContainText("Yes, the sandbox takes test orders.");
      await expect(answered).toContainText("Answered by");
      await expect(inspector(page).getByRole("textbox", { name: `Answer: ${SANDBOX}` })).toHaveCount(0);
      // The unanswered question keeps its box: one box, one Answer.
      await expect(inspector(page).getByRole("button", { name: "Answer", exact: true })).toHaveCount(1);

      await answered.getByRole("button", { name: `Edit the answer: ${SANDBOX}` }).click();
      await expect(inspector(page).getByRole("textbox", { name: `Answer: ${SANDBOX}` })).toHaveValue("Yes, the sandbox takes test orders.");
    });

    test("not decided: a row with no verdict says so as text, not as a button", async ({ page }) => {
      await openCheck(page, "eng-check");
      const verdict = briefRow(page, "f.sample-data").getByTestId("brief-verdict");
      await expect(verdict).toHaveText("Not decided");
      await expect(verdict.getByRole("button")).toHaveCount(0);
      await expect(page.getByRole("button", { name: /^Decide / })).toHaveCount(0);
    });

    test("answer draft: a verdict saved while an answer is typed keeps the typed text", async ({ page }) => {
      await openCheck(page, "eng-check");
      await select(page, "f.guided-setup");
      const answer = inspector(page).getByRole("textbox", { name: `Answer: ${PHONES}` });
      await answer.fill("Yes, the checklist");
      await inspector(page).getByRole("group", { name: "Verdict" }).getByRole("button", { name: "Feasible", exact: true }).click();
      // Back in the box, as a person does, and on typing while the verdict saves.
      await answer.click();
      await answer.press("End");
      await answer.pressSequentially(" shows on phones too.");
      await expect(briefRow(page, "f.guided-setup").getByTestId("brief-verdict")).toHaveText("Feasible");
      await expect(answer).toHaveValue("Yes, the checklist shows on phones too.");

      // Kept by question, not by the open panel: another feature and back.
      await select(page, "f.sample-data");
      await select(page, "f.guided-setup");
      await expect(inspector(page).getByRole("textbox", { name: `Answer: ${PHONES}` })).toHaveValue("Yes, the checklist shows on phones too.");
    });

    test("priority order: goal chips never break inside a word; the header counts the run's list", async ({ page }) => {
      await withScenario(page, "priority-order");
      await login(page, "approver@example.com");
      await page.goto(`/runs/${PRIORITY_RUN}`);
      await page.getByTestId("checkpoint-priority_order").getByRole("link", { name: "Review the order" }).click();
      await expect(page).toHaveURL(/\/priorities\?snapshot=/);
      const rows = page.locator('tr[data-testid^="priority-row-"]');
      await expect(rows).toHaveCount(5);
      await expect(page.getByText("5 in the run's order").filter({ visible: true })).toHaveCount(1);
      await expect(page.getByText(/^\d+ ranked$/)).toHaveCount(0);

      const names = page.locator('[data-testid="row-goals"] [data-testid="code-name"]').filter({ visible: true });
      await expect(names.first()).toBeVisible();
      const broken = await names.evaluateAll((els) => {
        const out: string[] = [];
        for (const el of els) {
          const node = el.firstChild;
          if (!node || node.nodeType !== Node.TEXT_NODE) continue;
          const text = node.textContent ?? "";
          for (const m of text.matchAll(/\S+/g)) {
            const r = document.createRange();
            r.setStart(node, m.index ?? 0);
            r.setEnd(node, (m.index ?? 0) + m[0].length);
            const lines = new Set([...r.getClientRects()].map((x) => Math.round(x.top)));
            if (lines.size > 1) out.push(m[0]);
          }
        }
        return out;
      });
      expect(broken, "goal words broken across lines").toEqual([]);
    });

    test("dates change: a centred dialog on a desktop, a bottom sheet on a phone", async ({ page }) => {
      await withScenario(page, "eng-dates");
      await login(page, "commenter@example.com");
      await page.goto(`/runs/${ENG_DATES_RUN}`);
      await page.getByTestId("review-screen-line").filter({ visible: true }).getByRole("link", { name: "Review" }).click();
      await expect(page).toHaveURL(/\/runs\/[0-9a-f-]+\/review\/[0-9a-f-]+$/);
      await page.locator('[data-testid="date-row"][data-item="saved-addresses"]').getByRole("button", { name: "Change", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "Change the date: Saved addresses" });
      await expect(dialog).toBeVisible();
      const b = await box(dialog);
      if (viewport === DESKTOP) {
        expect(b.width).toBeLessThan(720);
        expect(b.width).toBeGreaterThan(400);
        expect(Math.abs(b.x + b.width / 2 - DESKTOP.width / 2)).toBeLessThan(4);
        expect(b.y + b.height).toBeLessThan(DESKTOP.height - 8);
        await expect(page.getByTestId("date-change").getByTestId("sheet-handle")).toBeHidden();
      } else {
        expect(Math.round(b.width)).toBe(PHONE.width);
        expect(Math.round(b.y + b.height)).toBe(PHONE.height);
        await expect(page.getByTestId("date-change").getByTestId("sheet-handle")).toBeVisible();
      }
      await dialog.getByRole("button", { name: "Cancel" }).click();
      await expect(dialog).toHaveCount(0);
    });

    test("review bar: one Approve per bar, and the saved date never sits under the buttons", async ({ page }) => {
      await login(page);
      await page.goto("/documents/saved-carts/v/2");
      await expect(page.getByTestId("document-sections")).toBeVisible();
      const summary = await openSection(page, "summary");
      const reviewBar = summary.getByTestId("review-bar");
      await reviewBar.getByRole("group", { name: "Verdict for Summary" }).getByRole("button", { name: "Approve", exact: true }).click();
      await expect(reviewBar.getByTestId("verdict-pending")).toHaveText("Approved");
      await expect(reviewBar.getByRole("button", { name: "Approve", exact: true })).toHaveCount(1);
      const unsaved = reviewBar.getByText("Not saved yet");
      expect((await box(unsaved)).height, "Not saved yet on one line").toBeLessThan(28);

      await reviewBar.getByTestId("verdict-submit").click();
      const state = reviewBar.getByTestId("verdict-state");
      await expect(state).toContainText("Approved");
      await expect(reviewBar.getByRole("button", { name: "Approve", exact: true })).toHaveCount(1);
      const group = await box(reviewBar.getByRole("group", { name: "Verdict for Summary" }));
      for (const part of [state.getByText("Locked"), ...(viewport === DESKTOP ? [state.getByTestId("verdict-date")] : [])]) {
        await expect(part).toBeVisible();
        const p = await box(part);
        const s = await box(state);
        const under = p.x < group.x + group.width && p.x + p.width > group.x && p.y < group.y + group.height && p.y + p.height > group.y;
        expect(under, "the state sits under the buttons").toBe(false);
        expect(p.x + p.width, "the state is cut at its edge").toBeLessThanOrEqual(s.x + s.width + 1);
      }
    });

    test("new items: the line says the count is since the sources the draft read, and when", async ({ page }) => {
      await withScenario(page, "draft-new-items");
      await login(page);
      await page.goto("/settings/sources");
      const source = page.getByRole("listitem", { name: "Product chat" });
      await source.getByRole("button", { name: "Sync now" }).click();
      await expect(source.getByRole("status")).toContainText("Synced:");
      await page.goto("/documents/usage-alerts/v/2");
      await expect(page.getByTestId("draft-new-items")).toHaveText(/1 new or changed item in your sources since draft v2 read them \([A-Z][a-z]{2} \d{1,2}/);
    });
  });
}
