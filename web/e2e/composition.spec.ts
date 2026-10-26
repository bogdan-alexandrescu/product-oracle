import { expect, test, type Page } from "./test";

import { login } from "./helpers";

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
  await expect(page.getByTestId("composition-in-force")).toHaveText("Rev 1 in force");
  await expect(modules(page).getByText("Mandatory", { exact: true }).first()).toBeVisible();
  await expect(row(page, "decision.executive")).toContainText("Executive decision");

  await row(page, "platform.tenant-isolation").click();
  await expect(inspector(page).getByRole("heading", { name: "Multi-tenant isolation" })).toBeVisible();
  await expect(inspector(page)).toContainText("Why it is here");
  await expect(inspector(page)).toContainText("scope.capabilities");
  await inspector(page).getByRole("button", { name: "Add to draft" }).click();
  await expect(page.getByTestId("draft-changes")).toContainText("+ Multi-tenant isolation");

  await page.getByRole("button", { name: "Confirm rev 2…" }).first().click();
  const dialog = page.getByRole("dialog", { name: "Confirm rev 2" });
  await expect(dialog.getByTestId("confirm-diff")).toContainText("Multi-tenant isolation");
  await expect(dialog.getByTestId("confirm-diff")).toContainText("Material");
  await expect(dialog.getByTestId("outline-full")).toContainText("tenant-isolation");
  await dialog.getByRole("button", { name: "Brief", exact: true }).click();
  await expect(dialog.getByTestId("outline-full")).toBeHidden();
  const confirm = dialog.getByRole("button", { name: "Confirm rev 2", exact: true });
  await expect(confirm).toBeDisabled();
  await dialog.getByLabel("Reason (required)").fill("Workspaces share one database, so isolation needs its own section.");
  await confirm.click();
  await expect(page.getByTestId("composition-result")).toContainText("Rev 2 confirmed.");
  await expect(page.getByTestId("composition-in-force")).toHaveText("Rev 2 in force");
  await expect(row(page, "platform.tenant-isolation")).toContainText("Included");

  await tab(page, "History").click();
  await expect(page.getByTestId("revision-2")).toContainText("Workspaces share one database");
  await expect(page.getByTestId("revision-2")).toContainText("+ platform.tenant-isolation");
});

test("an approver saves a working draft, then confirms it from the draft", async ({ page }) => {
  // protects=status "working" supersedes nothing (rev 1 stays in force) and the next confirm is
  // based on the draft's number; fails_when=a working save puts the draft in force.
  await openComposition(page, "approver");
  await row(page, "economics.value").click();
  await inspector(page).getByRole("button", { name: "Add to draft" }).click();
  await page.getByRole("button", { name: "Confirm rev 2…" }).first().click();
  const dialog = page.getByRole("dialog", { name: "Confirm rev 2" });
  await dialog.getByRole("button", { name: "Working draft" }).click();
  await dialog.getByLabel("Reason (required)").fill("Usage billing may come in scope.");
  await dialog.getByRole("button", { name: "Save working draft" }).click();
  await expect(page.getByTestId("composition-in-force")).toHaveText("Rev 1 in force");
  await expect(page.getByTestId("composition-working")).toHaveText("Working draft rev 2");
  await expect(page.getByTestId("working-draft")).toContainText("+ economics.value");
  await page.getByRole("button", { name: "Confirm rev 3…" }).first().click();
  const next = page.getByRole("dialog", { name: "Confirm rev 3" });
  await next.getByLabel("Reason (required)").fill("Agreed with finance.");
  await next.getByRole("button", { name: "Confirm rev 3", exact: true }).click();
  await expect(page.getByTestId("composition-in-force")).toHaveText("Rev 3 in force");
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
  await other.getByRole("button", { name: "Confirm rev 2…" }).first().click();
  await other.getByLabel("Reason (required)").fill("Isolation first.");
  await other.getByRole("dialog", { name: "Confirm rev 2" }).getByRole("button", { name: "Confirm rev 2", exact: true }).click();
  await expect(other.getByTestId("composition-in-force")).toHaveText("Rev 2 in force");
  await other.close();

  await page.getByRole("button", { name: "Confirm rev 2…" }).first().click();
  const dialog = page.getByRole("dialog", { name: "Confirm rev 2" });
  await dialog.getByLabel("Reason (required)").fill("Usage billing.");
  await dialog.getByRole("button", { name: "Confirm rev 2", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("Someone else changed this since you loaded it; reload and try again");
  await dialog.getByRole("button", { name: "Reload" }).click();
  await expect(page.getByTestId("composition-in-force")).toHaveText("Rev 2 in force");
});

test("removing a mandatory module shows the API's required_module problem and blocks Confirm", async ({ page }) => {
  // protects=a fatal problem from the preview (valid false) is shown with its code and the
  // confirm button stays off; fails_when=the screen hides the problem or confirms anyway.
  await openComposition(page, "approver");
  await row(page, "risks.register").click();
  await inspector(page).getByRole("button", { name: "Remove from draft" }).click();
  await page.getByRole("button", { name: "Confirm rev 2…" }).first().click();
  const dialog = page.getByRole("dialog", { name: "Confirm rev 2" });
  await expect(dialog.getByTestId("preview-problems")).toContainText("required_module");
  await expect(dialog.getByTestId("preview-problems")).toContainText("Risks is mandatory");
  await dialog.getByLabel("Reason (required)").fill("Try it.");
  await expect(dialog.getByRole("button", { name: "Confirm rev 2", exact: true })).toBeDisabled();
});

test("an owner-review module: an approver cannot add it, an owner can", async ({ page }) => {
  // protects=a module whose contract asks for the owner role is off for an approver with
  // "Requires the owner role" and on for an owner; fails_when=the approver is offered it.
  await openComposition(page, "approver");
  await row(page, "agents.tool-policies").click();
  await expect(inspector(page)).toContainText("Owner review");
  await expect(inspector(page).getByRole("button", { name: "Remove from draft" })).toBeDisabled();
  await expect(inspector(page)).toContainText("Requires the owner role");

  await page.context().clearCookies();
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
    await expect(page.getByTestId("read-only")).toContainText("Read only. Preview writes nothing; confirming and publishing need an approver.");
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
  await page.getByRole("button", { name: "Review and confirm rev 1" }).click();
  const dialog = page.getByRole("dialog", { name: "Confirm rev 1" });
  await dialog.getByLabel("Reason (required)").fill("First confirmation of the recommendation");
  await dialog.getByRole("button", { name: "Confirm rev 1", exact: true }).click();
  await expect(page.getByTestId("composition-in-force")).toHaveText("Rev 1 in force");
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
  let fail = true;
  await page.route("**/v1/documents/checkout-redesign/composition", (route) =>
    fail ? route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ detail: "Composition store unavailable" }) }) : route.fallback(),
  );
  await page.goto("/documents/checkout-redesign/composition");
  await expect(page.getByRole("alert")).toBeVisible();
  fail = false;
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(row(page, "decision.executive")).toBeVisible();
});

test("publishing needs an approved version: the API's 409 is shown", async ({ page }) => {
  await openComposition(page, "approver");
  await page.getByRole("button", { name: "Publish rev 1…" }).click();
  const dialog = page.getByRole("dialog", { name: "Publish rev 1" });
  await dialog.getByLabel("Approved document version").fill("9");
  await dialog.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("version 9 is not approved; approve it before publishing");
});

test("the Catalog tab shows a module's versions and contract", async ({ page }) => {
  await openComposition(page, "viewer");
  await tab(page, "Catalog").click();
  await page.getByTestId("catalog-table").locator('[data-module="economics.value"]').click();
  const entry = page.getByTestId("catalog-inspector");
  await expect(entry.getByRole("heading", { name: "Value and cost economics" })).toBeVisible();
  await expect(entry).toContainText("Versions");
  await expect(entry).toContainText("1.0.0");
  await expect(entry.getByTestId("catalog-contract")).toContainText('"id": "economics.value"');
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
});
