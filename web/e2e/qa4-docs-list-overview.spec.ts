import { expect, test, type Page } from "./test";

import { MOCK_ROLE_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";

// QA pass 4, docs lane: the PRDs list (/documents) with its Regenerate and Delete dialogs and
// its Ideas tab, a PRD's overview (/documents/checkout-redesign) and New PRD, driven as a person.

const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };

type Role = "viewer" | "commenter" | "approver" | "owner";

async function setUp(page: Page, role: Role = "owner") {
  await page.addInitScript(([k, r]) => localStorage.setItem(k, r), [MOCK_ROLE_KEY, role] as const);
  await login(page);
}

async function openList(page: Page, role: Role = "owner") {
  await setUp(page, role);
  await page.goto("/documents");
  await expect(page.getByTestId("document-row").first()).toBeVisible();
}

async function openDoc(page: Page, doc: string) {
  await setUp(page);
  await page.goto(`/documents/${doc}`);
  await expect(page.getByTestId("versions-table")).toBeVisible();
}

const row = (page: Page, title: string) => page.getByTestId("document-row").filter({ hasText: title });

async function rowAction(page: Page, title: string, item: "Regenerate…" | "Delete…") {
  await row(page, title).getByRole("button", { name: `Actions for ${title}` }).click();
  await page.getByRole("menuitem", { name: item }).click();
}

async function openRegenerate(page: Page) {
  await openList(page);
  await rowAction(page, "Saved carts PRD", "Regenerate…");
  const dialog = page.getByRole("dialog", { name: "Regenerate Saved carts PRD" });
  await expect(dialog).toBeVisible();
  return dialog;
}

test.describe("desktop", () => {
  test.use({ viewport: DESKTOP });

  test("qa4-docs-8: the engineering spec the PRD has is listed under Engineering specs", async ({ page }) => {
    await openDoc(page, "checkout-redesign");
    const specs = page.getByTestId("engineering-specs");
    await expect(specs.getByTestId("engineering-spec")).toHaveCount(1);
    await expect(specs.getByTestId("engineering-spec")).toContainText("Early shipping cost: engineering spec");
    await expect(specs.getByTestId("engineering-specs-empty")).toHaveCount(0);
    await expect(specs).not.toContainText("No full engineering spec yet");
    // The technical brief stays under Tech briefs.
    await expect(page.getByTestId("tech-briefs")).toContainText("Early shipping cost: technical brief");
    await specs.getByRole("link", { name: "Open Early shipping cost: engineering spec" }).click();
    await expect(page).toHaveURL(/\/documents\/checkout-redesign-early-shipping-cost-engineering-spec\/v\/1$/);
  });

  test("qa4-docs-14: End campaign asks first, and Cancel keeps the campaign open", async ({ page }) => {
    await openDoc(page, "checkout-redesign");
    const campaign = page.getByTestId("campaigns").getByRole("listitem").filter({ hasText: "Company-wide feedback" });
    await expect(campaign).toContainText("Open");
    await campaign.getByRole("button", { name: "End campaign Company-wide feedback" }).click();
    const ask = page.getByTestId("end-campaign-dialog");
    await expect(ask.getByRole("heading", { name: "End Company-wide feedback?" })).toBeVisible();
    await expect(ask).toContainText("2 of 4 took part");
    await ask.getByRole("button", { name: "Cancel" }).click();
    await expect(ask.getByRole("heading")).toHaveCount(0);
    await expect(campaign).toContainText("Open");
    await expect(campaign).not.toContainText("Closed");

    await campaign.getByRole("button", { name: "End campaign Company-wide feedback" }).click();
    await ask.getByRole("button", { name: "End campaign" }).click();
    await expect(campaign).toContainText("Closed");
    await expect(campaign.getByRole("button", { name: "Reopen Company-wide feedback" })).toBeVisible();
  });

  test("qa4-docs-23: the estimate names the PRD and its version, never its slug, in the normal type", async ({ page }) => {
    const dialog = await openRegenerate(page);
    await dialog.getByRole("button", { name: "Estimate" }).click();
    const inputs = dialog.getByTestId("regenerate-inputs");
    await expect(inputs).toHaveText("Saved carts PRD, latest version (v2)");
    await expect(inputs).not.toContainText("saved-carts");
    const price = dialog.getByTestId("regenerate-estimate");
    await expect(price).toHaveText("$18.00");
    const font = (el: Element) => getComputedStyle(el).fontFamily;
    const body = await dialog.locator("p").first().evaluate(font);
    expect(await price.evaluate(font)).toBe(body);
  });

  test("qa4-docs-24: Start run says it waits for an estimate", async ({ page }) => {
    const dialog = await openRegenerate(page);
    const start = dialog.getByRole("button", { name: "Start run" });
    await expect(start).toBeDisabled();
    await expect(dialog.getByTestId("regenerate-hint")).toHaveText("Estimate the cost first");
    await dialog.getByRole("button", { name: "Estimate" }).click();
    await expect(dialog.getByTestId("regenerate-estimate")).toBeVisible();
    await expect(dialog.getByTestId("regenerate-hint")).toHaveCount(0);
    await expect(start).toBeEnabled();
  });

  test("qa4-docs-25: the Regenerate and Delete dialogs close with Cancel, not Back", async ({ page }) => {
    const regenerate = await openRegenerate(page);
    await expect(regenerate.getByRole("button", { name: "Back" })).toHaveCount(0);
    await regenerate.getByRole("button", { name: "Cancel" }).click();
    await expect(regenerate).toHaveCount(0);

    await rowAction(page, "Saved carts PRD", "Delete…");
    const remove = page.getByRole("dialog", { name: "Delete Saved carts PRD" });
    await expect(remove.getByRole("button", { name: "Back" })).toHaveCount(0);
    await remove.getByRole("button", { name: "Cancel" }).click();
    await expect(remove).toHaveCount(0);
    await expect(row(page, "Saved carts PRD")).toBeVisible();
  });

  test("qa4-docs-26: the Delete dialog names each run by its day and what it wrote", async ({ page }) => {
    await openList(page);
    await rowAction(page, "Checkout redesign PRD", "Delete…");
    const dialog = page.getByRole("dialog", { name: "Delete Checkout redesign PRD" });
    const goes = dialog.getByTestId("delete-dependents");
    await expect(goes).toBeVisible();
    const runs = goes.getByTestId("delete-run");
    await expect(runs.first()).toHaveText(/^The run of [A-Z][a-z]{2} \d{1,2} that wrote \S/);
    await expect(goes).not.toContainText("one of these");
    await expect(goes).not.toContainText("draft run that created");
  });

  test("qa4-docs-27: with no ideas, the Ideas tab shows only its empty state, no table header", async ({ page }) => {
    await openList(page);
    await page.getByRole("button", { name: /^Ideas/ }).click();
    const empty = page.getByTestId("ideas-empty");
    await expect(empty).toBeVisible();
    await expect(empty.getByRole("link", { name: "New PRD" })).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "Author" })).toHaveCount(0);
    await expect(page.getByRole("columnheader", { name: "Questions" })).toHaveCount(0);
    await expect(page.getByTestId("ideas-table")).toHaveCount(0);
  });

  test("qa4-docs-30: a tech brief's freshness and a spec's state say potentially stale the same way", async ({ page }) => {
    await openDoc(page, "checkout-redesign");
    const briefs = page.getByTestId("tech-briefs");
    const spec = briefs.getByTestId("engineering-spec").filter({ hasText: "Early shipping cost: technical brief" });
    await expect(spec).toContainText("Potentially stale");
    await expect(briefs.getByText("Stale", { exact: true })).toHaveCount(0);
  });

  test("qa4-docs-54: a problem too short asks for a bit more, not for a problem", async ({ page }) => {
    await setUp(page);
    await page.goto("/documents/new?kind=prd");
    await page.getByRole("textbox", { name: "Title" }).fill("Saved addresses at checkout");
    const problem = page.getByRole("textbox", { name: "What problem does it solve?" });
    await problem.fill("short");
    await page.getByRole("button", { name: "Continue" }).first().click();
    await expect(page.getByTestId("new-prd-missing")).toHaveText(
      "To continue, say a bit more about the problem (at least 20 characters).",
    );
    await expect(problem).toBeFocused();
  });
});

test.describe("phone", () => {
  test.use({ viewport: PHONE });

  test("qa4-docs-24, qa4-docs-25: the Regenerate dialog's hint and Cancel fit 390 px", async ({ page }) => {
    const dialog = await openRegenerate(page);
    const hint = dialog.getByTestId("regenerate-hint");
    await expect(hint).toHaveText("Estimate the cost first");
    for (const el of [hint, dialog.getByRole("button", { name: "Cancel" }), dialog.getByRole("button", { name: "Start run" })]) {
      const box = (await el.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(PHONE.width);
    }
  });

  test("qa4-docs-14: the End campaign confirm fits 390 px", async ({ page }) => {
    await openDoc(page, "checkout-redesign");
    const campaign = page.getByTestId("campaigns").getByRole("listitem").filter({ hasText: "Company-wide feedback" });
    await campaign.getByRole("button", { name: "End campaign Company-wide feedback" }).click();
    const ask = page.getByTestId("end-campaign-dialog");
    const yes = ask.getByRole("button", { name: "End campaign" });
    await expect(yes).toBeVisible();
    const box = (await ask.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(PHONE.width);
    await yes.click();
    await expect(campaign).toContainText("Closed");
  });
});
