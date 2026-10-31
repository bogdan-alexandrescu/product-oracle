import { expect, test, type Page } from "./test";

import { login } from "./helpers";

/*
 * QA pass 4, design group: a spec's design page /specs/<id>/design/<versionId>, the PRD
 * overview's tech briefs and a tech brief page, on the mock API's seeded spec (Checkout
 * redesign PRD -> "Early shipping cost: technical brief" -> its user flow and wireframes).
 * Driven through the UI as a person would.
 */

const SPEC_ID = "c3000000-0000-4000-8000-000000000001";
const FLOW = `/specs/${SPEC_ID}/design/c3000000-0000-4000-8000-000000000012`;
const WIRE = `/specs/${SPEC_ID}/design/c3000000-0000-4000-8000-000000000013`;
const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1440, height: 900 };

const visible = (page: Page, id: string) => page.getByTestId(id).filter({ visible: true });
const inspector = (page: Page) => page.getByRole("complementary", { name: "Design review" }).filter({ visible: true });

async function openDesign(page: Page, url: string, email?: string) {
  await login(page, email);
  await page.goto(url);
  await expect(visible(page, "design-canvas")).toBeVisible();
}

test.describe("desktop", () => {
  test.use({ viewport: DESKTOP });

  test("qa4-docs-share-8: the removed-parts note on wireframes is in plain words", async ({ page }) => {
    await openDesign(page, WIRE);
    await page.getByRole("button", { name: "Side by side" }).click();
    const note = visible(page, "sanitised");
    await expect(note).toContainText("A part that isn't allowed was removed from Cart 2 for safety.");
    await expect(note).not.toContainText("<");
    await expect(note).not.toContainText("Sanitised");
    await expect(note).not.toContainText("Oracle removed");
  });

  test("qa4-docs-share-40: comment boxes and Details name a wireframe by its title, not its file name", async ({ page }) => {
    await openDesign(page, WIRE);
    await page.getByRole("button", { name: "Side by side" }).click();
    const notes = inspector(page).getByTestId("annotations");
    await expect(notes.getByLabel("Comment on annotation 1 of Cart 1")).toBeVisible();
    await expect(notes.getByLabel("Comment on annotation 1 of Cart 2")).toBeVisible();
    const file = visible(page, "file-details").first();
    await file.getByText("Details").click();
    await expect(file).toContainText("Web page (HTML)");
    await expect(file).not.toContainText(".html");
    await expect(page.locator("main")).not.toContainText("cart-1.html");
  });

  test("qa4-docs-share-41: Reviews counts verdicts only, and the missing-note error clears once the person moves on", async ({ page }) => {
    await openDesign(page, FLOW, "approver@example.com");
    const panel = inspector(page);
    const stat = panel.getByTestId("reviews-stat");
    await expect(stat).toContainText("0");
    await panel.getByRole("button", { name: "Request changes" }).click();
    await expect(panel.getByRole("alert")).toHaveText("Add a note to request changes or reject.");
    const notes = panel.getByTestId("annotations");
    await notes.getByLabel("Comment on annotation 1").fill("Does the quote include tax?");
    await notes.getByTestId("annotation").first().getByRole("button", { name: "Comment" }).click();
    await expect(notes.getByTestId("annotation").first()).toContainText("Does the quote include tax?");
    // A comment is not a verdict: Reviews stays 0, as Version reviews says.
    await expect(stat).toContainText("0");
    await expect(stat).not.toContainText("1");
    await expect(panel.getByTestId("version-reviews")).toContainText("No reviews yet");
    await expect(panel.getByRole("alert")).toHaveCount(0);
  });

  test("qa4-docs-share-42: the status pills show once, in the page header only", async ({ page }) => {
    await openDesign(page, FLOW, "approver@example.com");
    await expect(visible(page, "page-header").getByText("User flow", { exact: true })).toBeVisible();
    const panel = inspector(page);
    await expect(panel.getByTestId("verdict")).toBeVisible();
    await expect(panel.getByText("User flow", { exact: true })).toHaveCount(0);
  });

  test("qa4-docs-share-43: Depends on lists what the flow depends on; staleness is its own line", async ({ page }) => {
    await openDesign(page, FLOW, "approver@example.com");
    const meta = inspector(page).getByTestId("version-meta");
    const depends = meta.locator("div").filter({ has: page.getByText("Depends on", { exact: true }) }).last();
    await expect(depends).toContainText("Checkout redesign PRD");
    await expect(depends).not.toContainText("changed");
    const stale = meta.locator("div").filter({ has: page.getByText("May be stale", { exact: true }) }).last();
    await expect(stale).toContainText('Section "5.2 Shipping step" changed in Checkout redesign PRD');
  });

  test("qa4-docs-share-44: the PRD overview calls a technical brief by that name", async ({ page }) => {
    await login(page);
    await page.goto("/documents/checkout-redesign");
    const row = page.getByTestId("tech-briefs").getByTestId("engineering-spec").first();
    await expect(row).toContainText("Early shipping cost: technical brief");
    await expect(row).toContainText("Open technical brief");
    await expect(row).not.toContainText("Open spec");
  });

  test("qa4-docs-share-46: What it touches reads as words, not kind and change values", async ({ page }) => {
    await login(page);
    await page.goto("/documents/checkout-redesign");
    await page.getByTestId("tech-briefs").getByRole("link", { name: "Show the full price early" }).click();
    await expect(page).toHaveURL(/\/briefs\/[0-9a-f-]+$/);
    const touches = page.getByRole("table", { name: "What it touches" });
    await expect(touches.getByRole("columnheader", { name: "What changes" })).toBeVisible();
    await expect(touches.getByRole("columnheader", { name: "Kind", exact: true })).toHaveCount(0);
    await expect(touches.getByRole("row", { name: /web\/checkout\/summary/ })).toContainText("Changes an existing module");
    await expect(touches.getByRole("row", { name: /GET \/v1\/quotes/ })).toContainText("Adds a new API");
    await expect(touches).not.toContainText("Change Change");
  });
});

test.describe("phone", () => {
  test.use({ viewport: PHONE });

  test("qa4-docs-share-56: a viewer opens the review, plainly read only, with no role name", async ({ page }) => {
    await page.setViewportSize(PHONE);
    await openDesign(page, FLOW, "viewer@example.com");
    await expect(page.getByRole("button", { name: "Review the design" })).toHaveCount(0);
    const open = page.getByRole("button", { name: "Open the review" });
    await expect(open).toHaveAttribute("data-variant", "secondary");
    await open.click();
    const sheet = page.getByRole("dialog", { name: /Review · Early shipping cost: user flows/ });
    await expect(sheet).toContainText("You can read this review.");
    await expect(sheet).not.toContainText("viewing as");
    await expect(sheet).not.toContainText("viewer");
    await expect(sheet).not.toContainText("commenter role");
  });

  test("qa4-docs-share-56: someone who can comment is still asked to review the design", async ({ page }) => {
    await page.setViewportSize(PHONE);
    await openDesign(page, FLOW, "commenter@example.com");
    await expect(page.getByRole("button", { name: "Review the design" })).toHaveAttribute("data-variant", "primary");
  });
});
