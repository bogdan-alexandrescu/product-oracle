import { expect, test, type Page } from "@playwright/test";

import { MOCK_ROLE_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";

// Publish (I3, B1): the Quillfield deposits PRD is held by a critical blocker and an
// unsupported third-party operation; visit-reminders passes every check.

async function asRole(page: Page, role: "viewer" | "commenter" | "approver") {
  await page.addInitScript(([key, r]) => localStorage.setItem(key, r), [MOCK_ROLE_KEY, role] as const);
}

async function openPublish(page: Page, slug: string) {
  await login(page);
  await page.goto(`/documents/${slug}/publish`);
  await expect(page.getByTestId("hard-check").first()).toBeVisible();
}

const inspector = (page: Page) => page.getByTestId("publish-inspector");

test("blocked: two blocks, failing hard checks, advisory and a disabled Publish", async ({ page }) => {
  await openPublish(page, "online-deposits");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(/^Publish\s*Online deposits at booking v3$/);
  await expect(page.getByTestId("blocks-chip")).toHaveText("2 blocks");

  const publish = page.getByTestId("publish-button");
  await expect(publish).toBeDisabled();
  await expect(publish).toHaveText("Publish v3");
  await expect(publish).toHaveAccessibleDescription("2 blocks");

  const blocks = page.getByTestId("block-row");
  await expect(blocks).toHaveCount(2);
  await expect(blocks.nth(0)).toContainText("Same-day refund rule unanswered");
  await expect(blocks.nth(0)).toContainText("Critical blocker");
  await expect(blocks.nth(1)).toContainText("Supported third-party operations");
  await expect(blocks.nth(1)).toContainText("Third-party");
  await expect(blocks.nth(0).getByRole("link", { name: "Resolve" })).toHaveAttribute("href", /\/baseline\?entity=/);
  await expect(blocks.nth(1).getByRole("link", { name: "Resolve" })).toHaveAttribute(
    "href",
    "/documents/online-deposits/v/3#solution",
  );

  const hard = page.getByTestId("hard-check");
  await expect(hard).toHaveCount(3);
  await expect(hard.filter({ hasText: "Fail" })).toHaveCount(2);
  await expect(page.locator('[data-testid="hard-check"][data-key="critical_blockers"]')).toContainText("1 open");
  await expect(page.getByRole("region", { name: "Hard checks" })).toContainText("2 fail");

  const advisory = page.getByRole("region", { name: "Advisory" });
  await expect(page.getByTestId("advisory")).toHaveCount(10);
  await expect(advisory).toContainText("7 pass");
  await expect(advisory).toContainText("2 warning");
  await expect(advisory).toContainText("1 critical");
  // Two columns on desktop.
  const first = await page.getByTestId("advisory").nth(0).boundingBox();
  const sixth = await page.getByTestId("advisory").nth(5).boundingBox();
  expect(sixth!.x).toBeGreaterThan(first!.x + 100);
  expect(Math.abs(sixth!.y - first!.y)).toBeLessThan(2);
});

test("inspector: the selected block, its question, and what publishing does", async ({ page }) => {
  await openPublish(page, "online-deposits");
  const blocks = page.getByTestId("block-row");
  await expect(blocks.nth(0)).toHaveAttribute("aria-current", "true");
  await expect(inspector(page)).toContainText("Same-day refund rule unanswered");
  await expect(inspector(page).getByTestId("block-question")).toContainText("Same-day cancellation refund?");
  await expect(inspector(page).getByTestId("on-publish").getByRole("listitem")).toHaveText([
    "Version v3 approved with its evidence",
    "PRD status set to Approved",
    "Approval recorded in the audit log",
  ]);
  // No answer or Ask Oracle: the API has no write for them yet.
  await expect(inspector(page).getByRole("button", { name: "Answer" })).toHaveCount(0);

  await blocks.nth(1).click();
  await expect(blocks.nth(1)).toHaveAttribute("aria-current", "true");
  await expect(blocks.nth(0)).not.toHaveAttribute("aria-current", "true");
  await expect(inspector(page).getByRole("heading")).toHaveText("Supported third-party operations");
  await expect(inspector(page).getByTestId("block-risk")).toHaveCount(0);
});

test("accept risk: owners accept it, and the block goes", async ({ page }) => {
  await openPublish(page, "online-deposits");
  const risk = inspector(page).getByTestId("block-risk");
  await expect(risk).toContainText("Owners only");
  await risk.getByRole("button", { name: "Accept risk" }).click();
  await risk.getByLabel("Reason").fill("Refund next working day; front desk tells the patient");
  await risk.getByRole("button", { name: "Accept risk" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Risk accepted." })).toBeVisible();
  await expect(page.getByTestId("block-row")).toHaveCount(1);
  await expect(page.getByTestId("blocks-chip")).toHaveText("1 block");
  await expect(page.getByTestId("publish-button")).toBeDisabled();
});

for (const role of ["approver", "viewer"] as const) {
  test(`accept risk: ${role}s see that only an owner can`, async ({ page }) => {
    await asRole(page, role);
    await openPublish(page, "online-deposits");
    const risk = inspector(page).getByTestId("block-risk");
    await expect(risk).toContainText("Only an owner can accept this risk");
    await expect(risk.getByRole("button", { name: "Accept risk" })).toHaveCount(0);
  });
}

test("ready: one line, the button enabled, a confirm step, then published", async ({ page }) => {
  await openPublish(page, "visit-reminders");
  await expect(page.getByTestId("publish-ready")).toHaveText("Ready to publish v1");
  await expect(page.getByTestId("block-row")).toHaveCount(0);
  await expect(page.getByTestId("blocks-chip")).toHaveText("0 blocks");
  await expect(page.getByTestId("hard-check").filter({ hasText: "Fail" })).toHaveCount(0);

  const publish = page.getByTestId("publish-button");
  await expect(publish).toBeEnabled();
  await publish.click();
  const dialog = page.getByRole("dialog", { name: "Publish v1?" });
  await expect(dialog.getByRole("listitem")).toHaveCount(3);
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);

  await publish.click();
  await dialog.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(page.getByTestId("published-chip")).toHaveText("Published v1");
  await expect(page.getByTestId("publish-ready")).toHaveText("Published v1");

  await page.goto("/documents/visit-reminders/v/1");
  await expect(page.getByTestId("doc-status")).toHaveText("Approved");
});

test("ready: commenters check readiness but cannot publish", async ({ page }) => {
  await asRole(page, "commenter");
  await openPublish(page, "visit-reminders");
  await expect(page.getByTestId("publish-button")).toBeDisabled();
  await expect(page.getByTestId("publish-header")).toContainText("Approvers only");
});

test("entry points: the PRD list and the PRD page open Publish", async ({ page }) => {
  await login(page);
  await page.getByTestId("document-row").filter({ hasText: "Online deposits at booking" }).click();
  await page.getByTestId("document-inspector").getByRole("link", { name: "Publish" }).click();
  await expect(page).toHaveURL(/\/documents\/online-deposits\/publish$/);

  await page.goto("/documents/online-deposits/v/3");
  await page.getByRole("link", { name: "Check readiness" }).click();
  await expect(page).toHaveURL(/\/documents\/online-deposits\/publish$/);
  await expect(page.getByTestId("blocks-chip")).toHaveText("2 blocks");
});

test("resolve a blocker: opens its baseline item", async ({ page }) => {
  await openPublish(page, "online-deposits");
  await page.getByTestId("block-row").nth(0).getByRole("link", { name: "Resolve" }).click();
  await expect(page).toHaveURL(/\/baseline\?entity=/);
  await expect(page.getByRole("complementary").filter({ hasText: "c.same-day-refund" })).toBeVisible();
});

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("stacked blocks, the inspector under the selected one, no side scroll", async ({ page }) => {
    await openPublish(page, "online-deposits");
    await expect(page.getByTestId("phone-title")).toContainText("Publish");
    const blocks = page.getByTestId("block-row");
    await expect(blocks).toHaveCount(2);
    const insp = inspector(page);
    await expect(insp).toHaveCount(1);
    const [b0, i0, b1] = await Promise.all([blocks.nth(0).boundingBox(), insp.boundingBox(), blocks.nth(1).boundingBox()]);
    expect(i0!.y).toBeGreaterThan(b0!.y);
    expect(i0!.y).toBeLessThan(b1!.y);

    await blocks.nth(1).click();
    await expect(insp).toContainText("Supported third-party operations");
    const [c1, j1] = await Promise.all([blocks.nth(1).boundingBox(), insp.boundingBox()]);
    expect(j1!.y).toBeGreaterThan(c1!.y);
    await expect(page.getByTestId("publish-button")).toBeDisabled();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });

  test("ready state on a phone", async ({ page }) => {
    await openPublish(page, "visit-reminders");
    await expect(page.getByTestId("publish-ready")).toHaveText("Ready to publish v1");
    await expect(page.getByTestId("publish-button")).toBeEnabled();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
});
