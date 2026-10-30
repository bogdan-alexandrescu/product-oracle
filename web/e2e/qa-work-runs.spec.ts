import { expect, test, type Page } from "./test";

import { ROADMAP_REVIEW_RUN } from "../lib/api/mock/runs";
import { MOCK_ROLE_KEY } from "../lib/api/mock/server";

import { login, openSeeded, seedRoadmapReview } from "./helpers";

/*
 * QA pass on /runs and a run's page (qa-work-1, 4, 7, 8, 9, 10, 17, 20, 23, 24, 25, 26, 27, 28,
 * 29, 30, 54), driven through the UI on the mock.
 */

const RUN = ROADMAP_REVIEW_RUN.run.id;
const rows = (page: Page) => page.getByTestId("run-row");
const row = (page: Page, name: string) => rows(page).filter({ hasText: name });
const inspector = (page: Page) => page.getByRole("complementary", { name: "Run" }).filter({ visible: true });

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
}

const asRole = (page: Page, role: string) => page.addInitScript(([key, r]) => localStorage.setItem(key, r), [MOCK_ROLE_KEY, role] as const);
const asViewer = (page: Page) => asRole(page, "viewer");

test("qa-work-1: a viewer gets no Approve (or any action) on a run waiting for cost approval", async ({ page }) => {
  await asViewer(page);
  await openRuns(page);
  const approval = row(page, "Awaiting cost approval");
  await expect(approval).toHaveCount(1);
  await expect(approval.getByRole("button")).toHaveCount(0);
  await expect(row(page, "Paused").getByRole("button")).toHaveCount(0);
});

test("qa-work-17: row buttons say what they do: Open for an approval and an overrun, Decide for a checkpoint", async ({ page }) => {
  await openRuns(page);
  await expect(row(page, "Awaiting cost approval").getByRole("button")).toHaveText(["Open"]);
  await expect(row(page, "Paused").getByRole("button")).toHaveText(["Open"]);
  await expect(row(page, "team onboarding").getByRole("button")).toHaveText(["Decide"]);
  await row(page, "Paused").getByRole("button", { name: "Open" }).click();
  await expect(page).toHaveURL(/\/runs\/[0-9a-f-]+$/);
  // The run page's own action for an overrun.
  await expect(page.getByRole("button", { name: "Resume" })).toBeVisible();
});

test("fix-work review: an approver gets Decide on a checkpoint an approver decides, a commenter does not", async ({ page }) => {
  await asRole(page, "approver");
  await openRuns(page);
  await expect(row(page, "team onboarding").getByRole("button")).toHaveText(["Decide"]);
  await row(page, "team onboarding").getByRole("button", { name: "Decide" }).click();
  await expect(page).toHaveURL(/\/runs\/[0-9a-f-]+/);
});

test("fix-work review: a commenter gets no Decide on the runs list", async ({ page }) => {
  await asRole(page, "commenter");
  await openRuns(page);
  await expect(row(page, "team onboarding")).toHaveCount(1);
  await expect(row(page, "team onboarding").getByRole("button")).toHaveCount(0);
});

test("qa-work-9, 10, 23, 25: names not slugs or ids, one waiting count, flows in full on hover, one cost format", async ({ page }) => {
  await openRuns(page);
  // One count of the runs waiting on a decision; no second "checkpoints" or "waiting" count.
  await expect(page.getByTestId("runs-waiting")).toHaveText(/^\d+ runs? needs? a decision$/);
  await expect(page.getByText(/^\d+ checkpoints?$/)).toHaveCount(0);
  await expect(page.getByText(/^\d+ waiting$/)).toHaveCount(0);
  // Rows are named by their documents' titles: no slug, no hex id, no code font.
  for (const r of await rows(page).all()) {
    const name = (await r.getByRole("link").first().innerText()).trim();
    expect(name).not.toMatch(/-/);
    expect(name).not.toMatch(/^[0-9a-f]{4}$/);
  }
  await expect(rows(page).locator(".font-mono")).toHaveCount(0);
  // The flow's name shows in full on hover.
  await expect(row(page, "team onboarding").locator('[title="Baseline to PRD"]')).toHaveCount(1);
  // One cost format, in the normal font.
  const overrun = row(page, "Paused").locator("[data-cost]");
  await expect(overrun).toHaveText("$14.20 of $9.00 estimated");
  await expect(overrun).not.toHaveClass(/font-mono/);
  await expect(row(page, "Awaiting cost approval").locator("[data-cost]")).toHaveText(/^\$[\d,.]+ estimated$/);
  // The inspector is titled by the run's name, not its slug.
  await row(page, "team onboarding").getByTestId("run-status").click();
  await expect(inspector(page)).toContainText("Team onboarding");
  await expect(inspector(page)).not.toContainText("team-onboarding");
});

test("qa-work-7: New run is a guide to where runs start, with no disabled Estimate or Start run", async ({ page }) => {
  await openRuns(page);
  await page.getByRole("button", { name: "Start a run…" }).click();
  const dialog = page.getByRole("dialog", { name: "Where to start a run" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId("flow-guide")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Start run" })).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "Estimate" })).toHaveCount(0);
  await dialog.getByRole("button", { name: "Close" }).last().click();
  await expect(dialog).toHaveCount(0);
});

test("qa-work-8, 24, 26, 4: a roadmap run's page in words, one Review items, the review screen's counts", async ({ page }) => {
  await login(page);
  await openSeeded(page, seedRoadmapReview, `/runs/${RUN}`);
  const header = page.locator("header[data-page-header]").filter({ visible: true });
  // The document and the template by name, in the normal font.
  await expect(header.getByTestId("run-document")).toHaveText("Usage alerts roadmap (written by this run)");
  await expect(header.getByTestId("run-document")).not.toHaveClass(/font-mono/);
  await expect(header.getByTestId("run-template")).toContainText("Template: Now / Next / Later");
  // Roles by their names, files in words (their names on hover).
  const segment = page.getByTestId("segment-roadmap_items");
  const roles = segment.getByTestId("segment-role");
  await expect(roles.first()).toBeVisible();
  for (const text of await roles.allInnerTexts()) expect(text).toMatch(/^[A-Z]/);
  const file = segment.getByTestId("artifacts-current").getByRole("button").first();
  await expect(file).toHaveText("Roadmap items");
  await expect(file).toHaveAttribute("title", "roadmap_items.yaml");
  // qa-work-24: a segment's name wraps rather than being cut.
  await expect(segment.getByTestId("segment-title")).toHaveCSS("white-space", "normal");
  // qa-work-26: one Review items action, no header Decide to the same screen.
  const main = page.getByRole("main");
  await expect(main.getByRole("link", { name: "Decide", exact: true })).toHaveCount(0);
  await expect(main.getByRole("link", { name: "Review items" })).toHaveCount(1);
  // qa-work-4: the run page's counts are the review screen's, in its words.
  const open = segment.getByTestId("items-open");
  await expect(open).toHaveText(/^\d+ blocking · \d+ to confirm$/);
  await expect(segment.getByTestId("items-check-summary")).toContainText(` · ${(await open.innerText()).trim()}`);
  const runCounts = (await open.innerText()).trim();
  await main.getByRole("link", { name: "Review items" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Roadmap items" })).toBeVisible();
  await expect(page.getByTestId("review-summary")).toHaveText(runCounts);
});

test("qa-work-20, 28, 54, 27: a waiting run's page: status-aware check, labels not links, plain details, a Delete button", async ({ page }) => {
  await openRun(page, "team onboarding");
  // qa-work-28: the waiting pill is a label (no link); Refresh progress is a button like Cancel run.
  const waiting = page.getByTestId("segment-baseline").getByTestId("checkpoint-waiting");
  await expect(waiting).toBeVisible();
  await expect(waiting.locator("a")).toHaveCount(0);
  await expect(page.locator('a[href="#decide"]')).toHaveCount(0);
  const check = page.getByRole("button", { name: "Refresh progress" });
  await expect(check).toHaveAttribute("data-variant", "secondary");
  // qa-work-20: what the check found, for this run.
  await check.click();
  await expect(page.getByTestId("tick-result")).toHaveText("No agents are working right now; the run is waiting for your review.");
  // qa-work-54: plain words in the details.
  const details = inspector(page).getByTestId("run-details");
  await expect(details).toContainText("How thorough");
  await expect(details).toContainText("Where it runs");
  await expect(details).not.toContainText("Depth");
  await expect(details).not.toContainText("Runtime");
  await expect(details).not.toContainText("none open");
  // qa-work-25: one format on the run page too.
  await expect(details.getByTestId("run-cost")).toHaveText(/^\$[\d,.]+ of \$[\d,.]+ estimated$/);
  // qa-work-27, qa-onboarding-16: no menu holding one item; a waiting run is cancelled (not deleted) here.
  await expect(page.getByTestId("run-delete")).toHaveCount(0);
  await expect(page.getByTestId("run-cancel")).toHaveText("Cancel run");
  await expect(page.getByRole("button", { name: /^Actions for / })).toHaveCount(0);
});

test("qa-work-27: a run no segment of which started says Not started, not Segment 1 of 4", async ({ page }) => {
  await openRun(page, "Awaiting cost approval");
  await expect(inspector(page).getByTestId("run-progress")).toHaveText("Not started");
  await expect(inspector(page)).not.toContainText(/Segment \d of \d/);
});

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("qa-work-29: each run's link is a 44 px target", async ({ page }) => {
    await openRuns(page);
    for (const r of await rows(page).all()) {
      const box = (await r.getByRole("link").first().boundingBox())!;
      expect(box.height).toBeGreaterThanOrEqual(44);
    }
  });

  test("qa-work-30: a run's page fits the phone: nothing wider than the screen", async ({ page }) => {
    await login(page);
    await openSeeded(page, seedRoadmapReview, `/runs/${RUN}`);
    await expect(page.getByTestId("segment-roadmap_items")).toBeVisible();
    await expect(page.getByTestId("run-document").filter({ visible: true })).toHaveText("Usage alerts roadmap (written by this run)");
    const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(over).toBeLessThanOrEqual(0);
    const header = page.locator("header[data-page-header]").filter({ visible: true });
    const box = (await header.boundingBox())!;
    expect(box.x + box.width).toBeLessThanOrEqual(390);
  });
});
