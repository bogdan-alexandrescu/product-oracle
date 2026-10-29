import { expect, test, type Page } from "./test";

import { CONSOLE_HELD_RUN_ID } from "../lib/api/mock/runs";
import { MOCK_ROLE_KEY } from "../lib/api/mock/server";

import { login, openSeeded, seedConsoleHeld } from "./helpers";

/*
 * QA pass 2 on /runs and a run's page (qa-onboarding-13, 16, 30, 31, 49; rirs-6, 7, 8, 15, 16,
 * 17, 18, 19, 20, 21, 22, 23, 24, 25), driven through the UI on the mock's default scenario.
 */

const rows = (page: Page) => page.getByTestId("run-row");
const row = (page: Page, name: string) => rows(page).filter({ hasText: name });
const inspector = (page: Page) => page.getByRole("complementary", { name: "Run" }).filter({ visible: true });
const header = (page: Page) => page.locator("header[data-page-header]").filter({ visible: true });

const asRole = (page: Page, role: string) => page.addInitScript(([key, r]) => localStorage.setItem(key, r), [MOCK_ROLE_KEY, role] as const);

async function openRuns(page: Page) {
  await login(page);
  await page.goto("/runs");
  await expect(page.getByRole("heading", { level: 1, name: "Runs" })).toBeVisible();
  await expect(rows(page)).toHaveCount(5);
}

async function openRun(page: Page, name: string) {
  await openRuns(page);
  await row(page, name).getByRole("link").first().click();
  await expect(page).toHaveURL(/\/runs\/[0-9a-f-]+$/);
  await expect(page.getByTestId("segment-timeline")).toBeVisible();
}

for (const role of ["approver", "commenter", "viewer"]) {
  test(`qa-onboarding-13, rirs-8, qa-onboarding-49: a ${role} is told an owner approves the $53.00`, async ({ page }) => {
    await asRole(page, role);
    await openRun(page, "Awaiting cost approval");
    const who = inspector(page).getByTestId("run-cost-section").getByTestId("run-approval-who");
    await expect(who).toContainText("Waiting for an owner to approve $53.00");
    await expect(who).toContainText("ask an owner");
    await expect(page.getByRole("button", { name: /^Approve / })).toHaveCount(0);
  });
}

test("qa-onboarding-13: the owner is told the approval is theirs, with Approve", async ({ page }) => {
  await openRun(page, "Awaiting cost approval");
  await expect(inspector(page).getByTestId("run-approval-who")).toHaveText(/^Waiting for your approval of \$53\.00\./);
  await expect(page.getByRole("button", { name: "Approve $53.00 and start" })).toBeVisible();
});

test("qa-onboarding-16, rirs-7: a waiting run offers one destructive action; once cancelled, Delete names the run", async ({ page }) => {
  await openRun(page, "team onboarding");
  await expect(page.getByTestId("run-delete")).toHaveCount(0);
  const cancel = header(page).getByTestId("run-cancel");
  await expect(cancel).toHaveText("Cancel run");
  await cancel.click();
  await page.getByRole("alertdialog", { name: "Cancel run" }).getByRole("button", { name: "Cancel run" }).click();
  await expect(header(page).getByTestId("run-status")).toHaveText("Cancelled");
  await expect(page.getByTestId("run-cancel")).toHaveCount(0);
  await page.getByTestId("run-delete").click();
  const dialog = page.getByRole("dialog", { name: "Delete the Team onboarding PRD run" });
  await expect(dialog).toBeVisible();
  await expect(dialog).not.toContainText("still working");
  await expect(dialog.getByTestId("delete-blocked")).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "Move to Trash" })).toBeEnabled();
});

test("qa-onboarding-16: a run not started has Cancel run only, no Delete beside it", async ({ page }) => {
  await openRun(page, "Awaiting cost approval");
  await expect(page.getByTestId("run-cancel")).toHaveCount(1);
  await expect(page.getByTestId("run-delete")).toHaveCount(0);
});

test("qa-onboarding-30, rirs-16: where the run runs, in plain words", async ({ page }) => {
  await openRun(page, "team onboarding");
  const details = inspector(page).getByTestId("run-details");
  await expect(details).toContainText("On this server (test mode)");
  await expect(details).not.toContainText("This Oracle");
  await expect(details).not.toContainText("runtime");
});

test("qa-onboarding-31, rirs-20: no progress check before agents run; Refresh progress after, apart from the danger actions", async ({ page }) => {
  await openRun(page, "Awaiting cost approval");
  await expect(page.getByRole("button", { name: "Refresh progress" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Check agents now" })).toHaveCount(0);

  await page.goto("/runs");
  await row(page, "team onboarding").getByRole("link").first().click();
  await expect(page.getByRole("button", { name: "Refresh progress" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Check agents now" })).toHaveCount(0);
  // Cancel run is a danger button in the header, away from Refresh progress.
  const cancel = page.getByTestId("run-cancel");
  await expect(cancel).toHaveAttribute("data-variant", "danger");
  await expect(header(page).getByTestId("run-cancel")).toHaveCount(1);
  await expect(header(page).getByRole("button", { name: "Refresh progress" })).toHaveCount(0);
});

test("rirs-20: Delete on a finished run is a danger button", async ({ page }) => {
  await openRun(page, "Succeeded");
  await expect(page.getByTestId("run-delete")).toHaveAttribute("data-variant", "danger");
});

test("rirs-6: who may decide a checkpoint, in words", async ({ page }) => {
  await openRun(page, "team onboarding");
  const panel = page.getByTestId("checkpoint-baseline_confirm").filter({ has: page.getByTestId("checkpoint-who") });
  await expect(panel.getByTestId("checkpoint-who")).toHaveText("Approvers and owners can decide");
  await expect(page.getByText("approver+")).toHaveCount(0);
});

test("rirs-15: a checkpoint turned off reads Not asked, with why on hover", async ({ page }) => {
  await openRun(page, "Saved carts");
  const chip = page.getByTestId("segment-checkpoint").first();
  await expect(chip).toContainText("Not asked (checkpoint skipped)");
  await expect(chip).not.toContainText(": off");
  await expect(chip).toHaveAttribute("title", /turned off when the run started/);
});

test("rirs-17: the header's document and decisions link are set apart, with no unexplained (new)", async ({ page }) => {
  await openRun(page, "Paused");
  const head = header(page);
  await expect(head.getByTestId("run-document")).toHaveText("Team workspaces PRD");
  await expect(head.getByTestId("run-header-sep")).toBeVisible();
  await expect(head).not.toContainText("(new)");
  await expect(head).not.toContainText(/PRD\s*Decisions in this run/);
});

test("rirs-18: one cost line per panel on the run page and the runs list", async ({ page }) => {
  await openRun(page, "Awaiting cost approval");
  await expect(inspector(page).getByText("$53.00 estimated")).toHaveCount(1);
  await expect(inspector(page).getByTestId("run-details").getByTestId("run-cost")).toHaveCount(0);

  await page.goto("/runs");
  await row(page, "Succeeded").first().getByTestId("run-status").click();
  await expect(inspector(page).getByText("Cost", { exact: true })).toHaveCount(1);
});

test("rirs-19: a paused run says what Resume lets go on", async ({ page }) => {
  await openRun(page, "Paused");
  await expect(page.getByRole("button", { name: "Resume" })).toBeVisible();
  await expect(page.getByTestId("run-overrun-held")).toHaveText(
    "Spent $14.20, past the $13.50 limit. The PRD review is held until you resume it. Resuming allows up to $4.50 more; Cancel run stops it.",
  );
});

test("rirs-21: the header's Decide goes to the one decision below, not a second one", async ({ page }) => {
  await openRun(page, "team onboarding");
  const go = page.getByTestId("run-go-decide");
  await expect(go).not.toHaveAttribute("data-variant", "primary");
  await expect(go).toHaveAttribute("title", "Go to the decision below");
  await go.click();
  await expect(page.locator("#decide")).toBeFocused();
});

test("rirs-22: with nothing flagged, the baseline link says so instead of '0 need you'", async ({ page }) => {
  await openRun(page, "team onboarding");
  const panel = page.locator("#decide");
  await expect(panel.getByRole("link", { name: "Open the baseline (nothing flagged for you)" })).toBeVisible();
  await expect(panel).not.toContainText("0 need you");
});

test("rirs-23: the For column names the document alone, in full", async ({ page }) => {
  await openRuns(page);
  for (const r of await rows(page).all()) {
    const link = r.getByRole("link").first();
    await expect(link).not.toContainText(" · ");
    expect(await link.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  }
});

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("rirs-24: the run's name shows in full on the page", async ({ page }) => {
    await openRun(page, "team onboarding");
    const name = page.getByTestId("run-name");
    await expect(name).toContainText("Team onboarding");
    // Shown, wrapping within the screen (not a screen-reader-only heading behind a cut top bar).
    const box = (await name.boundingBox())!;
    expect(box.width).toBeGreaterThan(100);
    expect(box.x + box.width).toBeLessThanOrEqual(390);
  });

  test("rirs-25: the back link, the document link and Decisions in this run are 24 px targets", async ({ page }) => {
    await openRun(page, "Paused");
    for (const target of [
      header(page).getByRole("link", { name: "Runs", exact: true }),
      header(page).getByTestId("run-document"),
      header(page).getByTestId("run-decision-log"),
    ]) {
      const box = (await target.boundingBox())!;
      expect(box.height).toBeGreaterThanOrEqual(24);
    }
  });
});

test.describe("phone Waive", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("rirs-25: the run page's Waive… is a full-size tap target", async ({ page }) => {
    await login(page);
    await openSeeded(page, seedConsoleHeld, `/runs/${CONSOLE_HELD_RUN_ID}`);
    const waive = page
      .getByRole("group", { name: "Decide: Roadmap items" })
      .getByTestId("gate-reason")
      .filter({ hasText: "Usage export" })
      .getByRole("button", { name: "Waive…" });
    await expect(waive).toBeVisible();
    expect((await waive.boundingBox())!.height).toBeGreaterThanOrEqual(24);
  });
});
