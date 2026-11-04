import { DECISION_NOTES_SCENARIO } from "../lib/api/mock/decision-notes";
import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";
import { expect, test, type Page } from "./test";

/**
 * decisions-reversed-or-trashed banner (owner's pick: "Draft banner now"), on the mock's
 * "decision-notes" scenario (./lib/api/mock/decision-notes.ts): an open draft cited
 * Decision 12, since reversed, and Decision 9, made about a roadmap now in Trash.
 *
 * Card decision-notes-banner: protects = the one-pager's and the roadmap's working-draft
 * banners say in plain words which decision was reversed, by number and name, and what it
 * means for the draft, linked to the decision in Company › Decisions; under the banner one
 * quiet line names the decisions the read left out, linked the same way; fails_when = a
 * note is missing, reads the raw "D-12" token, or links nowhere; no_claim = which drafts
 * get a note and which decisions are left out (api/tests/test_decisions_reversed_or_trashed.py).
 */

const NOTE =
  "Decision 12 Cut bulk export from the first release was reversed; the next draft no longer relies on it. Why: Customers asked for exports back.";
const LEFT_OUT =
  "Left out, no longer standing: Decision 12 Cut bulk export from the first release (reversed); Decision 9 Ship alerts by email only (about a roadmap now in Trash).";
const DESKTOP = { width: 1366, height: 820 };

async function start(page: Page) {
  await page.addInitScript(([key, value]) => localStorage.setItem(key, value), [MOCK_SCENARIO_KEY, DECISION_NOTES_SCENARIO] as const);
  await login(page);
}

/** Notes and the left-out line read in plain words and link to their decisions. */
async function reads(page: Page, banner: ReturnType<Page["getByTestId"]>) {
  const note = banner.getByTestId("decision-note");
  await expect(note).toHaveText(NOTE);
  await expect(note.getByRole("link", { name: "Decision 12 Cut bulk export from the first release" })).toHaveAttribute("href", "/company/decisions?d=12");
  const line = page.getByTestId("left-out-line");
  await expect(line).toHaveText(LEFT_OUT);
  await expect(line.getByRole("link", { name: "Decision 12 Cut bulk export from the first release" })).toHaveAttribute("href", "/company/decisions?d=12");
  await expect(line.getByRole("link", { name: "Decision 9 Ship alerts by email only" })).toHaveAttribute("href", "/company/decisions?d=9");
  await expect(page.getByText(/\bD-\d+\b/)).toHaveCount(0);
}

for (const phone of [false, true]) {
  for (const scheme of ["light", "dark"] as const) {
    test.describe(`${phone ? "phone" : "desktop"} · ${scheme}`, () => {
      test.use({ viewport: phone ? { width: 390, height: 844 } : DESKTOP, colorScheme: scheme });

      test("the one-pager's draft banner names the reversed decision and what was left out", async ({ page }) => {
        await start(page);
        await page.goto("/simple/prds/guided-setup");
        await page.getByRole("button", { name: "Edit “A setup checklist that shows" }).click();
        await page.getByLabel("New wording for").fill("A setup checklist with the next two steps");
        await page.getByRole("button", { name: "Save" }).click();
        const banner = page.getByRole("status", { name: "Working draft" });
        await expect(banner).toContainText("1 change");
        await reads(page, banner);
        await banner.getByRole("link", { name: "Decision 12 Cut bulk export from the first release" }).click();
        await expect(page).toHaveURL(/\/company\/decisions\?d=12$/);
      });

      test("the roadmap's draft banner names the reversed decision and what was left out", async ({ page }) => {
        await start(page);
        // A bar moves by keys on a desktop's Gantt; the phone then reads the same draft.
        if (phone) await page.setViewportSize(DESKTOP);
        await page.goto("/simple/roadmap");
        await expect(page.getByTestId("simple-roadmap")).toBeVisible();
        await expect(page.getByTestId("left-out-line")).toHaveText(LEFT_OUT);
        await page.getByTestId("format-gantt").click();
        const bar = page.locator('g[data-testid="bar"][data-item="alert-export"]');
        await bar.focus();
        await page.keyboard.press("ArrowRight");
        await page.getByTestId("format-switch").getByTestId("format-timeline").focus();
        const banner = page.getByTestId("draft-banner");
        await expect(banner.getByTestId("draft-count")).toHaveText("1");
        if (phone) {
          await page.setViewportSize({ width: 390, height: 844 });
          await page.reload();
        }
        await reads(page, banner);
      });
    });
  }
}
