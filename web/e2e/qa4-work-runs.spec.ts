import { expect, test, type Page } from "./test";

import { login } from "./helpers";

/*
 * QA pass 4 on a run's page (qa4-work-25, 26, 28, 29, 30, 31), driven through the UI on the
 * mock's default scenario: open /runs, click a run, read and use its page.
 */

const rows = (page: Page) => page.getByTestId("run-row");
const inspector = (page: Page) => page.getByRole("complementary", { name: "Run" }).filter({ visible: true });

async function openRun(page: Page, name: string) {
  await login(page);
  await page.goto("/runs");
  await expect(page.getByRole("heading", { level: 1, name: "Runs" })).toBeVisible();
  await rows(page).filter({ hasText: name }).getByRole("link").first().click();
  await expect(page).toHaveURL(/\/runs\/[0-9a-f-]+$/);
  await expect(page.getByTestId("segment-timeline")).toBeVisible();
}

test.describe("desktop", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("qa4-work-25: the over-budget banner says what Resume allows in the shown numbers, in short sentences", async ({ page }) => {
    await openRun(page, "Team workspaces");
    await expect(page.getByTestId("run-overrun-held")).toHaveText(
      "Spent $14.20, past its limit. Estimate $9.00, limit $13.50 (150%). The PRD review is held until you resume it. Resuming lets it spend up to $18.70 in total, $4.50 more. Cancel run stops it.",
    );
    await expect(page.getByTestId("run-overrun-held")).not.toContainText(";");
  });

  test("qa4-work-26: the header's Decide is a jump to the decision, with no menu chevron", async ({ page }) => {
    await openRun(page, "Team onboarding");
    const go = page.getByTestId("run-go-decide");
    await expect(go).toHaveText("Decide");
    await expect(go.locator("svg")).toHaveCount(0);
    await go.click();
    await expect(page.locator("#decide")).toBeFocused();
  });

  test("qa4-work-28: the panel's heading names the state as the header's tag does", async ({ page }) => {
    await openRun(page, "Awaiting cost approval");
    await expect(inspector(page)).toContainText("Run · Awaiting cost approval");
    await expect(inspector(page)).not.toContainText("Run · awaiting cost approval");

    await openRun(page, "Team onboarding");
    await expect(inspector(page)).toContainText("Checkpoint · Waiting");
    await expect(inspector(page)).not.toContainText("Checkpoint · waiting");
  });

  test("qa4-work-29: a decision reads as a sentence in the panel's normal size", async ({ page }) => {
    await openRun(page, "Checkout redesign");
    const decision = inspector(page).getByTestId("run-decisions").getByTestId("run-decision");
    await expect(decision).toHaveText("PRD review was skipped: it was turned off when the run started.");
    await expect(decision).toHaveCSS("font-size", "14px");
  });

  test("qa4-work-30: the note box has a visible label above it that stays while typing", async ({ page }) => {
    await openRun(page, "Team onboarding");
    const baseline = page.getByTestId("checkpoint-baseline_confirm");
    const label = baseline.getByTestId("note-label");
    await expect(label).toBeVisible();
    await expect(label).toHaveText("Note for the agents (required to request changes)");
    const box = baseline.getByLabel("Note for the agents");
    await expect(box).not.toHaveAttribute("placeholder", /.+/);
    await box.fill("Name an owner for every goal");
    await expect(label).toBeVisible();
    await expect(label).toContainText("required to request changes");
    const [l, b] = [(await label.boundingBox())!, (await box.boundingBox())!];
    expect(l.y + l.height).toBeLessThanOrEqual(b.y + 0.5);
  });

  test("qa4-work-31: on a desktop the checkpoint column keeps its header; the prefix is for screen readers", async ({ page }) => {
    await openRun(page, "Team onboarding");
    const prefix = page.getByTestId("segment-checkpoint-prefix").first();
    await expect(prefix).toHaveCSS("position", "absolute");
  });
});

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("qa4-work-31: on a phone a stop still to come reads 'Stops for: …', not a bare grey line", async ({ page }) => {
    await openRun(page, "Team onboarding");
    const stop = page.getByTestId("segment-checkpoint").filter({ hasText: "Feature set and dependencies" }).first();
    await expect(stop).toBeVisible();
    await expect(stop).toHaveText("Stops for: Feature set and dependencies");
    const prefix = stop.getByTestId("segment-checkpoint-prefix");
    await expect(prefix).toHaveCSS("position", "static");
    const box = (await prefix.boundingBox())!;
    expect(box.width).toBeGreaterThan(30);
  });
});
