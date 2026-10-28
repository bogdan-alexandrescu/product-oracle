import { expect, test, type Locator, type Page } from "./test";

import { login } from "./helpers";

/*
 * QA pass 1 (docs lane), the Composition screen of a PRD: confirming keeps the brief
 * (qa-docs-1), one full Confirm label (14), names in the Confirm dialog (15), plain words
 * instead of slugs, versions and order steps (27), no Remove on a mandatory module and full
 * labels in its panel (55), and the phone's tabs all in view (56).
 */

const APPROVER = "approver@example.com";
const VIEWER = "viewer@example.com";

async function open(page: Page, email: string, slug = "checkout-redesign") {
  await login(page, email);
  await page.goto(`/documents/${slug}/composition`);
  await expect(page.getByRole("heading", { level: 1, name: "Composition" })).toBeVisible();
  await expect(page.getByTestId("composition-modules")).toBeVisible();
}

const row = (page: Page, key: string) => page.getByTestId("composition-modules").locator(`[data-module="${key}"]`);
const inspector = (page: Page) => page.getByTestId("module-inspector");

/** Every listed brief heading in the Confirm dialog's outline. */
async function briefHeadings(dialog: Locator): Promise<string[]> {
  const column = dialog.getByTestId("outline-brief");
  await expect(column).toBeVisible();
  // The headings only: a "+" marks what is new against the revision in force.
  return column.locator("li > span.font-medium").allInnerTexts();
}

/** Nothing in the locator is cut: no element is wider inside than it shows. */
async function expectNothingCut(target: Locator) {
  const cut = await target.evaluate((root) =>
    [root, ...Array.from(root.querySelectorAll<HTMLElement>("*"))]
      .filter(
        (el) =>
          el.children.length === 0 &&
          (el.textContent ?? "").trim() &&
          getComputedStyle(el).display !== "inline" &&
          el.getClientRects().length > 0 &&
          el.scrollWidth > el.clientWidth + 1,
      )
      .map((el) => el.textContent),
  );
  expect(cut).toEqual([]);
}

test("qa-docs-1: confirming keeps the brief sections, revision after revision", async ({ page }) => {
  // fails_when=the outline after a confirm loses the brief ("This PRD has no brief layer.").
  await open(page, APPROVER, "team-workspaces");
  await page.getByRole("button", { name: "Confirm revision 1" }).click();
  let dialog = page.getByRole("dialog", { name: "Confirm revision 1" });
  const before = await briefHeadings(dialog);
  expect(before.length).toBeGreaterThan(0);
  await expect(dialog.getByTestId("outline-brief")).not.toContainText("This PRD has no brief layer.");
  await expect(dialog).toContainText(`The brief keeps its ${before.length} section`);
  await dialog.getByLabel("Reason (required)").fill("First composition.");
  await dialog.getByRole("button", { name: "Confirm revision 1", exact: true }).click();
  await expect(page.getByTestId("composition-in-force")).toHaveText("Revision 1 in force");

  await page.getByRole("button", { name: "Confirm revision 2" }).click();
  dialog = page.getByRole("dialog", { name: "Confirm revision 2" });
  expect(await briefHeadings(dialog)).toEqual(before);
  await dialog.getByLabel("Reason (required)").fill("Second look.");
  await dialog.getByRole("button", { name: "Confirm revision 2", exact: true }).click();
  await expect(page.getByTestId("composition-in-force")).toHaveText("Revision 2 in force");

  await page.getByRole("button", { name: "Confirm revision 3" }).click();
  expect(await briefHeadings(page.getByRole("dialog", { name: "Confirm revision 3" }))).toEqual(before);
});

test("qa-docs-14: the Confirm action reads in full, once", async ({ page }) => {
  await open(page, APPROVER, "team-workspaces");
  const action = page.getByRole("button", { name: "Confirm revision 1" });
  await expect(action).toHaveText("Confirm revision 1");
  await expectNothingCut(action);
  // The notice above does not repeat the action's label.
  await expect(page.getByTestId("legacy-notice")).not.toContainText(/confirm rev/i);
});

test("qa-docs-15: the Confirm dialog names modules and sections in words, each once", async ({ page }) => {
  await open(page, APPROVER);
  await row(page, "platform.tenant-isolation").click();
  await inspector(page).getByRole("button", { name: "Add to draft" }).click();
  await page.getByRole("button", { name: "Confirm revision 2" }).first().click();
  const dialog = page.getByRole("dialog", { name: "Confirm revision 2" });
  await expect(dialog.getByTestId("confirm-diff")).toContainText("+ Multi-tenant isolation");
  await expect(dialog.getByTestId("confirm-approvals")).toHaveText("Approvals on the sections of Multi-tenant isolation will be cleared when you confirm.");
  const full = dialog.getByTestId("outline-full");
  await expect(full).toContainText("Multi-tenant isolation");
  expect((await full.locator("li > span.font-medium").allInnerTexts()).filter((t) => t.includes("Sources and data points"))).toHaveLength(1);
  for (const slug of ["platform.tenant-isolation", "tenant-isolation", "decision.executive", "sources.data-points", "required_module"]) {
    await expect(dialog).not.toContainText(slug);
  }
});

test("qa-docs-27: the Modules and Catalog tabs speak in names and plain words", async ({ page }) => {
  await open(page, VIEWER);
  const body = page.locator("body");
  await expect(page.getByTestId("composition-pack")).toContainText("Multi-tenant AI Agent Platform");
  for (const raw of ["ai-agent.platform", "startup.standard", "1.0.0", "decision.executive", "Legacy"]) {
    await expect(body).not.toContainText(raw);
  }
  // Order is a place (1, 2, 3 …), not the API's steps of ten.
  await expect(row(page, "decision.executive").locator("td").first()).toHaveText("1");
  await row(page, "decision.executive").click();
  await expect(inspector(page)).toContainText("Mandatory in the Multi-tenant AI Agent Platform pack.");
  await row(page, "platform.tenant-isolation").click();
  await expect(inspector(page)).toContainText("Capabilities (scope) includes multi tenant");
  await expect(inspector(page)).not.toContainText("scope.capabilities contains");

  await page.getByRole("group", { name: "Composition views" }).getByRole("link", { name: "Catalog" }).click();
  const catalog = page.getByTestId("catalog-table");
  await expect(catalog.locator('[data-module="economics.value"]')).toContainText("When it applies");
  await expect(catalog.locator('[data-module="risks.register"]')).toContainText("Required");
  await expect(catalog).not.toContainText("conditional");
  await expect(catalog).not.toContainText("No policy");
});

test("qa-docs-55: a mandatory module offers no Remove, and its panel's labels are whole", async ({ page }) => {
  await open(page, APPROVER);
  await row(page, "decision.executive").click();
  await expect(inspector(page).getByRole("heading", { name: "Executive decision" })).toBeVisible();
  await expect(inspector(page).getByRole("button", { name: "Remove from draft" })).toHaveCount(0);
  await expect(inspector(page).getByTestId("module-mandatory")).toBeVisible();
  await expectNothingCut(inspector(page));
  // The module names in the table beside the panel are whole too.
  await expectNothingCut(row(page, "goals.outcomes"));
  await row(page, "goals.outcomes").click();
  await expectNothingCut(inspector(page));
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("qa-docs-56: every tab is in view and History opens", async ({ page }) => {
    await open(page, VIEWER);
    const tabs = page.getByRole("group", { name: "Composition views" });
    for (const name of ["Modules", "Catalog", "Policy", "History"]) {
      const box = await tabs.getByRole("link", { name, exact: true }).boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(390);
    }
    await tabs.getByRole("link", { name: "History", exact: true }).click();
    await expect(page.getByTestId("revision-1")).toBeVisible();
  });

  test("qa-docs-14: the Confirm action reads in full on a phone", async ({ page }) => {
    await open(page, APPROVER);
    const action = page.getByRole("button", { name: "Confirm revision 2" });
    await expect(action).toHaveText("Confirm revision 2");
    const box = await action.boundingBox();
    expect(box!.x + box!.width).toBeLessThanOrEqual(390);
    await expectNothingCut(action);
  });

  test("qa-docs-55: a mandatory module's sheet offers no Remove", async ({ page }) => {
    await open(page, APPROVER);
    await row(page, "decision.executive").click();
    const sheet = page.getByRole("dialog", { name: "Executive decision" });
    await expect(sheet.getByTestId("module-mandatory")).toBeVisible();
    await expect(sheet.getByRole("button", { name: "Remove from draft" })).toHaveCount(0);
  });
});
