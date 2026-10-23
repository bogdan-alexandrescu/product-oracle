import { expect, test, type Browser, type Page } from "@playwright/test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";

/**
 * A3 Engineering lead: an owner names who speaks for engineering in Settings › Members, and
 * the lead sees the engineering stops in their Inbox. On the mock layer, driven as a person
 * would. Each test states its card: protects / fails_when / no_claim.
 */

const memberRow = (page: Page, email: string) => page.getByTestId("member-row").filter({ hasText: email });
const leadBox = (page: Page, email: string) => page.getByRole("checkbox", { name: `Engineering lead: ${email}` });
const engReview = (page: Page) => page.getByTestId("inbox-checkpoints").locator("tr[data-row]").filter({ hasText: "Engineering review" });
const withScenario = (page: Page, scenario: string) => page.addInitScript(([key, s]) => localStorage.setItem(key, s), [MOCK_SCENARIO_KEY, scenario]);

async function inboxBadge(browser: Browser, scenario: string | null, email: string): Promise<number> {
  const context = await browser.newContext({ viewport: { width: 1366, height: 820 } });
  const page = await context.newPage();
  if (scenario) await withScenario(page, scenario);
  await login(page, email);
  await page.goto("/inbox");
  const badge = page.getByTestId("nav-inbox-badge");
  await expect(badge).toBeVisible();
  const n = Number(await badge.innerText());
  await context.close();
  return n;
}

test("engineering lead: the owner ticks Eng lead, it stays after a reload and the Roles inspector counts it", async ({ page }) => {
  // protects=AC16, an owner names a lead; fails_when=the tick is not saved or the count is
  // wrong; no_claim=the API's audit event (api/tests/test_engineering_lead.py).
  await login(page);
  await page.goto("/settings/members");
  await expect(page.locator("#engineering-lead")).toHaveText("Eng lead");
  const box = leadBox(page, "commenter@example.com");
  await expect(box).not.toBeChecked();
  await expect(page.getByTestId("roles-engineering-lead")).toContainText("Engineering lead");
  await expect(page.getByTestId("engineering-lead-count")).toHaveText("0");
  await box.check();
  await expect(box).toBeChecked();
  await expect(page.getByTestId("engineering-lead-count")).toHaveText("1");
  await page.reload();
  await expect(leadBox(page, "commenter@example.com")).toBeChecked();
  await expect(page.getByTestId("engineering-lead-count")).toHaveText("1");
  // The (i) says what the flag does.
  await page.getByRole("button", { name: "About the engineering lead" }).hover();
  await expect(page.getByRole("tooltip").filter({ hasText: "decides both engineering stops" })).toBeVisible();
});

test("engineering lead: a viewer's box is disabled and says why", async ({ page }) => {
  // protects=AC17, never a viewer; fails_when=the box is enabled for a viewer; no_claim=the
  // API's 422 (api tests).
  await login(page);
  await page.goto("/settings/members");
  const box = leadBox(page, "viewer@example.com");
  await expect(box).toBeDisabled();
  await expect(box).toHaveAttribute("title", "Viewers can't be the engineering lead");
});

test("engineering lead: making the lead a viewer unticks and disables their box", async ({ page }) => {
  // protects=AC18, a demotion to viewer clears the flag; fails_when=the box stays ticked or
  // enabled; no_claim=the audit events.
  await login(page);
  await page.goto("/settings/members");
  await leadBox(page, "commenter@example.com").check();
  await expect(leadBox(page, "commenter@example.com")).toBeChecked();
  await page.getByLabel("Role for commenter@example.com").selectOption("viewer");
  await expect(leadBox(page, "commenter@example.com")).not.toBeChecked();
  await expect(leadBox(page, "commenter@example.com")).toBeDisabled();
  await page.reload();
  await expect(leadBox(page, "commenter@example.com")).not.toBeChecked();
  await expect(page.getByTestId("engineering-lead-count")).toHaveText("0");
});

test("engineering lead: the invite form names a lead, never a viewer", async ({ page }) => {
  // protects=AC19, an owner names the lead before they first sign in; fails_when=the box is
  // offered with Viewer or the open invite does not show it; no_claim=the sign-in itself.
  await login(page);
  await page.goto("/settings/members");
  const form = page.getByRole("form", { name: "Invite" });
  const box = form.getByRole("checkbox", { name: "Engineering lead" });
  await form.getByLabel("Role", { exact: true }).selectOption("viewer");
  await expect(box).toBeDisabled();
  await form.getByLabel("Role", { exact: true }).selectOption("commenter");
  await expect(box).toBeEnabled();
  await form.getByLabel("Email").fill("lead.hire@example.com");
  await box.check();
  await form.getByRole("button", { name: "Send invite", exact: true }).click();
  const row = page.getByTestId("invite-row").filter({ hasText: "lead.hire@example.com" });
  await expect(row).toContainText("Commenter");
  await expect(row).toContainText("Eng lead");
  await page.reload();
  await expect(page.getByTestId("invite-row").filter({ hasText: "lead.hire@example.com" })).toContainText("Eng lead");
  // The seeded invite names no lead.
  await expect(page.getByTestId("invite-row").filter({ hasText: "new.hire@example.com" })).not.toContainText("Eng lead");
});

test("engineering lead: the lead sees the Engineering review stop; a non-lead approver does not", async ({ page, browser }) => {
  // protects=AC20, the lead sees the stop and can decide it, the approver neither sees nor
  // counts it once a lead is named; fails_when=an Inbox row or control is wrong for the role;
  // no_claim=the mock's may_decide stands in for the API's (api tests AC8-12 cover it).
  await withScenario(page, "eng-review");
  await login(page, "commenter@example.com");
  await page.goto("/inbox");
  await expect(engReview(page)).toHaveCount(1);
  await engReview(page).getByRole("link", { name: "Decide" }).click();
  await expect(page).toHaveURL(/\/runs\/[^/]+#decide$/);
  await expect(page.getByRole("button", { name: "Approve and continue" })).toBeEnabled();

  const approver = await browser.newContext({ viewport: { width: 1366, height: 820 } });
  const other = await approver.newPage();
  await withScenario(other, "eng-review");
  await login(other, "approver@example.com");
  await other.goto("/inbox");
  await expect(other.getByTestId("inbox-checkpoints")).toBeVisible();
  await expect(engReview(other)).toHaveCount(0);
  await approver.close();
  // The badge does not count it: the same as the default company's, without the stop.
  expect(await inboxBadge(browser, "eng-review", "approver@example.com")).toBe(await inboxBadge(browser, null, "approver@example.com"));
});

test("engineering lead: the lead's Members page says so", async ({ page }) => {
  // protects=AC21, a non-owner learns they are the lead; fails_when=the note is missing for
  // a lead or shown to others; no_claim=GET /v1/me's field (api tests).
  await withScenario(page, "eng-review");
  await login(page, "commenter@example.com");
  await page.goto("/settings/members");
  await expect(page.getByTestId("role-note")).toContainText("You are an engineering lead.");
  await expect(page.getByTestId("roles-engineering-lead")).toBeVisible();
});

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("engineering lead: at 390 px the table does not scroll sideways and the chip follows the email", async ({ page }) => {
    // protects=AC22, the phone layout; fails_when=the column forces a side scroll or the lead
    // is not marked; no_claim=other widths.
    await withScenario(page, "eng-review");
    await login(page);
    await page.goto("/settings/members");
    const row = memberRow(page, "commenter@example.com");
    await expect(row.getByText("Eng lead", { exact: true })).toBeVisible();
    await expect(memberRow(page, "approver@example.com").getByText("Eng lead", { exact: true })).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    // The box moved into the role cell, under the select.
    const box = leadBox(page, "approver@example.com");
    await expect(box).toBeVisible();
    await box.check();
    await expect(memberRow(page, "approver@example.com").getByText("Eng lead", { exact: true })).toBeVisible();
  });
});

test("engineering lead: the Set up step opens Members at the Eng lead column and is done once a lead is named", async ({ page }) => {
  // protects=3.6, A1's Engineering lead step; fails_when=Open misses the column or the step
  // stays open after naming a lead; no_claim=the API's step rule (api tests).
  await withScenario(page, "empty");
  await login(page);
  const step = page.getByTestId("setup-row-eng_lead");
  await expect(step).toHaveAttribute("data-done", "false");
  await expect(step.getByTestId("setup-status")).toHaveText("None");
  await step.getByRole("link", { name: "Open" }).click();
  await expect(page).toHaveURL(/\/settings\/members\?from=setup#engineering-lead$/);
  await leadBox(page, "approver@example.com").check();
  await expect(leadBox(page, "approver@example.com")).toBeChecked();
  await page.getByRole("navigation", { name: "Settings" }).getByRole("link", { name: "Back to Home" }).click();
  await expect(step).toHaveAttribute("data-done", "true");
  await expect(step.getByTestId("setup-status")).toHaveText("1 lead");
});
