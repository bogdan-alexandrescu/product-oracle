import { expect, test, type Page } from "./test";

import { login } from "./helpers";

/*
 * Fix pass 4 on the Runs list (qa-work-7, 10, 24, 25, 26; qa-onboarding-24), driven through the
 * UI on the mock: who sees the waiting count, what the start button says, the row actions, the
 * Updated column, a row tap on a phone, and the empty list of a new company.
 */

const rows = (page: Page) => page.getByTestId("run-row");
const run = (page: Page, slug: string) => page.locator(`[data-testid="run-row"][data-document="${slug}"]`);
const inspector = (page: Page) => page.getByRole("complementary", { name: "Run" }).filter({ visible: true });

async function openRuns(page: Page, email?: string) {
  await login(page, email);
  await page.goto("/runs");
  await expect(page.getByRole("heading", { level: 1, name: "Runs" })).toBeVisible();
  await expect(rows(page)).toHaveCount(5);
}

test.describe("desktop", () => {
  test.use({ viewport: { width: 1366, height: 820 } });

  for (const email of ["commenter@example.com", "viewer@example.com"]) {
    test(`qa-work-10: ${email.split("@")[0]} sees no "need a decision" count for runs they cannot decide`, async ({ page }) => {
      await openRuns(page, email);
      await expect(page.getByTestId("runs-waiting-others")).toHaveText(/^\d+ runs? waiting on others$/);
      await expect(page.getByTestId("runs-waiting")).toHaveCount(0);
      await expect(page.getByTestId("runs-table").getByRole("button")).toHaveCount(0);
    });
  }

  test("qa-work-10: an owner's count is the runs they can act on", async ({ page }) => {
    await openRuns(page);
    const buttons = page.getByTestId("runs-table").getByRole("button");
    await expect(buttons.first()).toBeVisible();
    const n = await buttons.count();
    await expect(page.getByTestId("runs-waiting")).toHaveText(`${n} ${n === 1 ? "run needs" : "runs need"} a decision`);
  });

  test("qa-work-7: the start button says what it does and every place to start is a link", async ({ page }) => {
    await openRuns(page);
    await expect(page.getByRole("button", { name: "New run", exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "Start a run…" }).click();
    const dialog = page.getByRole("dialog", { name: "Where to start a run" });
    const pointers = dialog.getByTestId("flow-pointer");
    await expect(pointers.first()).toBeVisible();
    const n = await pointers.count();
    await expect(pointers.getByRole("link")).toHaveCount(n);
    const next = pointers.getByRole("link", { name: /^Build next draft/ });
    await expect(next).toHaveAttribute("href", "/documents");
    await next.click();
    await expect(page).toHaveURL(/\/documents$/);
  });

  test("qa-onboarding-24: an approver reads who approves the cost, on the row and in the panel", async ({ page }) => {
    await openRuns(page, "approver@example.com");
    const approval = run(page, "usage-alerts-v2");
    await expect(approval.getByTestId("run-waits-on")).toHaveText(/^Owner approves \$[\d,]+\.\d{2}$/);
    await expect(approval.getByRole("button")).toHaveCount(0);
    await expect(run(page, "team-workspaces").getByTestId("run-waits-on")).toHaveText("Owner resumes");
    await approval.getByTestId("run-status").click();
    await expect(inspector(page)).toContainText("Usage alerts v2");
    await expect(inspector(page)).toContainText("Approves the cost");
    await expect(inspector(page)).toContainText("An owner");
  });

  test("qa-work-24: one button style lined up on the right, chips the same size, rows one line", async ({ page }) => {
    await openRuns(page);
    const buttons = page.getByTestId("runs-table").getByRole("button");
    await expect(buttons).toHaveCount(3);
    const rights: number[] = [];
    for (const b of await buttons.all()) {
      await expect(b).toHaveAttribute("data-variant", "secondary");
      const box = (await b.boundingBox())!;
      rights.push(box.x + box.width);
    }
    for (const r of rights) expect(Math.abs(r - rights[0]!)).toBeLessThanOrEqual(1);
    const paused = run(page, "team-workspaces");
    const [status, cost] = [paused.getByTestId("run-status").locator(".."), paused.locator('[data-cost="prominent"]')];
    await expect(cost).toHaveText("$14.20 of $9.00 estimated");
    const [sb, cb] = [(await status.boundingBox())!, (await cost.boundingBox())!];
    expect(Math.abs(sb.height - cb.height)).toBeLessThanOrEqual(1);
    const size = (l: typeof cost) => l.evaluate((el) => getComputedStyle(el).fontSize);
    expect(await size(cost)).toBe(await size(status));
    for (const r of await rows(page).all()) expect((await r.boundingBox())!.height).toBeLessThanOrEqual(48);
  });

  test("qa-work-25: one Open per run: the selected-run panel has none", async ({ page }) => {
    await openRuns(page);
    await run(page, "team-workspaces").getByTestId("run-status").click();
    await expect(inspector(page)).toContainText("Team workspaces");
    await expect(inspector(page).getByRole("link", { name: "Open" })).toHaveCount(0);
    await expect(run(page, "team-workspaces").getByRole("button", { name: "Open" })).toHaveCount(1);
  });

  test("qa-work-26: an Updated column with friendly dates, not ISO", async ({ page }) => {
    await openRuns(page);
    await expect(page.getByRole("columnheader", { name: "Updated" })).toBeVisible();
    const dates = page.getByTestId("run-updated");
    await expect(dates).toHaveCount(5);
    for (const d of await dates.all()) {
      await expect(d).toBeVisible();
      await expect(d).toHaveText(/^[A-Z][a-z]{2} \d{1,2}(, \d{4})?$/);
      await expect(d).toHaveAttribute("title", /^[A-Z][a-z]{2} \d{1,2}, \d{1,2}:\d{2} [AP]M [A-Z]+/);
    }
  });

  test("onboarding: a new company's Runs reads as empty, with where to start", async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem("po-mock-scenario", "empty");
      if (!sessionStorage.getItem("fix4-reset")) {
        localStorage.removeItem("po-mock-db-v2");
        sessionStorage.setItem("fix4-reset", "1");
      }
    });
    await login(page);
    await page.goto("/runs");
    await expect(page.getByRole("heading", { level: 1, name: "Runs" })).toBeVisible();
    const empty = page.getByTestId("runs-empty");
    await expect(empty).toContainText("No runs yet.");
    await expect(empty).toContainText("Start one from Start a run… or from the page it works on.");
    await expect(rows(page)).toHaveCount(0);
    await expect(page.getByTestId("runs-waiting")).toHaveCount(0);
    await expect(page.getByTestId("runs-waiting-others")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Start a run…" })).toBeVisible();
  });
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("qa-work-25: a row tap opens the run; no selected-run panel below the list", async ({ page }) => {
    await openRuns(page);
    await expect(inspector(page)).toHaveCount(0);
    await run(page, "checkout-redesign").locator('td[data-phone="meta"]').first().click();
    await expect(page).toHaveURL(/\/runs\/[0-9a-f-]+$/);
  });

  test("qa-onboarding-24, 26: an approver's stacked row says who approves and when it moved", async ({ page }) => {
    await openRuns(page, "approver@example.com");
    const approval = run(page, "usage-alerts-v2");
    await expect(approval.getByTestId("run-waits-on")).toBeVisible();
    await expect(approval.getByTestId("run-waits-on")).toHaveText(/^Owner approves \$/);
    await expect(approval.getByTestId("run-updated")).toBeVisible();
    const box = (await approval.boundingBox())!;
    expect(box.x + box.width).toBeLessThanOrEqual(390);
  });
});
