import { expect, test, type Page } from "./test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";

const BASELINE_RUN = "7a11c0de-0000-4000-8000-0000000000b2";

/*
 * QA findings on /inbox (Detailed): Cancel run asks first (qa-company-1), the Inbox opens on
 * the tab holding what waits (qa-company-2, qa-shell-7), the Seen tab (qa-company-48), only
 * the actions a role can take (qa-company-3, qa-shell-1), one line of actions per row
 * (qa-company-9), runs named in words with no short id or section key (qa-company-11,
 * qa-shell-32), Confirm the baseline's line (qa-company-12), ages in one unit and never a
 * dash (qa-company-46), and the tabs on one line on a phone (qa-company-47).
 */

const tabs = (page: Page) => page.getByTestId("inbox-state-tabs");
const tab = (page: Page, name: string) => tabs(page).getByRole("tab", { name: new RegExp(`^${name}`) });
const overrun = (page: Page) => page.getByTestId("inbox-overruns").locator("tr[data-row]").first();

async function openInbox(page: Page, role?: "viewer" | "commenter" | "approver") {
  await login(page, role ? `${role}@example.com` : undefined);
  await page.goto("/inbox");
  await expect(page.getByRole("heading", { level: 1, name: "Inbox" })).toBeVisible();
  await expect(tabs(page)).toBeVisible();
}

test("Cancel run on an overrun asks first; Back keeps the run", async ({ page }) => {
  await openInbox(page);
  await expect(overrun(page)).toContainText("Spent $14.20 of $9.00 estimated");
  await overrun(page).getByRole("button", { name: "Cancel run" }).click();
  const ask = page.getByRole("alertdialog", { name: "Cancel run" });
  await expect(ask).toContainText("Cancel this run? Agents still working are stopped.");
  await ask.getByRole("button", { name: "Back" }).click();
  await expect(ask).toHaveCount(0);
  await expect(page.getByTestId("inbox-overruns").locator("tr[data-row]")).toHaveCount(1);

  await overrun(page).getByRole("button", { name: "Cancel run" }).click();
  await ask.getByRole("button", { name: "Cancel run" }).click();
  await expect(page.getByTestId("inbox-overruns")).toHaveCount(0);
});

test("a second visit opens on Seen, where the waiting items are, never on 'Nothing new'", async ({ page }) => {
  await openInbox(page);
  await expect(tab(page, "New")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByText("11 waiting")).toBeVisible();
  // The visit is recorded; the next one finds every item seen.
  await expect
    .poll(() => page.evaluate(() => Object.keys(JSON.parse(localStorage.getItem("po-mock-db-v2") ?? "{}").inbox_seen ?? {}).length))
    .toBeGreaterThan(0);
  await page.goto("/inbox");
  await expect(page.getByText("11 waiting")).toBeVisible();
  // The tab is "Seen", not "Open" (Open is each row's action).
  await expect(tabs(page).getByRole("tab", { name: /^Open/ })).toHaveCount(0);
  await expect(tab(page, "Seen")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("inbox-tab-open").locator("tr[data-row]").first()).toBeVisible();
  await expect(page.getByText("Nothing new")).toHaveCount(0);
});

for (const role of ["viewer", "commenter"] as const) {
  test(`a ${role} is offered no Approve, Resume, Cancel run or Accept, nor shown runs only owners decide`, async ({ page }) => {
    await openInbox(page, role);
    // Let the role's capabilities arrive before counting buttons.
    await page.waitForTimeout(1000);
    const needs = page.getByTestId("inbox-needs");
    await expect(needs.getByRole("button", { name: /^(Approve|Resume|Cancel run|Accept)\b/ })).toHaveCount(0);
    // qa-company-4 (as the API): cost approvals and overruns wait on owners only.
    await expect(page.getByTestId("inbox-approvals")).toHaveCount(0);
    await expect(page.getByTestId("inbox-overruns")).toHaveCount(0);
  });
}

test("an approver is not offered Resume, Cancel run or Approve on a run someone else started", async ({ page }) => {
  // Resume and Approve are an owner's: as the API, those rows wait on owners only (qa-company-4).
  await openInbox(page, "approver");
  await expect(tabs(page)).toBeVisible();
  await expect(page.getByTestId("inbox-needs").getByRole("button", { name: /^(Resume|Cancel run)\b/ })).toHaveCount(0);
  await expect(page.getByTestId("inbox-overruns")).toHaveCount(0);
  await expect(page.getByTestId("inbox-approvals")).toHaveCount(0);
});

test("a row's actions sit on one line, each the same height", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openInbox(page);
  const resume = await overrun(page).getByRole("button", { name: "Resume" }).boundingBox();
  const cancel = await overrun(page).getByRole("button", { name: "Cancel run" }).boundingBox();
  const approve = await page.getByTestId("inbox-approvals").getByRole("button", { name: /^Approve/ }).first().boundingBox();
  expect(resume && cancel && approve).toBeTruthy();
  expect(Math.abs(resume!.y - cancel!.y)).toBeLessThan(2);
  expect(Math.abs(resume!.height - cancel!.height)).toBeLessThan(1);
  expect(Math.abs(resume!.height - approve!.height)).toBeLessThan(1);
  // "Cancel run" keeps one line.
  expect(cancel!.height).toBeLessThan(44);
});

test("runs are named in words: no short id, slug, section key or code font", async ({ page }) => {
  await openInbox(page);
  const needs = page.getByTestId("inbox-needs");
  await expect(overrun(page)).toContainText("Team workspaces");
  await expect(page.getByTestId("inbox-approvals")).toContainText("Usage alerts v2");
  await expect(needs).not.toContainText("usage-alerts-v2");
  await expect(needs).not.toContainText("team-workspaces");
  await expect(needs).not.toContainText(/#s-\d/);
  await expect(needs.getByRole("columnheader", { name: "Run" })).toHaveCount(0);
});

test("Confirm the baseline says what needs me in words, never '0 need you'", async ({ page }) => {
  // The default seed's baseline run has no rows left: said in words, with no zero counts.
  await openInbox(page);
  const label = () => page.getByTestId("inbox-checkpoints").getByTestId("checkpoint-label").filter({ hasText: "Confirm the baseline" });
  await expect(label()).toHaveText(/^Confirm the baseline: (approve to continue|all \d+ items? handled, approve to continue)$/);
  await expect(page.getByTestId("inbox-needs")).not.toContainText(/\b0 need you|\b0 not decided/);
});

test("Confirm the baseline with work left counts it in words", async ({ page }) => {
  // The "baseline-review" scenario: a run whose rows still need the owner.
  await page.addInitScript(([key, value]) => localStorage.setItem(key, value), [MOCK_SCENARIO_KEY, "baseline-review"] as const);
  await openInbox(page);
  const row = page.locator("tr[data-row]").filter({ has: page.locator(`a[href="/baseline?run=${BASELINE_RUN}"]`) }).filter({ visible: true });
  await expect(row.getByTestId("checkpoint-label")).toHaveText("Confirm the baseline: 4 need you, 2 not decided");
});

test("ages are in one unit, never a dash or more than 23 hours", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openInbox(page);
  const rows = page.getByTestId("inbox-needs").locator("tr[data-row]");
  await expect(rows.first()).toBeVisible();
  const ages = await rows.evaluateAll((trs) => trs.map((tr) => (tr.querySelectorAll("td")[3]?.textContent ?? "").replace(/\d+\s*h left.*$/, "").trim()));
  for (const a of ages) {
    expect(a).not.toContain("–");
    const hours = /^(\d+)h/.exec(a);
    if (hours) expect(Number(hours[1])).toBeLessThan(24);
  }
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("the state tabs keep one line", async ({ page }) => {
    await openInbox(page);
    const tops = await tabs(page)
      .getByRole("tab")
      .evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().top)));
    expect(tops).toHaveLength(5);
    expect(new Set(tops).size).toBe(1);
    await expect(tab(page, "Seen")).toBeVisible();
  });
});
