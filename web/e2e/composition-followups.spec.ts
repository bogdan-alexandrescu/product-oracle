import { expect, test, type Page } from "./test";

import { login } from "./helpers";

/*
 * Follow-ups for #616 on the Composition screen: mockup A's "Company policy changed" notice
 * (the inspector's policy_changed_at) with Preview with new policy; each module's can_change
 * in place of the owner capability; and the review's minors (an addition under a custom order,
 * the Viewing as chip, pack titles on the legacy notice, focus kept inside the Confirm dialog).
 */

const EMAILS = { owner: "admin@example.com", approver: "approver@example.com", commenter: "commenter@example.com" };

async function openComposition(page: Page, who: keyof typeof EMAILS, slug = "checkout-redesign") {
  await login(page, EMAILS[who]);
  await page.goto(`/documents/${slug}`);
  await page.getByRole("link", { name: "Composition" }).first().click();
  await expect(page.getByRole("heading", { level: 1, name: "Composition" })).toBeVisible();
}

const modules = (page: Page) => page.getByTestId("composition-modules");
const row = (page: Page, key: string) => modules(page).locator(`[data-module="${key}"]`);
const inspector = (page: Page) => page.getByTestId("module-inspector");
const tab = (page: Page, name: string) => page.getByRole("group", { name: "Composition views" }).getByRole("link", { name });

test("after the company policy is saved the Modules tab says so, previews with it, and a confirm clears it", async ({ page }) => {
  // protects=A's "Company policy changed" notice from policy_changed_at, its Preview with new
  // policy, and that confirming a revision applies the policy; fails_when=the notice is missing
  // or stays after the policy is applied.
  await openComposition(page, "owner");
  await expect(page.getByTestId("policy-changed")).toHaveCount(0);
  await tab(page, "Company policy").click();
  await page.getByTestId("policy-board").locator('[data-module="economics.value"]').click();
  await page.getByTestId("policy-inspector").getByRole("group", { name: "Move to" }).getByRole("button", { name: "Required" }).click();
  await page.getByRole("button", { name: "Save policy" }).click();
  await expect(page.getByTestId("policy-result")).toContainText("Policy saved.");

  await tab(page, "Modules").click();
  const notice = page.getByTestId("policy-changed");
  await expect(notice).toContainText("Company policy changed");
  await expect(notice).toContainText("Compositions are only flagged; confirm a new revision to apply it.");
  await notice.getByRole("button", { name: "Preview with new policy" }).click();
  await expect(page.getByTestId("composition-source")).toContainText("Recommendation");

  await page.getByRole("button", { name: "Confirm rev 2…" }).first().click();
  const dialog = page.getByRole("dialog", { name: "Confirm rev 2" });
  await dialog.getByLabel("Reason (required)").fill("Apply the new company policy.");
  await dialog.getByRole("button", { name: "Confirm rev 2", exact: true }).click();
  await expect(page.getByTestId("composition-in-force")).toHaveText("Rev 2 in force");
  await expect(page.getByTestId("policy-changed")).toHaveCount(0);
});

test("a module the caller's role cannot change says so; one it can is offered", async ({ page }) => {
  // protects=the inspector follows the module's can_change (role against required_review_role);
  // fails_when=the screen works it out from the owner capability instead.
  await openComposition(page, "approver");
  await row(page, "agents.tool-policies").click();
  await expect(inspector(page).getByRole("button", { name: "Remove from draft" })).toBeDisabled();
  await expect(inspector(page)).toContainText("Your role cannot add or remove it: it needs the owner role.");
  await row(page, "economics.value").click();
  await expect(inspector(page).getByRole("button", { name: "Add to draft" })).toBeEnabled();
  await expect(inspector(page)).not.toContainText("Your role cannot add or remove it");
});

test("adding a module under a custom order keeps Sources and data points last", async ({ page }) => {
  // protects=an addition after Move up goes before Sources and data points, so the preview has no
  // order_violation and Confirm is enabled; fails_when=the addition is appended after Sources.
  await openComposition(page, "approver");
  await row(page, "risks.register").click();
  await inspector(page).getByRole("button", { name: "Move up" }).click();
  await row(page, "platform.tenant-isolation").click();
  await inspector(page).getByRole("button", { name: "Add to draft" }).click();
  await page.getByRole("button", { name: "Confirm rev 2…" }).first().click();
  const dialog = page.getByRole("dialog", { name: "Confirm rev 2" });
  await expect(dialog.getByTestId("confirm-diff")).toContainText("Multi-tenant isolation");
  await expect(dialog.getByTestId("preview-problems")).toHaveCount(0);
  await dialog.getByLabel("Reason (required)").fill("Isolation, with risks read earlier.");
  await dialog.getByRole("button", { name: "Confirm rev 2", exact: true }).click();
  await expect(page.getByTestId("composition-in-force")).toHaveText("Rev 2 in force");
  await expect(row(page, "platform.tenant-isolation")).toContainText("Included");
});

test("the header says which role the person views as", async ({ page }) => {
  await openComposition(page, "commenter");
  await expect(page.getByTestId("viewing-as")).toHaveText("Viewing as commenter");
});

test("the legacy notice names the packs by title", async ({ page }) => {
  await openComposition(page, "approver", "team-workspaces");
  await expect(page.getByTestId("legacy-notice")).toContainText("from General Tech Startup.");
});

test("Tab keeps the focus inside the desktop Confirm dialog", async ({ page }) => {
  // protects=the desktop dialog traps focus as the phone sheet does; fails_when=Tab walks out
  // to the page behind it.
  await openComposition(page, "approver");
  await page.getByRole("button", { name: "Confirm rev 2…" }).first().click();
  const dialog = page.getByRole("dialog", { name: "Confirm rev 2" });
  await expect(dialog).toBeVisible();
  for (let i = 0; i < 25; i++) {
    await page.keyboard.press("Tab");
    expect(await dialog.evaluate((d) => d.contains(document.activeElement))).toBe(true);
  }
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
});
