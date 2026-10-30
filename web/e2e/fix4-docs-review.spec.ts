import { expect, test, type Page } from "./test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";

/*
 * fix4-docs review minors, driven through the UI on the mock as a person would: the role
 * badge says what the role may do on the page (read off can()), New roadmap's Create draft
 * never does nothing, Evidence's Stale only never leaves an empty table that cannot be
 * cleared, and typed work on New PRD and New roadmap asks before browser Back or a button
 * (Sign out) drops it.
 */

const DESKTOP = { width: 1440, height: 900 };
const leave = (page: Page) => page.getByRole("dialog", { name: "Discard your changes?" });
const title = (page: Page) => page.getByRole("textbox", { name: "Title" });

test("role badge: a commenter on Quality reads that they can rate and save this check too; elsewhere, comment", async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await login(page, "commenter@example.com");
  await page.goto("/documents/saved-carts/v/2/quality");
  const badge = page.getByTestId("role-badge").filter({ visible: true });
  await expect(badge).toHaveText("Commenter: can comment, rate and save this check");
  // The page offers what the badge says.
  await expect(page.getByRole("button", { name: /Save this check/ }).filter({ visible: true }).first()).toBeVisible();

  await page.goto("/documents/saved-carts/v/2");
  await expect(page.getByTestId("role-badge").filter({ visible: true })).toHaveText("Commenter: can comment");
});

test("new roadmap: Create draft before Oracle has picked a template says so instead of doing nothing", async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await login(page);
  // A slow connection: the recommendation (asked 250 ms after the form last changed) never comes.
  await page.addInitScript(() => {
    const later = window.setTimeout;
    window.setTimeout = ((fn: TimerHandler, ms?: number, ...rest: unknown[]) =>
      ms === 250 ? 0 : later(fn, ms, ...rest)) as typeof window.setTimeout;
  });
  await page.goto("/documents/new?kind=roadmap");
  await title(page).fill("Next half's roadmap");
  await page.getByRole("button", { name: "Create draft" }).first().click();
  await expect(page.getByText("Oracle is still choosing a template for this draft.", { exact: false })).toBeVisible();
  await expect(page).toHaveURL(/\/documents\/new\?kind=roadmap$/);
});

test("evidence: Stale only lets go once no stale link is left, so the table is never stuck empty", async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await page.addInitScript(([key, s]) => localStorage.setItem(key, s), [MOCK_SCENARIO_KEY, "evidence"] as const);
  await login(page, "approver@example.com");
  await page.goto("/documents/checkout-redesign/v/2/evidence");
  const m = page.getByTestId("evidence-matrix");
  await expect(m).toBeVisible();
  const staleChip = page.getByRole("button", { name: /^Stale only/ });
  await staleChip.click();
  await expect(staleChip).toHaveAttribute("aria-pressed", "true");

  // Remove every stale link, one at a time, from its cell's inspector.
  for (let i = 0; i < 8 && (await m.locator('td[data-stale="true"]').count()) > 0; i++) {
    await m.locator('td[data-stale="true"]').first().getByRole("button").click();
    const stale = page.getByRole("complementary").getByTestId("evidence-link").filter({ hasText: "Stale link" }).first();
    await stale.getByRole("button", { name: "Remove" }).click();
    await expect(page.getByText("Link removed.")).toBeVisible();
    await expect(stale).toHaveCount(0);
  }

  await expect(staleChip).toBeDisabled();
  await expect(staleChip).toHaveAttribute("aria-pressed", "false");
  // The links left show again.
  await expect(m.locator("tr[data-target]").first()).toBeVisible();
});

test("new PRD: browser Back with typed words asks first; Keep editing keeps them, Discard goes back", async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await login(page);
  await page.goto("/documents");
  await page.getByRole("link", { name: "New PRD" }).filter({ visible: true }).first().click();
  await expect(page).toHaveURL(/\/documents\/new\?kind=prd$/);
  await title(page).fill("Saved addresses at checkout");

  await page.goBack();
  await expect(leave(page)).toBeVisible();
  await expect(page).toHaveURL(/\/documents\/new\?kind=prd$/);
  await leave(page).getByRole("button", { name: "Keep editing" }).click();
  await expect(title(page)).toHaveValue("Saved addresses at checkout");

  await page.goBack();
  await expect(leave(page)).toBeVisible();
  await leave(page).getByRole("button", { name: "Discard" }).click();
  await expect(page).toHaveURL(/\/documents$/);
});

test("new roadmap: Sign out with typed words asks first; Keep editing stays signed in with the words", async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await login(page);
  await page.goto("/documents/new?kind=roadmap");
  await title(page).fill("Next half's roadmap");

  await page.getByTestId("user-menu").filter({ visible: true }).first().click();
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(leave(page)).toBeVisible();
  await leave(page).getByRole("button", { name: "Keep editing" }).click();
  await expect(page).toHaveURL(/\/documents\/new\?kind=roadmap$/);
  await expect(title(page)).toHaveValue("Next half's roadmap");

  await page.getByTestId("user-menu").filter({ visible: true }).first().click();
  await page.getByRole("button", { name: "Sign out" }).click();
  await leave(page).getByRole("button", { name: "Discard" }).click();
  await expect(page).toHaveURL(/\/login/);
});
