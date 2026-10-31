import { expect, test, type Page } from "./test";

import { login, signOut } from "./helpers";

/*
 * v2 screen 1 (picks.md 1): the Composition inspector of a PRD. A's module table and 380 px
 * inspector, B's draft diff and Brief/Full outline inside the Confirm step, C's policy board as
 * the Company policy tab (owners edit; everyone else reads it). Confirming sends the base
 * revision and a required reason (never last-write-wins). The mock seeds checkout-redesign with
 * a confirmed rev 1 (pack ai-agent.platform) and leaves team-workspaces without a composition.
 */

const EMAILS = { owner: "admin@example.com", approver: "approver@example.com", commenter: "commenter@example.com", viewer: "viewer@example.com" };
type Who = keyof typeof EMAILS;

async function openComposition(page: Page, who: Who, slug = "checkout-redesign") {
  await login(page, EMAILS[who]);
  await page.goto(`/documents/${slug}`);
  await page.getByRole("link", { name: "Composition" }).first().click();
  await expect(page).toHaveURL(new RegExp(`/documents/${slug}/composition`));
  await expect(page.getByRole("heading", { level: 1, name: "Composition" })).toBeVisible();
}

const modules = (page: Page) => page.getByTestId("composition-modules");
const row = (page: Page, key: string) => modules(page).locator(`[data-module="${key}"]`);
const inspector = (page: Page) => page.getByTestId("module-inspector");
const tab = (page: Page, name: string) => page.getByRole("group", { name: "Composition views" }).getByRole("link", { name });

test("an approver adds a module and confirms rev 2 with the diff, the Brief/Full outline and a reason", async ({ page }) => {
  // protects=the module table groups the composition in force, the inspector explains the
  // selected module, and the Confirm step previews the change (diff, outline) and sends
  // base_revision 1 with the reason; fails_when=the screen is missing or confirms without the
  // reason or base revision.
  await openComposition(page, "approver");
  await expect(page.getByTestId("composition-in-force")).toHaveText("Revision 1 in force");
  await expect(modules(page).getByText("Required", { exact: true }).first()).toBeVisible();
  await expect(row(page, "decision.executive")).toContainText("Executive decision");

  await row(page, "platform.tenant-isolation").click();
  await expect(inspector(page).getByRole("heading", { name: "Multi-tenant isolation" })).toBeVisible();
  await expect(inspector(page)).toContainText("Why it is here");
  await expect(inspector(page)).toContainText("Capabilities (scope) includes multi tenant");
  await inspector(page).getByRole("button", { name: "Add to draft" }).click();
  await expect(page.getByTestId("draft-changes")).toContainText("+ Multi-tenant isolation");

  await page.getByRole("button", { name: "Use these modules" }).first().click();
  const dialog = page.getByRole("dialog", { name: "Confirm revision 2" });
  await expect(dialog.getByTestId("confirm-diff")).toContainText("Multi-tenant isolation");
  await expect(dialog.getByTestId("confirm-diff")).toContainText("Changes sections");
  await expect(dialog.getByTestId("outline-full")).toContainText("Multi-tenant isolation");
  await dialog.getByRole("button", { name: "Brief", exact: true }).click();
  await expect(dialog.getByTestId("outline-full")).toBeHidden();
  const confirm = dialog.getByRole("button", { name: "Confirm revision 2", exact: true });
  await expect(confirm).toBeDisabled();
  await dialog.getByLabel("Reason (required)").fill("Workspaces share one database, so isolation needs its own section.");
  await confirm.click();
  await expect(page.getByTestId("composition-result")).toContainText("Revision 2 confirmed.");
  await expect(page.getByTestId("composition-in-force")).toHaveText("Revision 2 in force");
  await expect(row(page, "platform.tenant-isolation")).toContainText("Included");

  await tab(page, "History").click();
  await expect(page.getByTestId("revision-2")).toContainText("Workspaces share one database");
  await expect(page.getByTestId("revision-2")).toContainText("+ Multi-tenant isolation");
});

test("an approver saves a working draft, then confirms it from the draft", async ({ page }) => {
  // protects=status "working" supersedes nothing (rev 1 stays in force) and the next confirm is
  // based on the draft's number; fails_when=a working save puts the draft in force.
  await openComposition(page, "approver");
  await row(page, "economics.value").click();
  await inspector(page).getByRole("button", { name: "Add to draft" }).click();
  await page.getByRole("button", { name: "Use these modules" }).first().click();
  const dialog = page.getByRole("dialog", { name: "Confirm revision 2" });
  await dialog.getByRole("button", { name: "Working draft" }).click();
  await dialog.getByLabel("Reason (required)").fill("Usage billing may come in scope.");
  await dialog.getByRole("button", { name: "Save working draft" }).click();
  await expect(page.getByTestId("composition-in-force")).toHaveText("Revision 1 in force");
  await expect(page.getByTestId("composition-working")).toHaveText("Working draft, revision 2");
  await expect(page.getByTestId("working-draft")).toContainText("+ Value and cost economics");
  await page.getByRole("button", { name: "Use these modules" }).first().click();
  const next = page.getByRole("dialog", { name: "Confirm revision 3" });
  await next.getByLabel("Reason (required)").fill("Agreed with finance.");
  await next.getByRole("button", { name: "Confirm revision 3", exact: true }).click();
  await expect(page.getByTestId("composition-in-force")).toHaveText("Revision 3 in force");
});

test("a stale base revision is refused with the API's message and a Reload", async ({ page }) => {
  // protects=never last-write-wins: someone else's revision after the page loaded makes the
  // confirm a 409 that the screen shows, and Reload brings the new head; fails_when=the confirm
  // overwrites the newer revision.
  await openComposition(page, "approver");
  await row(page, "economics.value").click();
  await inspector(page).getByRole("button", { name: "Add to draft" }).click();
  // Another approver confirms in another tab meanwhile.
  const other = await page.context().newPage();
  await other.goto("/documents/checkout-redesign/composition");
  await other.getByTestId("composition-modules").locator('[data-module="platform.tenant-isolation"]').click();
  await other.getByTestId("module-inspector").getByRole("button", { name: "Add to draft" }).click();
  await other.getByRole("button", { name: "Use these modules" }).first().click();
  await other.getByLabel("Reason (required)").fill("Isolation first.");
  await other.getByRole("dialog", { name: "Confirm revision 2" }).getByRole("button", { name: "Confirm revision 2", exact: true }).click();
  await expect(other.getByTestId("composition-in-force")).toHaveText("Revision 2 in force");
  await other.close();

  await page.getByRole("button", { name: "Use these modules" }).first().click();
  const dialog = page.getByRole("dialog", { name: "Confirm revision 2" });
  await dialog.getByLabel("Reason (required)").fill("Usage billing.");
  await dialog.getByRole("button", { name: "Confirm revision 2", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("Someone else changed this since you loaded it; reload and try again");
  await dialog.getByRole("button", { name: "Reload" }).click();
  await expect(page.getByTestId("composition-in-force")).toHaveText("Revision 2 in force");
});

test("a mandatory module offers no Remove, and says why", async ({ page }) => {
  // protects=a mandatory module cannot be staged for removal (the API would refuse it);
  // fails_when=the inspector offers Remove from draft on it.
  await openComposition(page, "approver");
  await row(page, "risks.register").click();
  await expect(inspector(page).getByRole("button", { name: "Remove from draft" })).toHaveCount(0);
  await expect(inspector(page).getByTestId("module-mandatory")).toContainText("Required: it stays in the PRD.");
});

test("an approver moves a module up and confirms a reorder that is not material", async ({ page }) => {
  // protects=A's Move up sends changes.order (every included module); the Confirm step shows
  // a reorder-only change as not material, and the confirmed order holds; fails_when=the order
  // is not sent or the screen calls a reorder material.
  await openComposition(page, "approver");
  await expect(row(page, "risks.register").locator("td").first()).toHaveText("5");
  await row(page, "risks.register").click();
  await inspector(page).getByRole("button", { name: "Move up" }).click();
  await expect(page.getByTestId("draft-changes")).toContainText("↕ Custom order (7 modules)");
  await expect(row(page, "risks.register").locator("td").first()).toHaveText("4");
  await page.getByRole("button", { name: "Use these modules" }).first().click();
  const dialog = page.getByRole("dialog", { name: "Confirm revision 2" });
  await expect(dialog.getByTestId("confirm-diff")).toContainText("Order only · sections unchanged");
  await dialog.getByLabel("Reason (required)").fill("Risks read better before constraints.");
  await dialog.getByRole("button", { name: "Confirm revision 2", exact: true }).click();
  await expect(page.getByTestId("composition-in-force")).toHaveText("Revision 2 in force");
  await expect(row(page, "risks.register").locator("td").first()).toHaveText("4");
});

test("moving a module after Sources and data points shows the API's order_violation", async ({ page }) => {
  await openComposition(page, "approver");
  await row(page, "agents.tool-policies").click();
  await inspector(page).getByRole("button", { name: "Move down" }).click();
  await page.getByRole("button", { name: "Use these modules" }).first().click();
  const dialog = page.getByRole("dialog", { name: "Confirm revision 2" });
  await expect(dialog.getByTestId("preview-problems")).toContainText("Blocks confirming");
  await expect(dialog.getByTestId("preview-problems")).toContainText("Tool policies must come before Sources and data points.");
  await dialog.getByLabel("Reason (required)").fill("Try it.");
  await expect(dialog.getByRole("button", { name: "Confirm revision 2", exact: true })).toBeDisabled();
});

test("an owner-review module: an approver cannot add it, an owner can", async ({ page }) => {
  // protects=a module whose contract asks for the owner role is off for an approver with
  // "Your role cannot add or remove it: it needs the Owner role." and on for an owner; fails_when=the approver is offered it.
  await openComposition(page, "approver");
  await row(page, "agents.tool-policies").click();
  await expect(inspector(page)).toContainText("Owner review");
  await expect(inspector(page).getByRole("button", { name: "Remove from draft" })).toBeDisabled();
  await expect(inspector(page)).toContainText("Your role cannot add or remove it: it needs the Owner role.");

  await signOut(page);
  await openComposition(page, "owner");
  await row(page, "agents.tool-policies").click();
  await expect(inspector(page).getByRole("button", { name: "Remove from draft" })).toBeEnabled();
  await inspector(page).getByRole("button", { name: "Remove from draft" }).click();
  await expect(page.getByTestId("draft-changes")).toContainText("− Tool policies");
});

for (const who of ["viewer", "commenter"] as const) {
  test(`a ${who} reads the composition and previews a recommendation without changing anything`, async ({ page }) => {
    // protects=read + preview only: no Confirm, Publish or draft actions, the read-only notice;
    // fails_when=a ${who} is offered a write the API refuses.
    await openComposition(page, who);
    await expect(page.getByTestId("read-only")).toContainText("You can look at this composition and preview a recommendation. Only an approver can change or publish it.");
    await expect(page.getByRole("button", { name: /^Confirm rev/ })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^Publish rev/ })).toHaveCount(0);
    await row(page, "economics.value").click();
    await expect(inspector(page).getByRole("button", { name: "Add to draft" })).toHaveCount(0);
    await page.getByRole("button", { name: "Preview recommendation" }).click();
    await expect(page.getByTestId("composition-source")).toContainText("Recommendation");
    await expect(row(page, "decision.executive")).toBeVisible();
    await tab(page, "Company policy").click();
    await expect(page.getByTestId("policy-board")).toContainText("Owner edits policy");
    await expect(page.getByRole("button", { name: "Save policy" })).toHaveCount(0);
  });
}

test("a legacy PRD shows Oracle's recommendation and an approver confirms rev 1", async ({ page }) => {
  // protects=a PRD without a composition reads as legacy with the recommendation, and the first
  // confirm is based on no revision; fails_when=a legacy PRD shows an empty table.
  await openComposition(page, "approver", "team-workspaces");
  await expect(page.getByTestId("legacy-notice")).toContainText("This PRD has no composition yet. Oracle recommends");
  await expect(row(page, "decision.executive")).toBeVisible();
  await page.getByRole("button", { name: "Use these modules" }).click();
  const dialog = page.getByRole("dialog", { name: "Confirm revision 1" });
  await dialog.getByLabel("Reason (required)").fill("First confirmation of the recommendation");
  await dialog.getByRole("button", { name: "Confirm revision 1", exact: true }).click();
  await expect(page.getByTestId("composition-in-force")).toHaveText("Revision 1 in force");
});

test("the filter can match nothing, and Show all brings the modules back", async ({ page }) => {
  await openComposition(page, "viewer");
  await page.getByRole("group", { name: "Filter modules" }).getByRole("button", { name: /^Has problems/ }).click();
  await expect(page.getByText("No modules match “Has problems”.")).toBeVisible();
  await page.getByRole("button", { name: "Show all" }).click();
  await expect(row(page, "decision.executive")).toBeVisible();
});

test("a failed load shows the error and Retry reads it again", async ({ page }) => {
  await login(page, EMAILS.viewer);
  await page.evaluate(() => localStorage.setItem("po-mock-fail-once", "GET /v1/documents/checkout-redesign/composition"));
  await page.goto("/documents/checkout-redesign/composition");
  await expect(page.getByRole("alert").filter({ hasText: "Mock failure" })).toBeVisible();
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(row(page, "decision.executive")).toBeVisible();
});

test("publishing needs an approved version: the API's 409 is shown", async ({ page }) => {
  await openComposition(page, "approver");
  await page.getByRole("button", { name: "Pin revision 1 to an approved version" }).click();
  const dialog = page.getByRole("dialog", { name: "Pin revision 1 to an approved version" });
  await dialog.getByLabel("Approved document version").fill("9");
  await dialog.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("version 9 is not approved; approve it before publishing");
});

test("the Catalog tab shows a module's versions in words", async ({ page }) => {
  await openComposition(page, "viewer");
  await tab(page, "Catalog").click();
  await page.getByTestId("catalog-table").locator('[data-module="economics.value"]').click();
  const entry = page.getByTestId("catalog-inspector");
  await expect(entry.getByRole("heading", { name: "Value and cost economics" })).toBeVisible();
  await expect(entry).toContainText("Versions");
  await expect(entry).toContainText("Built-in");
  await expect(entry).toContainText("In effect");
});

test("an owner moves a module to Required on the Company policy tab and saves", async ({ page }) => {
  // protects=C's board as the owner-only tab: Move to, Save policy (PUT /module-policy), the
  // saved notice; fails_when=an owner cannot set the company module policy here.
  await openComposition(page, "owner");
  await tab(page, "Company policy").click();
  const board = page.getByTestId("policy-board");
  await expect(board.getByTestId("lane-pack")).toContainText("Value and cost economics");
  await board.locator('[data-module="economics.value"]').click();
  await page.getByTestId("policy-inspector").getByRole("group", { name: "Move to" }).getByRole("button", { name: "Required" }).click();
  await expect(board.getByTestId("lane-required")).toContainText("Value and cost economics");
  await page.getByRole("button", { name: "Save policy" }).click();
  await expect(page.getByTestId("policy-result")).toContainText("Policy saved.");
  await page.reload();
  await expect(page.getByTestId("policy-board").getByTestId("lane-required")).toContainText("Value and cost economics");
});

test("an approver reads the Company policy tab without controls", async ({ page }) => {
  await openComposition(page, "approver");
  await tab(page, "Company policy").click();
  await expect(page.getByTestId("policy-board")).toContainText("Owner edits policy");
  await page.getByTestId("policy-board").locator('[data-module="decision.executive"]').click();
  await expect(page.getByTestId("policy-inspector").getByRole("group", { name: "Move to" })).toHaveCount(0);
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("tapping a module opens its sheet and nothing scrolls sideways", async ({ page }) => {
    await openComposition(page, "approver");
    await row(page, "economics.value").click();
    const sheet = page.getByRole("dialog", { name: "Value and cost economics" });
    await expect(sheet).toBeVisible();
    await expect(sheet).toContainText("Why it is here");
    await sheet.getByRole("button", { name: "Close" }).click();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });

  test("the Confirm step opens as a sheet and confirms", async ({ page }) => {
    await openComposition(page, "approver");
    // qa4-docs-16: an unchanged composition is no new revision, so stage a change first.
    await row(page, "economics.value").click();
    const moduleSheet = page.getByRole("dialog", { name: "Value and cost economics" });
    await moduleSheet.getByRole("button", { name: "Add to draft" }).click();
    await moduleSheet.getByRole("button", { name: "Close" }).click();
    await page.getByRole("button", { name: "Use these modules" }).click();
    const sheet = page.getByRole("dialog", { name: "Confirm revision 2" });
    await expect(sheet.getByTestId("confirm-diff")).toContainText("Value and cost economics");
    await sheet.getByLabel("Reason (required)").fill("Value economics after the policy review.");
    await sheet.getByRole("button", { name: "Confirm revision 2", exact: true }).click();
    await expect(page.getByTestId("composition-in-force")).toHaveText("Revision 2 in force");
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });
});
