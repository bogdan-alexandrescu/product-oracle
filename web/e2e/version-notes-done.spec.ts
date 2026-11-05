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
 * - tooltip: protects=the header's warnings chip names its warnings on hover, on a tap at
 *   390 px and from the keyboard; fails_when=the chip is not a button, opens nothing, or its
 *   tip lacks a warning's words.
 * - overview: protects=the overview's version inspector lists the warnings it counts, the done
 *   note as the green notice; fails_when=it lists the done note as an amber card.
 * - declined / older wording: protects=a note with a declined point stays amber; an older
 *   stored note with no declined list and "(N addressed, 0 declined)" reads as done;
 *   fails_when=either reads the other way.
 * - capitals: protects=every warning starts with a capital letter wherever it is shown.
 */

async function openVersion(page: Page, path = "/documents/usage-alerts-roadmap/v/1") {
  await page.addInitScript(([key, s]) => localStorage.setItem(key, s), [MOCK_SCENARIO_KEY, VERSION_WARNINGS_SCENARIO]);
  await login(page);
  await page.goto(path);
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

test("the header's warnings chip names its warnings in a tip", async ({ page }) => {
  await openVersion(page);
  const chip = page.getByTestId("version-warnings-chip").filter({ visible: true });
  await expect(chip).toHaveRole("button");
  await chip.hover();
  const tip = page.getByRole("tooltip").filter({ visible: true });
  await expect(tip).toContainText("A citation in \"Summary\" names a source item Oracle no longer has");
  await expect(tip).toContainText("2 feedback items stay open");
  await expect(tip).not.toContainText("send-back note");
});

test.describe("at 390 px", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test("a tap on the warnings chip opens its warnings; the keyboard reaches it", async ({ page }) => {
    await openVersion(page);
    const chip = page.getByTestId("version-warnings-chip").filter({ visible: true });
    const tip = page.getByRole("tooltip").filter({ visible: true });
    await expect(tip).toHaveCount(0);
    await chip.tap();
    await expect(tip).toContainText("2 feedback items stay open");
    await page.keyboard.press("Escape");
    await expect(tip).toHaveCount(0);
    await chip.blur();
    await chip.focus();
    await expect(chip).toBeFocused();
    await expect(tip).toContainText("names a source item Oracle no longer has");
  });
});

test("the overview's version inspector lists the warnings it counts, the done note as done", async ({ page }) => {
  await openVersion(page, "/documents/usage-alerts-roadmap");
  const inspector = page.getByTestId("version-inspector").filter({ visible: true });
  await expect(inspector).toContainText("3 warnings");
  const cards = inspector.locator("[data-warning]");
  await expect(inspector.locator('[data-warning]:not([data-state="done"])')).toHaveCount(3);
  await expect(cards.first()).toHaveText(/^[A-Z]/);
  const done = inspector.locator('[data-warning="note_answered"]');
  await expect(done).toHaveText("The draft answers every point of the send-back note: 2 points, all addressed");
  await expect(done).toHaveAttribute("data-state", "done");
  await expect(done).not.toHaveClass(/bg-warn-bg/);
  await expect(done.locator("svg")).toHaveCount(1);
});

test("a note with a declined point stays a warning", async ({ page }) => {
  await openVersion(page, "/documents/usage-alerts/v/1");
  // B-09: no done notice for it in the body; the warning is in the header chip's tip.
  await expect(page.locator('[data-warning="note_answered"]').filter({ visible: true })).toHaveCount(0);
  await expect(page.locator('[data-warning]:not([data-state="done"])').filter({ visible: true })).toHaveCount(0);
  const chip = page.getByTestId("version-warnings-chip").filter({ visible: true });
  await expect(chip).toHaveText("1 warning");
  await chip.click();
  await expect(page.getByRole("tooltip").filter({ visible: true })).toContainText(
    "The draft answers the send-back note: 2 points (1 addressed, 1 declined)",
  );
});

test("an older note answered in full, stored without its declined list, reads as done", async ({ page }) => {
  await openVersion(page, "/documents/online-deposits/v/3");
  const note = page.locator('[data-warning="note_answered"]').filter({ visible: true });
  await expect(note).toHaveText("The draft answers the send-back note: 2 points (2 addressed, 0 declined)");
  await expect(note).toHaveAttribute("data-state", "done");
  await expect(page.getByTestId("version-warnings-chip").filter({ visible: true })).toHaveCount(0);
});

test("a version's warnings start with a capital letter", async ({ page }) => {
  await openVersion(page);
  // B-09: the body keeps only the done notice; the warnings are in the header chip's tip.
  await expect(page.locator('[data-warning]:not([data-state="done"])').filter({ visible: true })).toHaveCount(0);
  const done = page.locator('[data-warning="note_answered"][data-state="done"]').filter({ visible: true });
  await expect(done).toHaveCount(1);
  expect((await done.textContent())?.trim()).toMatch(/^[A-Z]/);
  await page.getByTestId("version-warnings-chip").filter({ visible: true }).click();
  const lines = page.getByRole("tooltip").filter({ visible: true }).locator(":scope > span > span");
  await expect(lines).toHaveCount(2);
  for (const text of await lines.allTextContents()) expect(text.trim()).toMatch(/^[A-Z]/);
});
