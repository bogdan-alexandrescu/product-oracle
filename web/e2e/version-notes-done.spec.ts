import { expect, test, type Page } from "./test";

import { VERSION_WARNINGS_SCENARIO } from "../lib/api/mock/roadmap";
import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";

/**
 * Train AN follow-ups (PRD review): a draft that answers every point of a send-back note
 * says so as done, not as an amber warning, and is not counted as one; the header's
 * "N warnings" chip carries the warnings in its tooltip. The "version-warnings" scenario
 * gives usage-alerts-roadmap v1 the API's warnings, a note answered in full among them.
 *
 * Test cards (protects / fails_when / no_claim):
 * - done: protects=a note answered in full reads as done; fails_when=it shows amber with the
 *   alert icon, or the header counts it as a warning; no_claim=the API's wording
 *   (api/tests/test_train_an_followups.py).
 * - tooltip: protects=the header's warnings chip names its warnings on hover;
 *   fails_when=the chip has no tooltip or it lacks a warning's words.
 */

async function openVersion(page: Page) {
  await page.addInitScript(([key, s]) => localStorage.setItem(key, s), [MOCK_SCENARIO_KEY, VERSION_WARNINGS_SCENARIO]);
  await login(page);
  await page.goto("/documents/usage-alerts-roadmap/v/1");
}

test("a send-back note answered in full reads as done, not as a warning", async ({ page }) => {
  await openVersion(page);
  const note = page.locator('[data-warning="note_answered"]').filter({ visible: true });
  await expect(note).toHaveText("The draft answers every point of the send-back note: 2 points, all addressed");
  await expect(note).toHaveAttribute("data-state", "done");
  await expect(note).not.toHaveClass(/bg-warn-bg/);
  // The header counts the two real warnings only.
  await expect(page.getByTestId("version-warnings-chip").filter({ visible: true })).toHaveText("2 warnings");
});

test("the header's warnings chip names its warnings in a tooltip", async ({ page }) => {
  await openVersion(page);
  const chip = page.getByTestId("version-warnings-chip").filter({ visible: true });
  await chip.hover();
  await expect(chip).toHaveAttribute("title", /a source item Oracle no longer has/);
  await expect(chip).toHaveAttribute("title", /2 feedback items stay open/);
  await expect(chip).not.toHaveAttribute("title", /send-back note/);
});
