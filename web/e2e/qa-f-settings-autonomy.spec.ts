import { expect, test, type Page } from "./test";

import { login } from "./helpers";

/*
 * QA F-71 on Settings › Autonomy, driven through the UI on the mock layer as an owner would:
 * a row's explanation sentence and (if a step is locked) why sit behind the row's own (i), not
 * loose on the page; the top level reads "Act" everywhere it is named, never "Act within
 * limits"; a locked step's button is left out of the row, not shown disabled.
 */

async function openAutonomy(page: Page) {
  await login(page);
  await page.goto("/settings/autonomy");
  await expect(page.getByRole("heading", { level: 1, name: "Autonomy" })).toBeVisible();
}

const row = (page: Page, key: string) => page.getByTestId(`autonomy-row-${key}`);
const step = (page: Page, key: string, label: string) =>
  row(page, key).getByRole("group").getByRole("button", { name: label, exact: true });

// fails_when=the sentence shows loose on the page instead of behind the row's own (i).
test("autonomy: a row's sentence is named by the row and hidden until its (i) opens", async ({ page }) => {
  await openAutonomy(page);
  const priorities = row(page, "priorities");
  const about = priorities.getByRole("button", { name: "About Order priorities" });
  const tip = priorities.locator('[role="tooltip"]');
  await expect(about).toBeVisible();
  // Not shown loose on the page before the (i) opens.
  await expect(tip).toBeHidden();
  await expect(priorities.getByTestId("autonomy-sentence")).toBeHidden();
  await about.click();
  await expect(tip).toBeVisible();
  await expect(priorities.getByTestId("autonomy-sentence")).toHaveText("Oracle proposes an order; a person saves it.");
});

// fails_when=a locked step's button still shows (disabled or not), or its reason is not said anywhere.
test("autonomy: a locked step's button is left out; why is said behind the row's (i)", async ({ page }) => {
  await openAutonomy(page);
  const vision = row(page, "vision");
  // "Draft the vision" is locked at Draft: Recommend and Act are left out entirely.
  await expect(step(page, "vision", "Recommend")).toHaveCount(0);
  await expect(step(page, "vision", "Act")).toHaveCount(0);
  // No empty box where they were: the strip ends at Draft, its Draft in the same column as a full row's.
  const strip = await vision.getByTestId("autonomy-steps").boundingBox();
  const draft = await step(page, "vision", "Draft").boundingBox();
  const fullDraft = await step(page, "priorities", "Draft").boundingBox();
  expect(Math.abs(strip!.x + strip!.width - (draft!.x + draft!.width))).toBeLessThan(3);
  expect(Math.abs(draft!.x - fullDraft!.x)).toBeLessThan(2);
  await expect(vision.getByTestId("autonomy-locked")).toBeHidden();
  await vision.getByRole("button", { name: "About Draft the vision" }).click();
  await expect(vision.getByTestId("autonomy-locked")).toHaveText("Recommend and Act stay with people: the vision itself.");
  // The steps that remain still work.
  await expect(step(page, "vision", "Draft")).toHaveAttribute("aria-pressed", "true");
  await step(page, "vision", "Observe").click();
  await expect(page.getByRole("dialog", { name: "Change Draft the vision" })).toBeVisible();
});

// fails_when=the page's tooltip calls the top level "Act within limits" while the steps and the
// change sheet call it "Act".
test("autonomy: the top level reads \"Act\" in the tooltip, the steps and the change sheet", async ({ page }) => {
  await openAutonomy(page);
  await page.getByRole("button", { name: "About autonomy" }).click();
  const pageTip = page.getByRole("tooltip").filter({ hasText: "How far Oracle goes on its own" });
  await expect(pageTip).toContainText("Act:");
  await expect(pageTip).not.toContainText("Act within limits");
  await page.getByRole("button", { name: "About autonomy" }).click();

  // The step button itself reads "Act".
  await expect(step(page, "priorities", "Act")).toHaveText("Act");
  await step(page, "priorities", "Act").click();
  const sheet = page.getByRole("dialog", { name: "Change Order priorities" });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByTestId("autonomy-to")).toContainText("Becomes Act:");
  await expect(sheet).not.toContainText("Act within limits");
});
