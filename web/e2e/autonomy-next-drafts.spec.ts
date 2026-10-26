import { expect, test, type Page } from "./test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";

/*
 * D12 One Build next draft under H11 Autonomy (`next_drafts`): at Observe Oracle counts the
 * staged changes and builds nothing, so the Build next draft sheet says so and Build is not
 * available. Fixture ("next-draft" scenario): the fleet PRD on draft 2 with two accepted
 * section-text changes and a whole-draft remark staged for the agents.
 * Each test's card: protects=...; fails_when=...; no_claim=...
 */

const DOC = "/documents/fleet-next/v/2";
const OBSERVING =
  "Oracle is set to observe next drafts: it counts staged changes and builds nothing. An owner can change this in Settings › Autonomy.";

const row = (page: Page, key: string) => page.getByTestId(`autonomy-row-${key}`);
const step = (page: Page, key: string, label: string) => row(page, key).getByRole("group").getByRole("button", { name: label, exact: true });

// protects=an owner sets Build next drafts to Observe in Settings › Autonomy (with a reason);
// then the document still counts its staged changes, the Build draft sheet shows the observe
// sentence, and its Build draft 3 button cannot be pressed; fails_when=the sheet lets Build
// start at Observe, hides the count, or does not say why; no_claim=the API's 409s and Oracle
// building at Act (pytest tests/test_next_drafts_autonomy.py covers them).
test("autonomy: at Observe the Build draft sheet says Oracle builds nothing and Build is off", async ({ page }) => {
  await page.addInitScript((key) => localStorage.setItem(key, "next-draft"), MOCK_SCENARIO_KEY);
  await login(page);
  await page.getByRole("navigation", { name: "Oracle" }).getByTestId("nav-settings").click();
  await page.getByRole("navigation", { name: "Settings" }).getByTestId("nav-autonomy").click();
  await expect(page.getByRole("heading", { level: 1, name: "Autonomy" })).toBeVisible();
  await expect(row(page, "next_drafts")).toContainText("Build next drafts");
  await step(page, "next_drafts", "Observe").click();
  const change = page.getByRole("dialog", { name: "Change Build next drafts" });
  await expect(change.getByTestId("autonomy-to")).toContainText("Oracle counts staged changes and builds nothing.");
  await change.getByLabel("Why").fill("We review drafts by hand this month");
  await change.getByRole("button", { name: "Save" }).click();
  await expect(change).toBeHidden();
  await expect(step(page, "next_drafts", "Observe")).toHaveAttribute("aria-pressed", "true");

  await page.goto(DOC);
  const button = page.getByTestId("build-draft").filter({ visible: true });
  await expect(button.getByTestId("build-draft-count")).toHaveText("· 3 staged");
  await button.click();
  const sheet = page.getByTestId("next-draft-sheet");
  await expect(sheet.getByTestId("staged-list").getByTestId("staged-item")).toHaveCount(2);
  await expect(sheet.getByTestId("next-draft-refused")).toHaveText(OBSERVING);
  await expect(sheet.getByRole("button", { name: "Build draft 3" })).toBeDisabled();
  await expect(sheet.getByTestId("worth-a-draft")).toHaveCount(0);
});

// protects=#586 review MAJOR 3: at Recommend Oracle says when staged changes are worth a draft:
// with the owner's "Staged changes before a draft" at 3, the document's Build draft button's
// tooltip and the Build draft sheet both say "3 changes wait: worth building draft 3.", and an
// approver still builds it (Build stays available); the row shows no "Takes effect" chip;
// fails_when=the notice or the tooltip is missing or wrong, Build is off, or the row still says
// the level waits on D12; no_claim=Oracle building at Act (pytest
// tests/test_next_drafts_autonomy.py).
test("autonomy: at Recommend the Build draft button and sheet say the changes are worth a draft", async ({ page }) => {
  await page.addInitScript((key) => localStorage.setItem(key, "next-draft"), MOCK_SCENARIO_KEY);
  await login(page);
  await page.getByRole("navigation", { name: "Oracle" }).getByTestId("nav-settings").click();
  await page.getByRole("navigation", { name: "Settings" }).getByTestId("nav-autonomy").click();
  await expect(page.getByRole("heading", { level: 1, name: "Autonomy" })).toBeVisible();
  await expect(row(page, "next_drafts").getByTestId("autonomy-pending")).toHaveCount(0);
  // The limit is set with Act, then kept when the owner steps back to Recommend.
  await step(page, "next_drafts", "Act").click();
  const act = page.getByRole("dialog", { name: "Change Build next drafts" });
  await act.getByLabel("Staged changes before a draft").fill("3");
  await act.getByLabel("Why").fill("Three changes are enough for a draft");
  await act.getByRole("button", { name: "Save" }).click();
  await expect(act).toBeHidden();
  await step(page, "next_drafts", "Recommend").click();
  const rec = page.getByRole("dialog", { name: "Change Build next drafts" });
  await expect(rec.getByTestId("autonomy-to")).toContainText("Oracle says when staged changes are worth a draft");
  await rec.getByLabel("Why").fill("We still want to press Build ourselves");
  await rec.getByRole("button", { name: "Save" }).click();
  await expect(rec).toBeHidden();
  await expect(step(page, "next_drafts", "Recommend")).toHaveAttribute("aria-pressed", "true");
  await expect(row(page, "next_drafts").getByTestId("autonomy-pending")).toHaveCount(0);

  await page.goto(DOC);
  const button = page.getByTestId("build-draft").filter({ visible: true });
  await expect(button.getByTestId("build-draft-count")).toHaveText("· 3 staged");
  await expect(button).toHaveAttribute("title", "3 changes wait: worth building draft 3.");
  await button.click();
  const sheet = page.getByTestId("next-draft-sheet");
  await expect(sheet.getByTestId("worth-a-draft")).toHaveText("3 changes wait: worth building draft 3.");
  await expect(sheet.getByTestId("next-draft-refused")).toHaveCount(0);
  await expect(sheet.getByRole("button", { name: "Build draft 3" })).toBeEnabled();
});
