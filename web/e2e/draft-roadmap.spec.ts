import { expect, test, type Page } from "@playwright/test";

import { login, section, signOut } from "./helpers";

// E1 Roadmap per PRD draft: every PRD version has Document and Roadmap tabs; Roadmap shows
// the items-only roadmap Oracle derived from that draft. The mock seeds checkout-redesign
// v1 (4 items, no problems) and v2 (4 items: 3 Now, 1 Next; Saved addresses carries an
// unverified date) in lib/api/mock/draft-roadmap.ts.

const PRD = "/documents/checkout-redesign";

// Next keeps recently visited routes mounted (hidden): only the visible page's elements.
const visible = (page: Page, testId: string) => page.getByTestId(testId).filter({ visible: true });
const rows = (page: Page) => visible(page, "roadmap-item-row");
const row = (page: Page, key: string) => page.locator(`[data-testid="roadmap-item-row"][data-key="${key}"]`).filter({ visible: true });
const status = (page: Page) => visible(page, "draft-roadmap-status");

/**
 * Oracle's ticker: POST /v1/internal/tick. The mock API lives in the page, so the call goes
 * through the mock's own fetch, as page.request would reach the real API.
 */
async function tick(page: Page) {
  const code = await page.evaluate(async () => {
    const fetchMock = (globalThis as { __poMockFetch?: (r: Request) => Promise<Response> }).__poMockFetch!;
    const res = await fetchMock(new Request(new URL("/v1/internal/tick", location.origin), { method: "POST" }));
    return res.status;
  });
  expect(code).toBe(200);
}

// Card tabs-and-rows: protects = a PRD version has Document and Roadmap N tabs, and the
// Roadmap tab shows the draft's items grouped by horizon with the check's problem as a
// notice linking to its row and as a chip on the row (AC16); fails_when = the tab or count
// is missing, the grouping is wrong, or the problem is not on the row or not linked;
// no_claim = the real API's derivation (mocked by lib/api/mock/draft-roadmap.ts).
test("a PRD version has Document and Roadmap 4 tabs; Roadmap shows 3 Now, 1 Next and the problem on its row", async ({ page }) => {
  await login(page);
  await page.goto(`${PRD}/v/2`);
  await expect(visible(page, "version-tab-document")).toHaveText("Document");
  await expect(visible(page, "version-tab-document")).toHaveAttribute("aria-current", "page");
  const tab = visible(page, "version-tab-roadmap");
  await expect(tab).toHaveText("Roadmap 4");
  await tab.click();
  await expect(page).toHaveURL(new RegExp(`${PRD}/v/2/roadmap$`));
  await expect(visible(page, "version-tab-roadmap")).toHaveAttribute("aria-current", "page");

  const pane = visible(page, "draft-roadmap");
  await expect(pane).toContainText("Proposed by draft v2 · not an approved roadmap");
  await expect(status(page)).toHaveAttribute("data-status", "ready");
  await expect(status(page)).toContainText(/^4 items · 3 Now · 1 Next · derived \d{1,2} \w{3}, \d\d:\d\d · 1 problem/);
  await expect(rows(page)).toHaveCount(4);
  const groups = pane.getByTestId("roadmap-group");
  await expect(groups).toHaveCount(2);
  await expect(groups.nth(0)).toHaveAttribute("data-horizon", "now");
  await expect(groups.nth(0)).toContainText("3");
  await expect(groups.nth(1)).toHaveAttribute("data-horizon", "next");
  await expect(groups.nth(1)).toContainText("1");
  await expect(pane.locator('[data-testid="roadmap-group"][data-horizon="now"]')).toHaveCount(1);

  const saved = row(page, "saved-addresses");
  await expect(saved).toContainText("Saved addresses");
  await expect(saved.getByTestId("draft-roadmap-chips")).toHaveText("Date unverified");
  // The other rows carry no problem chip.
  await expect(pane.getByTestId("draft-roadmap-chips")).toHaveCount(1);
  // No State column on draft items.
  await expect(visible(page, "roadmap-items-table").locator("thead th", { hasText: /^State$/ })).toHaveCount(0);

  const notice = visible(page, "draft-roadmap-problem");
  await expect(notice).toHaveCount(1);
  await expect(notice).toContainText("Date unverified");
  await notice.getByTestId("draft-roadmap-problem-link").click();
  await expect(saved).toHaveAttribute("aria-selected", "true");
  await expect(visible(page, "roadmap-item-inspector")).toContainText("Saved addresses");
});

// Card derive-and-poll: protects = an approver's Derive again queues the version, keeps the
// current items, and the page shows the new items once the ticker has run, by polling
// without a reload (AC17); fails_when = no Queued state, the items vanish while queued, or
// the page needs a reload to see the result; no_claim = the ticker's timing in production
// and what the agents derive.
test("an approver's Derive again shows Queued, and after two ticks the page shows the items without a reload", async ({ page }) => {
  await login(page, "approver@example.com");
  await page.goto(`${PRD}/v/1/roadmap`);
  await expect(status(page)).toHaveAttribute("data-status", "ready");
  await expect(rows(page)).toHaveCount(4);
  await status(page).getByRole("button", { name: "Derive again" }).click();
  await expect(status(page)).toHaveAttribute("data-status", "queued");
  await expect(status(page)).toHaveText("Queued. Oracle starts deriving within a minute.");
  // No Derive while it is queued; the current items stay.
  await expect(status(page).getByRole("button")).toHaveCount(0);
  await expect(rows(page)).toHaveCount(4);

  await tick(page);
  await expect(status(page)).toHaveAttribute("data-status", "running", { timeout: 15_000 });
  await expect(status(page)).toContainText("Deriving roadmap items from v1 · started");
  await expect(status(page).getByRole("link", { name: "Open run" })).toHaveAttribute("href", /^\/runs\/[0-9a-f-]+$/);
  await tick(page);
  await expect(status(page)).toHaveAttribute("data-status", "ready", { timeout: 15_000 });
  await expect(status(page)).toContainText(/^4 items · 2 Now · 1 Next · 1 Later · derived/);
  await expect(rows(page)).toHaveCount(4);
  await expect(row(page, "wallet-pay")).toBeVisible();
});

// Card role-gates: protects = viewers see no Derive and no owner switch, approvers Derive
// only, owners both, and the owner's switch is saved (AC18); fails_when = a viewer sees
// Derive, an approver sees the switch, or unticking does not survive a reload; no_claim =
// the API's own 403s (the mock answers the same way).
test("Derive and the owner switch by role; unticking the switch persists across a reload", async ({ page }) => {
  const URL = `${PRD}/v/2/roadmap`;
  for (const who of ["viewer@example.com", "commenter@example.com"]) {
    await login(page, who);
    await page.goto(URL);
    await expect(status(page)).toHaveAttribute("data-status", "ready");
    await expect(visible(page, "draft-roadmap").getByRole("button", { name: /Derive/ })).toHaveCount(0);
    await expect(page.getByTestId("draft-roadmap-auto")).toHaveCount(0);
    await signOut(page);
  }

  await login(page, "approver@example.com");
  await page.goto(URL);
  await expect(status(page).getByRole("button", { name: "Derive again" })).toBeVisible();
  await expect(page.getByTestId("draft-roadmap-auto")).toHaveCount(0);
  await signOut(page);

  await login(page);
  await page.goto(URL);
  await expect(status(page).getByRole("button", { name: "Derive again" })).toBeVisible();
  const auto = visible(page, "draft-roadmap-auto");
  const box = auto.getByRole("checkbox", { name: "Derive for each new draft" });
  await expect(box).toBeChecked();
  await auto.getByRole("button", { name: "About deriving for each new draft" }).click();
  await expect(page.getByText("About $5.50 per draft at standard depth. Runs in the background.").filter({ visible: true })).toBeVisible();
  await box.uncheck();
  await expect(box).not.toBeChecked();
  await expect(box).toBeEnabled();
  await page.reload();
  await expect(visible(page, "draft-roadmap-auto").getByRole("checkbox", { name: "Derive for each new draft" })).not.toBeChecked();
});

// Card open-section: protects = a row's "Open PRD section" opens the Document tab of the
// same version at the item's section (AC19); fails_when = the link points elsewhere or the
// section is not opened; no_claim = comments on that section (unchanged).
test("Open PRD section goes to the Document tab with the item's section open", async ({ page }) => {
  await login(page);
  await page.goto(`${PRD}/v/2/roadmap`);
  await row(page, "saved-addresses").getByRole("link", { name: "Open PRD section" }).click();
  await expect(page).toHaveURL(new RegExp(`${PRD}/v/2#s-5-3$`));
  await expect(visible(page, "version-tab-document")).toHaveAttribute("aria-current", "page");
  await expect(section(page, "s-5-3")).toBeVisible();
  await expect(section(page, "s-5-3")).toContainText("5.3 Saved addresses");
});

// Card draft-phone: protects = at 390 px the tab bar fits, rows stack, a tap opens the
// inspector in a sheet and nothing scrolls sideways (AC20); fails_when = the page overflows
// or no sheet opens; no_claim = other phone layouts of the version view.
test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });
  test("at 390 px the tabs fit, rows stack and the inspector opens in a sheet", async ({ page }) => {
    await login(page);
    await page.goto(`${PRD}/v/2/roadmap`);
    const tabs = visible(page, "version-tabs");
    await expect(tabs).toBeVisible();
    const box = (await tabs.boundingBox())!;
    expect(box.x + box.width).toBeLessThanOrEqual(390);
    for (const t of ["version-tab-document", "version-tab-roadmap"]) {
      const b = (await visible(page, t).boundingBox())!;
      expect(b.x + b.width).toBeLessThanOrEqual(390);
    }
    const saved = row(page, "saved-addresses");
    await expect(saved).toBeVisible();
    // Stacked: the row is one card no wider than the screen.
    const r = (await saved.boundingBox())!;
    expect(r.x + r.width).toBeLessThanOrEqual(390);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);

    await expect(visible(page, "roadmap-item-inspector")).toHaveCount(0);
    await saved.click();
    const sheet = visible(page, "sheet-item");
    await expect(sheet).toBeVisible();
    await expect(sheet.getByTestId("roadmap-item-inspector")).toContainText("Saved addresses");
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  });
});

// Card reuse-items (part B, "Reuse items"): protects = Build roadmap on an approved PRD
// version whose draft items are ready shows the Roadmap items row reused at $0.00 and the
// lower total, and ticking "Derive the items again" brings back the $5.50 row and the
// higher total (AC21a); fails_when = the reused row costs anything, names no version, or
// the advanced option does not change the estimate; no_claim = the run itself (the API's
// test_draft_roadmaps_reuse.py) and the derivation's items (mocked).
test("Build roadmap reuses the approved version's draft items, unless asked to derive them again", async ({ page }) => {
  await login(page, "approver@example.com");
  // usage-alerts v1 is approved and has no draft items yet: derive them first.
  await page.goto("/documents/usage-alerts/v/1/roadmap");
  await expect(status(page)).toHaveAttribute("data-status", "none");
  await status(page).getByRole("button", { name: "Derive now" }).click();
  await expect(status(page)).toHaveAttribute("data-status", "queued");
  await tick(page);
  await tick(page);
  await expect(status(page)).toHaveAttribute("data-status", "ready", { timeout: 15_000 });

  await page.getByRole("button", { name: "Build roadmap" }).filter({ visible: true }).click();
  const dialog = page.getByRole("dialog", { name: "Build roadmap" });
  await expect(dialog).toContainText("Usage alerts PRD v1");
  await dialog.getByRole("button", { name: "Estimate" }).click();
  const items = dialog.getByTestId("estimate-row-roadmap_items");
  await expect(items).toHaveText(/^Roadmap items · reused from v1\s*\$0\.00$/);
  await expect(dialog.getByTestId("estimate-total")).toHaveText("$9.00");

  await dialog.getByText("Advanced options").click();
  await dialog.getByRole("checkbox", { name: "Derive the items again" }).check();
  // The estimate was for the other choice: estimate again.
  await expect(dialog.getByTestId("estimate")).toHaveCount(0);
  await dialog.getByRole("button", { name: "Re-estimate" }).click();
  await expect(items).toHaveText(/^Roadmap items\s*\$5\.50$/);
  await expect(dialog.getByTestId("estimate-total")).toHaveText("$14.50");
});
