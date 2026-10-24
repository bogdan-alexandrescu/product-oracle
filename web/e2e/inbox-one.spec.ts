import { expect, test, type Page } from "./test";

import { login } from "./helpers";

/*
 * ONE Inbox (owner, 2026-10-20): every kind of item in a single list with state tabs New
 * (default on arrival) / Open / Staged / Declined / Done, each item drawn once; the rail
 * badge counts each new or open item and equals New + Open; Home's Needs you lists the same.
 */

const tabs = (page: Page) => page.getByTestId("inbox-state-tabs");
const tab = (page: Page, name: string) => tabs(page).getByRole("tab", { name: new RegExp(`^${name}`) });
const tabCount = async (page: Page, name: string) => Number((await tab(page, name).innerText()).replace(/\D+/g, "") || "0");

test("the badge counts each new or open item and equals New + Open; no item is drawn twice", async ({ page }) => {
  await login(page);
  await page.goto("/inbox");
  await expect(tab(page, "New")).toHaveAttribute("aria-selected", "true");
  const badge = page.getByTestId("nav-inbox-badge");
  // The seed's 10 and the pending access request (A5, #203 part 3).
  await expect(badge).toHaveText("11");
  expect((await tabCount(page, "New")) + (await tabCount(page, "Open"))).toBe(11);
  await expect(page.getByText("11 waiting")).toBeVisible();

  // Every kind under New on a first visit, the feedback one row per item (no per-document row).
  const panel = page.getByTestId("inbox-tab-new");
  await expect(panel.getByTestId("inbox-checkpoints")).toBeVisible();
  await expect(panel.getByTestId("inbox-approvals")).toBeVisible();
  await expect(panel.getByTestId("inbox-overruns")).toBeVisible();
  await expect(panel.getByTestId("inbox-access-requests").locator("tr[data-row]")).toHaveCount(1);
  await expect(panel.getByTestId("inbox-questions").locator("tr[data-row]")).toHaveCount(2);
  const feedback = panel.getByTestId("inbox-feedback").locator("tr[data-row]");
  await expect(feedback).toHaveCount(5);
  await expect(panel).not.toContainText("to accept or dismiss");
  // D14: a comment without a suggestion is declined or opened; Oracle's suggestion is accepted here.
  await expect(feedback.filter({ hasText: "most recently used address" }).getByRole("button", { name: "Decline", exact: true })).toBeVisible();
  await expect(feedback.filter({ hasText: "custom roles" }).getByRole("button", { name: "Accept", exact: true })).toBeVisible();

  // Each row once across all five tabs.
  const seen = new Map<string, string>();
  for (const name of ["New", "Open", "Staged", "Declined", "Done"]) {
    await tab(page, name).click();
    const rows = page.locator("[role=tabpanel] tr[data-row]");
    for (const text of await rows.allInnerTexts()) {
      const key = text.replace(/\s+/g, " ").trim();
      expect(seen.get(key), `"${key}" drawn under ${seen.get(key)} and ${name}`).toBeUndefined();
      seen.set(key, name);
    }
  }
  // Staged, declined and done never count.
  await expect(badge).toHaveText("11");
});

test("staged items wait for the next draft: Build draft N+1, and the link opens the panel on Staged", async ({ page }) => {
  await login(page);
  await page.goto("/inbox");
  await tab(page, "Staged").click();
  const staged = page.getByTestId("inbox-tab-staged");
  await expect(staged.getByTestId("staged-row-label")).toHaveText("2 changes staged for draft 6");
  await expect(staged.getByTestId("inbox-build-draft")).toHaveText("Build draft 6");
  expect(await tabCount(page, "Staged")).toBe(2);
  // One group per document: a single Build draft, and each staged item listed once under it.
  await expect(staged.getByRole("link", { name: /^Build draft/ })).toHaveCount(1);
  await expect(staged.locator("tr[data-row]")).toHaveCount(3);
  const itemTexts = (await staged.locator("tr[data-row]").allInnerTexts()).slice(1).map((t) => t.replace(/\s+/g, " ").trim());
  expect(new Set(itemTexts).size).toBe(itemTexts.length);
  await staged.getByTestId("staged-row-label").click();
  await expect(page).toHaveURL(/\/v\/5\?feedback=staged/);
  const state = page.getByTestId("feedback-state").filter({ visible: true });
  await expect(state.getByRole("button", { name: /^Staged/ })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("feedback-item").filter({ visible: true }).first()).toHaveAttribute("data-state", "staged");
});

test("a second visit: what was new is Open; Home's Needs you lists the same New + Open items, capped", async ({ page }) => {
  await login(page);
  await page.goto("/inbox");
  await expect(tab(page, "New")).toContainText("11");
  // The visit is recorded after the page has drawn (mark_seen); leaving before the mock has
  // saved it would make the next visit another first one.
  await expect
    .poll(() => page.evaluate(() => Object.keys(JSON.parse(localStorage.getItem("po-mock-db-v2") ?? "{}").inbox_seen ?? {}).length))
    .toBeGreaterThan(0);
  await page.goto("/home");
  const needs = page.getByTestId("home-needs");
  await expect(needs.getByTestId("panel-count")).toHaveText("11");
  // Six lines and '+5 more in Inbox': 11 items (the pending access request among them), each once.
  await expect(needs.getByTestId("home-needs-more")).toHaveText("+5 more in Inbox");
  await expect(page.getByTestId("home-needs-table").locator("tr[data-row]")).toHaveCount(7);
  await page.goto("/inbox");
  await expect(tab(page, "New")).not.toContainText("11");
  await tab(page, "Open").click();
  expect(await tabCount(page, "Open")).toBe(11);
  await expect(page.getByTestId("nav-inbox-badge")).toHaveText("11");
});
