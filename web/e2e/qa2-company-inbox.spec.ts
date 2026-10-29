import { expect, test, type Locator, type Page } from "./test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";

/*
 * QA round 2 on /inbox and Home's Needs you (Detailed):
 * - qa-company-4: a viewer or commenter is not counted, nor shown, what only an owner or
 *   approver decides (as the API's inbox); Home, the Inbox and the rail badge agree.
 * - qa-company-7: a declined access request leaves Needs you at once for Declined, the banner
 *   says so with Undo, and the count drops.
 * - qa-company-28: money in the app's own font, not a code font.
 * - qa-company-29: one rule on every row: the first action bordered, the rest text.
 * - qa-company-30: an "Oracle did" row has no chevron that only repeats its line.
 * - qa-company-36: "Show the text" is a target of at least 24 px on a phone.
 * - qa-company-42: each action replaces the banner with its own message.
 * - qa-company-43: an empty New says where the waiting items are.
 * - qa-company-44: a viewer gets no Edit on "Sources that need attention".
 */

const NEW_PERSON = "new.person@example.com";
const METRIC = "Add a metric that shows the outbound check works";
const ADDRESS = "Should the most recently used address be selected by default?";

const tabs = (page: Page) => page.getByTestId("inbox-state-tabs");
const tab = (page: Page, name: string) => tabs(page).getByRole("tab", { name: new RegExp(`^${name}`) });
const notice = (page: Page) => page.getByTestId("inbox-acted");
const badge = (page: Page) => page.getByTestId(/^(nav|tab)-inbox-badge$/).filter({ visible: true });
const badgeCount = async (page: Page) => ((await badge(page).count()) ? Number((await badge(page).innerText()).replace(/\D+/g, "") || "0") : 0);
const waitingCount = async (page: Page) => {
  const chip = page.getByText(/^\d+ waiting$/).filter({ visible: true });
  return (await chip.count()) ? Number((await chip.first().innerText()).replace(/\D+/g, "")) : 0;
};
const scenario = (page: Page, name: string) => page.addInitScript(([key, value]) => localStorage.setItem(key, value), [MOCK_SCENARIO_KEY, name] as const);

async function openInbox(page: Page) {
  await page.goto("/inbox");
  await expect(page.getByRole("heading", { level: 1, name: "Inbox" })).toBeVisible();
  await expect(tabs(page)).toBeVisible();
}

for (const role of ["viewer", "commenter"] as const) {
  test(`qa-company-4: a ${role} is not counted what only owners or approvers decide`, async ({ page }) => {
    await login(page, `${role}@example.com`);
    // Home: no cost approval, overrun or checkpoint someone else decides, in Needs you.
    const home = page.getByTestId("home-needs");
    await expect(home).toBeVisible();
    await page.waitForTimeout(1000);
    await expect(home).not.toContainText(/Owners (decide|approve)|Approvers decide/);
    await expect(home.locator('tr[data-need="Cost approval"], tr[data-need="Overrun"]')).toHaveCount(0);

    await openInbox(page);
    await page.waitForTimeout(1000);
    const needs = page.getByTestId("inbox-needs");
    await expect(page.getByTestId("inbox-approvals")).toHaveCount(0);
    await expect(page.getByTestId("inbox-overruns")).toHaveCount(0);
    // Nothing counted reads "Owners decide": such a row, if any, is under For your information.
    for (const t of ["New", "Seen"]) {
      await tab(page, t).click();
      const counted = needs.locator("section:not([data-testid='inbox-fyi'])");
      await expect(counted.getByTestId("need-by-role")).toHaveCount(0);
    }
    // The header, the badge and Home count the same items.
    const waiting = await waitingCount(page);
    await expect.poll(() => badgeCount(page)).toBe(waiting);
  });
}

test("qa-company-7: declining an access request moves it to Declined at once, with Undo", async ({ page }) => {
  await login(page);
  await openInbox(page);
  const newRow = page.getByTestId("inbox-tab-new").getByTestId("inbox-access-requests").locator("tr[data-row]").filter({ hasText: NEW_PERSON });
  await expect(newRow).toHaveCount(1);
  const before = await waitingCount(page);
  await newRow.getByRole("button", { name: "Decline", exact: true }).click();

  // It leaves Needs you at once (no Declined chip left behind), and the count drops.
  await expect(newRow).toHaveCount(0);
  await expect(notice(page)).toContainText(`Declined ${NEW_PERSON}`);
  await expect(page.getByText(`${before - 1} waiting`)).toBeVisible();
  await expect(badge(page)).toHaveText(String(before - 1));
  await tab(page, "Declined").click();
  const declined = page.getByTestId("inbox-tab-declined").getByTestId("inbox-access-requests").locator("tr[data-row]").filter({ hasText: NEW_PERSON });
  await expect(declined).toContainText("Declined");

  // Undo: pending again, counted again.
  await notice(page).getByRole("button", { name: "Undo" }).click();
  await expect(declined).toHaveCount(0);
  await tab(page, "New").click();
  await expect(newRow.getByRole("button", { name: "Approve", exact: true })).toBeVisible();
  await expect(page.getByText(`${before} waiting`)).toBeVisible();
});

test("qa-company-28: money is in the row's own font, tabular, not a code font", async ({ page }) => {
  await login(page);
  await openInbox(page);
  const cost = page.getByTestId("inbox-approvals").locator('[data-cost="prominent"]').first();
  await expect(cost).toBeVisible();
  const [costFont, rowFont, numeric] = await cost.evaluate((el) => {
    const row = el.closest("tr")!;
    return [getComputedStyle(el).fontFamily, getComputedStyle(row).fontFamily, getComputedStyle(el).fontVariantNumeric];
  });
  expect(costFont).toBe(rowFont);
  expect(costFont.toLowerCase()).not.toContain("mono");
  expect(numeric).toContain("tabular-nums");
});

test("qa-company-29: the first action is the bordered one on every feedback row, Decline never leads", async ({ page }) => {
  await scenario(page, "suggestions");
  await login(page);
  await openInbox(page);
  const row = (text: string) => page.getByTestId("inbox-tab-new").getByTestId("inbox-feedback").locator("tr[data-row]").filter({ hasText: text });
  await expect(row(METRIC).getByRole("button", { name: "Accept", exact: true })).toBeVisible();
  const variants = (r: Locator) => r.locator("td").last().locator("button, a").evaluateAll((els) => els.map((e) => `${e.textContent?.trim()}:${e.getAttribute("data-variant")}`));
  // A comment with nothing to accept: Stage for agents leads, bordered; Decline and Open are text.
  expect(await variants(row(ADDRESS))).toEqual(["Stage for agents:secondary", "Decline:ghost", "Open:ghost"]);
  expect(await variants(row(METRIC))).toEqual(["Accept:secondary", "Decline:ghost", "Open:ghost"]);
});

test("qa-company-30: an Oracle did row with no codes has no chevron repeating its line", async ({ page }) => {
  await scenario(page, "oracle-did");
  await login(page);
  await openInbox(page);
  const did = page.getByTestId("inbox-oracle-actions").locator("tr[data-row]").filter({ hasText: "Saved addresses" });
  await expect(did).toContainText("Moved 'Saved addresses' up 2 within Raise activation");
  await expect(did.getByRole("button", { name: "Show the text" })).toHaveCount(0);
});

test("qa-company-42: each action replaces the last one's banner with its own", async ({ page }) => {
  await scenario(page, "suggestions");
  await login(page);
  await openInbox(page);
  const metric = page.getByTestId("inbox-tab-new").getByTestId("inbox-feedback").locator("tr[data-row]").filter({ hasText: METRIC });
  await metric.getByRole("button", { name: "Accept", exact: true }).click();
  await expect(notice(page)).toContainText("Staged for draft");
  // An unrelated action next: the banner says that one, not the Accept.
  const request = page.getByTestId("inbox-access-requests").locator("tr[data-row]").filter({ hasText: NEW_PERSON });
  await request.getByRole("button", { name: "Decline", exact: true }).click();
  await expect(notice(page)).toContainText(`Declined ${NEW_PERSON}`);
  await expect(notice(page)).not.toContainText("Staged for draft");
});

test("qa-company-43: an empty New says how many still wait in Seen, and opens it", async ({ page }) => {
  await login(page);
  await openInbox(page);
  await expect
    .poll(() => page.evaluate(() => Object.keys(JSON.parse(localStorage.getItem("po-mock-db-v2") ?? "{}").inbox_seen ?? {}).length))
    .toBeGreaterThan(0);
  await openInbox(page);
  await expect(tab(page, "Seen")).toHaveAttribute("aria-selected", "true");
  const seen = await tab(page, "Seen").innerText();
  const n = Number(seen.replace(/\D+/g, ""));
  await tab(page, "New").click();
  const empty = page.getByTestId("inbox-tab-empty");
  await expect(empty).toContainText(`Nothing new since your last visit · ${n} still waiting in Seen`);
  await empty.getByRole("button", { name: "Seen" }).click();
  await expect(tab(page, "Seen")).toHaveAttribute("aria-selected", "true");
});

test("qa-company-44: a viewer reads a source needing attention with no Edit", async ({ page }) => {
  await login(page, "viewer@example.com");
  await openInbox(page);
  const group = page.getByTestId("inbox-sources");
  await expect(group).toContainText("Legacy all-hands chat");
  await expect(group.getByTestId("need-by-role")).toHaveText("View only");
  await expect(group.getByRole("link", { name: /^Edit/ })).toHaveCount(0);
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("qa-company-36: Show the text is at least 24 px each way", async ({ page }) => {
    await scenario(page, "named-codes");
    await login(page);
    await openInbox(page);
    const more = page.getByRole("button", { name: "Show the text" }).filter({ visible: true }).first();
    await expect(more).toBeVisible();
    const box = (await more.boundingBox())!;
    expect(box.width).toBeGreaterThanOrEqual(24);
    expect(box.height).toBeGreaterThanOrEqual(24);
  });

  test("qa-company-7: on a phone too, a declined request leaves Needs you at once", async ({ page }) => {
    await login(page);
    await openInbox(page);
    const row = page.getByTestId("inbox-tab-new").getByTestId("inbox-access-requests").locator("tr[data-row]").filter({ hasText: NEW_PERSON });
    await row.getByRole("button", { name: "Decline", exact: true }).click();
    await expect(row).toHaveCount(0);
    await expect(notice(page).getByRole("button", { name: "Undo" })).toBeVisible();
  });
});

test("qa-company-43: back on the Inbox from another page, it opens on Seen once New has emptied", async ({ page }) => {
  await login(page);
  await openInbox(page);
  await expect(tab(page, "New")).toHaveAttribute("aria-selected", "true");
  await page.getByTestId("nav-runs").click();
  await expect(page).toHaveURL(/\/runs$/);
  await page.getByTestId("nav-inbox").click();
  await expect(page).toHaveURL(/\/inbox$/);
  const tabs = page.getByTestId("inbox-state-tabs").filter({ visible: true });
  await expect(tabs.getByRole("tab", { name: /^Seen/ })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("inbox-tab-empty").filter({ visible: true })).toHaveCount(0);
});
