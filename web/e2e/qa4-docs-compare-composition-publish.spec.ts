import { expect, test, type Page } from "./test";

import { MOCK_ROLE_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";

// QA pass 4, docs lane: Compare (/documents/checkout-redesign/diff), Composition
// (/documents/checkout-redesign/composition), Publish (/documents/<doc>/publish) and the tech
// brief page (/briefs/<id>), driven as a person on the mock app.

const DESKTOP = { width: 1440, height: 900 };

async function asRole(page: Page, role: "viewer" | "commenter" | "approver") {
  await page.addInitScript(([k, r]) => localStorage.setItem(k, r), [MOCK_ROLE_KEY, role] as const);
}

async function openCompare(page: Page) {
  await login(page);
  await page.goto("/documents/checkout-redesign/diff");
  await expect(page.getByRole("heading", { level: 1, name: "Changes from v1 to v2" })).toBeVisible();
  await expect(page.getByTestId("diff-section").first()).toBeVisible();
}

async function openComposition(page: Page) {
  await login(page, "approver@example.com");
  await page.goto("/documents/checkout-redesign");
  await page.getByRole("link", { name: "Composition" }).first().click();
  await expect(page.getByRole("heading", { level: 1, name: "Composition" })).toBeVisible();
  await expect(page.getByTestId("composition-modules")).toBeVisible();
}

test.describe("desktop", () => {
  test.use({ viewport: DESKTOP });

  test("qa4-docs-10: picking the To version as From swaps the two, so Compare never shows one version against itself", async ({ page }) => {
    await openCompare(page);
    await page.getByRole("combobox", { name: "From" }).selectOption("2");
    await expect(page).toHaveURL(/from=2&to=1/);
    await expect(page.getByRole("heading", { level: 1, name: "Changes from v2 to v1" })).toBeVisible();
    await expect(page.getByRole("combobox", { name: "From" })).toHaveValue("2");
    await expect(page.getByRole("combobox", { name: "To" })).toHaveValue("1");
    await expect(page.getByText("Pick two versions")).toHaveCount(0);

    await page.getByRole("combobox", { name: "To" }).selectOption("2");
    await expect(page).toHaveURL(/from=1&to=2/);
    await expect(page.getByRole("heading", { level: 1, name: "Changes from v1 to v2" })).toBeVisible();
  });

  test("qa4-docs-10: a link to one version on both sides asks for two, and shows no diff beside it", async ({ page }) => {
    await login(page);
    await page.goto("/documents/checkout-redesign/diff?from=2&to=2");
    await expect(page.getByText("Pick two versions")).toBeVisible();
    await expect(page.getByRole("heading", { level: 1, name: "Compare versions" })).toBeVisible();
    await expect(page.getByRole("heading", { level: 1, name: /Changes from/ })).toHaveCount(0);
    await expect(page.getByTestId("diff-summary")).toHaveCount(0);
    await expect(page.getByText("No differences")).toHaveCount(0);
  });

  test("qa4-docs-49: the toggle reads Show unchanged, and a removed last section stays last", async ({ page }) => {
    await openCompare(page);
    const toggle = page.locator("label").filter({ has: page.getByRole("checkbox", { name: "Show unchanged sections" }) });
    await expect(toggle).toHaveText("Show unchanged");
    const sections = page.getByTestId("diff-section");
    await expect(sections.last()).toHaveAttribute("data-status", "removed");
    await expect(sections.last()).toContainText("8. Rollout");
    await page.getByRole("checkbox", { name: "Show unchanged sections" }).check();
    await expect(sections.last()).toHaveAttribute("data-status", "removed");
    await expect(sections.last()).toContainText("8. Rollout");
  });

  test("qa4-docs-16: the in-force revision offers a pin, not a publish, and an unchanged revision can't be confirmed", async ({ page }) => {
    await openComposition(page);
    await expect(page.getByTestId("composition-in-force")).toHaveText("Revision 1 in force");
    await expect(page.getByRole("button", { name: "Publish revision 1" })).toHaveCount(0);
    await page.getByRole("button", { name: "Pin revision 1 to an approved version" }).click();
    const pin = page.getByRole("dialog", { name: "Pin revision 1 to an approved version" });
    await expect(pin).toBeVisible();
    await pin.getByRole("button", { name: "Cancel" }).click();

    await page.getByRole("button", { name: "Use these modules" }).first().click();
    const dialog = page.getByRole("dialog", { name: "Confirm revision 2" });
    await expect(dialog.getByTestId("confirm-diff")).toContainText("No change");
    await dialog.getByLabel("Reason (required)").fill("Look again.");
    await expect(dialog.getByRole("button", { name: "Nothing changed" })).toBeDisabled();
    await expect(dialog.getByRole("button", { name: "Confirm revision 2", exact: true })).toHaveCount(0);
    await expect(dialog.getByTestId("confirm-nothing-changed")).toContainText("Nothing changed: these are the modules of revision 1.");
  });

  test("qa4-docs-50: module numbers run in reading order and no Selection column repeats the group", async ({ page }) => {
    await openComposition(page);
    const table = page.getByTestId("composition-modules");
    const numbers = (await table.locator("[data-module] td:first-child").allInnerTexts()).map((t) => t.trim()).filter((t) => /^\d+$/.test(t));
    expect(numbers.length).toBeGreaterThan(5);
    expect(numbers).toEqual(numbers.map((_, i) => String(i + 1)));
    await expect(table.getByRole("columnheader", { name: "Selection" })).toHaveCount(0);
    // A module that is only there when it applies still says so.
    await expect(table.locator('[data-module="economics.value"]')).toContainText("When it applies");
  });

  test("qa4-docs-40: a viewer sees no empty Risk section on a blocker", async ({ page }) => {
    await asRole(page, "viewer");
    await login(page);
    await page.goto("/documents/online-deposits/publish");
    const inspector = page.getByTestId("publish-inspector");
    await expect(inspector.getByRole("link", { name: "Open blocker" })).toBeVisible();
    await expect(inspector.getByTestId("block-risk")).toHaveCount(0);
    await expect(inspector.getByRole("button", { name: "Accept risk" })).toHaveCount(0);
  });

  test("qa4-docs-41: every advisory status chip looks the same, Pass included", async ({ page }) => {
    await login(page);
    await page.goto("/documents/online-deposits/publish");
    const rows = page.getByTestId("advisory");
    await expect(rows.first()).toBeVisible();
    await expect(rows.filter({ hasText: "Pass" }).first()).toBeVisible();
    await expect(rows.filter({ hasText: "Warning" }).first()).toBeVisible();
    await expect(rows.locator("svg")).toHaveCount(0);
  });

  test("qa4-docs-53: an answered question no longer reads Blocking; an open one says Not answered yet", async ({ page }) => {
    await login(page, "viewer@example.com");
    await page.goto("/documents/checkout-redesign");
    await page.getByTestId("tech-briefs").getByRole("link", { name: "Show the full price early" }).click();
    await expect(page).toHaveURL(/\/briefs\/[0-9a-f-]+$/);
    const answered = page.getByTestId("brief-question-q1");
    await expect(answered).toContainText("Yes, prices change at most hourly");
    await expect(answered).toContainText("Was blocking · answered");
    await expect(answered.getByText("Blocking", { exact: true })).toHaveCount(0);
    const open = page.getByTestId("brief-question-q2");
    await expect(open).toContainText("Not answered yet");
    await expect(open).not.toContainText("Engineering check");
  });
});
