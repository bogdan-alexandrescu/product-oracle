import { expect, test, type Locator, type Page } from "@playwright/test";

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

/** Changes the mock's stored state, as another tab or person would between two requests. */
async function editMockDb(page: Page, edit: string) {
  await page.evaluate((body) => {
    const db = JSON.parse(localStorage.getItem("po-mock-db-v2")!);
    new Function("db", body)(db);
    localStorage.setItem("po-mock-db-v2", JSON.stringify(db));
  }, edit);
}

/** An accessible description from aria-describedby, not only a title (a tooltip). */
async function expectDescribedBy(target: Locator, text: string) {
  const ids = (await target.getAttribute("aria-describedby")) ?? "";
  expect(ids, "aria-describedby").not.toBe("");
  const described = await target.evaluate((el, list) => list.split(/\s+/).map((id) => el.ownerDocument.getElementById(id)?.textContent ?? "").join(" ").trim(), ids);
  expect(described).toBe(text);
}

async function setCompanySetting(page: Page, key: string, value: unknown) {
  await page.addInitScript(
    ([k, v]) => {
      const raw = localStorage.getItem("po-mock-connections-v1");
      const db = raw ? JSON.parse(raw) : { connections: [], settings: {} };
      db.settings[k as string] = v;
      localStorage.setItem("po-mock-connections-v1", JSON.stringify(db));
    },
    [key, value] as const,
  );
}

test("blocked: two blocks, failing hard checks, advisory and a disabled Publish", async ({ page }) => {
  await openPublish(page, "online-deposits");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(/^Publish\s*Online deposits at booking v3$/);
  await expect(page.getByTestId("blocks-chip")).toHaveText("2 blocks");

  const publish = page.getByTestId("publish-button");
  await expect(publish).toBeDisabled();
  await expect(publish).toHaveText("Publish v3");
  await expectDescribedBy(publish, "2 blocks");

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
  await risk.getByRole("button", { name: "Accept risk" }).click();
  await expect(risk.getByLabel("Review by")).toHaveAccessibleDescription("Within 90 days");
  await risk.getByRole("button", { name: "Cancel" }).click();
  await risk.getByRole("button", { name: "Accept risk" }).click();
  await risk.getByLabel("Reason").fill("Refund next working day; front desk tells the patient");
  await risk.getByRole("button", { name: "Accept risk" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Risk accepted." })).toBeVisible();
  await expect(page.getByTestId("block-row")).toHaveCount(1);
  await expect(page.getByTestId("blocks-chip")).toHaveText("1 block");
  await expect(page.getByTestId("publish-button")).toBeDisabled();
});

test("accept risk: the company's acceptance role and review limit, when the owner reads them", async ({ page }) => {
  await setCompanySetting(page, "blocker_risk_acceptance_role", "approver");
  await setCompanySetting(page, "blocker_risk_review_max_days", 14);
  await openPublish(page, "online-deposits");
  const risk = inspector(page).getByTestId("block-risk");
  await risk.getByRole("button", { name: "Accept risk" }).click();
  const review = risk.getByLabel("Review by");
  await expect(review).toHaveAccessibleDescription("Within 14 days");
  // The default review date is inside the limit: 14 days out at most.
  const days = await review.evaluate((el: HTMLInputElement) => (Date.parse(`${el.value}T09:00:00Z`) - Date.now()) / 86_400_000);
  expect(days).toBeLessThanOrEqual(14);
  expect(days).toBeGreaterThan(0);
  await expect(review).toHaveAttribute("max", /\d{4}-\d{2}-\d{2}/);
  await risk.getByLabel("Reason").fill("Refund next working day; front desk tells the patient");
  await risk.getByRole("button", { name: "Accept risk" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Risk accepted." })).toBeVisible();
});

test("accept risk: an approver cannot read the settings, so the owner default stands", async ({ page }) => {
  await setCompanySetting(page, "blocker_risk_acceptance_role", "approver");
  await asRole(page, "approver");
  await openPublish(page, "online-deposits");
  // #370: a control the role cannot use is hidden, with no role note.
  const risk = inspector(page).getByTestId("block-risk");
  await expect(risk).toBeVisible();
  await expect(risk.getByRole("button", { name: "Accept risk" })).toHaveCount(0);
  await expect(risk).not.toContainText("Only an owner");
});

for (const role of ["approver", "viewer"] as const) {
  test(`accept risk: ${role}s are not offered it (#370)`, async ({ page }) => {
    await asRole(page, role);
    await openPublish(page, "online-deposits");
    const risk = inspector(page).getByTestId("block-risk");
    await expect(risk).toBeVisible();
    await expect(risk.getByRole("button", { name: "Accept risk" })).toHaveCount(0);
    await expect(risk).not.toContainText("Only an owner");
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
  // #370: a commenter can never publish, so the button is not drawn.
  await expect(page.getByTestId("publish-button")).toHaveCount(0);
  await expect(page.getByTestId("publish-header")).not.toContainText("Approvers only");
});

test("409 in the dialog: a block that appears after the page loaded is named in the dialog", async ({ page }) => {
  await openPublish(page, "visit-reminders");
  await expect(page.getByTestId("publish-ready")).toHaveText("Ready to publish v1");
  await page.getByTestId("publish-button").click();
  const dialog = page.getByRole("dialog", { name: "Publish v1?" });
  await expect(dialog).toBeVisible();
  // Meanwhile someone links a critical blocker to this PRD.
  await editMockDb(page, `
    const doc = db.documents.find((d) => d.slug === "visit-reminders");
    db.blockers.blockers[0].document_ids.push(doc.id);
  `);
  await dialog.getByRole("button", { name: "Publish", exact: true }).click();

  const refusal = dialog.getByTestId("publish-refusal");
  await expect(refusal).toBeVisible();
  await expect(refusal).toHaveAttribute("role", "alert");
  await expect(refusal).toContainText("Not published");
  await expect(refusal).toContainText("1 block");
  await expect(dialog.getByTestId("refusal-block")).toHaveText(["The address lookup service allows 100 requests a minute per company"]);
  // Inside the dialog, above the overlay: nothing covers it.
  const box = (await refusal.boundingBox())!;
  const top = await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.closest('[data-testid="publish-refusal"]') != null, [box.x + 10, box.y + box.height / 2]);
  expect(top).toBe(true);
  const confirm = dialog.getByRole("button", { name: "Publish", exact: true });
  await expect(confirm).toBeDisabled();
  await expect(confirm).toHaveAccessibleDescription(/1 block/);
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();

  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId("blocks-chip")).toHaveText("1 block");
  await expect(page.getByTestId("publish-button")).toBeDisabled();
  await page.goto("/documents/visit-reminders/v/1");
  await expect(page.getByTestId("doc-status")).not.toHaveText("Approved");
});

test("stale version: Publish refuses when a newer version landed since the page loaded", async ({ page }) => {
  await openPublish(page, "visit-reminders");
  await page.getByTestId("publish-button").click();
  const dialog = page.getByRole("dialog", { name: "Publish v1?" });
  await editMockDb(page, `
    const doc = db.documents.find((d) => d.slug === "visit-reminders");
    const v1 = db.versions.find((v) => v.document_id === doc.id && v.number === 1);
    db.versions.push({ ...v1, id: crypto.randomUUID(), number: 2, approved_at: null });
  `);
  await dialog.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(dialog.getByTestId("publish-refusal")).toHaveText("v2 exists, reload");
  await dialog.getByRole("button", { name: "Reload" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId("publish-button")).toHaveText("Publish v2");
  // v1 was not published.
  await page.goto("/documents/visit-reminders/v/1");
  await expect(page.getByTestId("doc-status")).not.toHaveText("Approved");
});

test("confirm dialog: focus is trapped inside and restored on close", async ({ page }) => {
  await openPublish(page, "visit-reminders");
  const opener = page.getByTestId("publish-button");
  await opener.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Publish v1?" });
  const publish = dialog.getByRole("button", { name: "Publish", exact: true });
  const cancel = dialog.getByRole("button", { name: "Cancel" });
  await expect(publish).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(cancel).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(publish).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(cancel).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(publish).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(opener).toBeFocused();

  await opener.click();
  await cancel.click();
  await expect(opener).toBeFocused();
});

test("entry points: the PRD list and the PRD page open Publish", async ({ page }) => {
  await login(page);
  await page.goto("/documents");
  await page.getByTestId("document-row").filter({ hasText: "Online deposits at booking" }).click();
  await page.getByTestId("document-inspector").getByRole("link", { name: "Publish" }).click();
  await expect(page).toHaveURL(/\/documents\/online-deposits\/publish$/);

  await page.goto("/documents/online-deposits/v/3");
  const header = page.getByTestId("doc-header");
  await expect(header.getByRole("button", { name: "Approve version" })).toHaveCount(0);
  await header.getByRole("link", { name: "Publish", exact: true }).click();
  await expect(page).toHaveURL(/\/documents\/online-deposits\/publish$/);
  await expect(page.getByTestId("blocks-chip")).toHaveText("2 blocks");
});

test("PRD page: Publish replaces Approve version, for the latest version; roadmaps still approve", async ({ page }) => {
  await login(page);
  await page.goto("/documents/online-deposits/v/1");
  const header = page.getByTestId("doc-header");
  await expect(header.getByRole("button", { name: "Approve version" })).toHaveCount(0);
  const link = header.getByRole("link", { name: "Publish", exact: true });
  await expect(link).toHaveAttribute("href", "/documents/online-deposits/publish");
  await expect(link).toHaveAccessibleDescription("Publishes v3, the latest version");
  await link.click();
  await expect(page.getByTestId("publish-button")).toHaveText("Publish v3");

  await page.goto("/documents/usage-alerts-roadmap/v/1");
  await expect(page.getByTestId("doc-header").getByRole("button", { name: "Approve version" })).toBeVisible();
  await expect(page.getByTestId("doc-header").getByRole("link", { name: "Publish", exact: true })).toHaveCount(0);
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
