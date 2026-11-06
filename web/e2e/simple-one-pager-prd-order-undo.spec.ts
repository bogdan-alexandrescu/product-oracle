import { login } from "./helpers";
import { expect, test, type Page } from "./test";

/*
 * prd-order, fix round 1 (the review): an owner's Move up / Move down on Simple › One-pagers says
 * what it did with an Undo that puts every PRD back where it was; a failed move says so on its own
 * line; the list says its order ("Company order"); Detailed › PRDs opens in the same company order
 * (a column sort is a choice, and "Company order" takes it back). Driven through the UI on the mock
 * (invented data), on a desktop in light and on a 390 px phone in dark.
 *
 * - protects = Undo after a move restores the earlier order on One-pagers and Detailed; the move's
 *   error line; "Company order" on both lists; fails_when = no Undo, Undo leaves the moved order,
 *   no error line on a failed move, or Detailed opens newest first.
 * - no_claim = the API's restore route and locking (api/tests/test_prd_order.py).
 */

const USAGE = "Usage alerts PRD";
const CHECKOUT = "Checkout redesign PRD";

async function onePagers(page: Page): Promise<string[]> {
  await expect(page.getByTestId("one-pager-row").first()).toBeVisible();
  return page.getByTestId("one-pager-row").getByRole("link").allTextContents();
}

async function moveUp(page: Page, title: string) {
  await page.getByRole("button", { name: `More for ${title}` }).click();
  await page.getByRole("menuitem", { name: "Move up" }).click();
}

for (const { name, viewport, scheme } of [
  { name: "desktop, light", viewport: { width: 1280, height: 900 }, scheme: "light" as const },
  { name: "phone, dark", viewport: { width: 390, height: 844 }, scheme: "dark" as const },
]) {
  test.describe(name, () => {
    test.use({ viewport, colorScheme: scheme });

    test("an owner moves a PRD, undoes it, and a failed move says so", async ({ page }) => {
      test.setTimeout(120_000);
      await login(page);
      await page.goto("/simple/one-pagers");
      await expect(page.getByTestId("one-pagers-order")).toHaveText("Company order");
      const before = await onePagers(page);
      expect(before.slice(0, 2)).toEqual([USAGE, CHECKOUT]);

      await moveUp(page, CHECKOUT);
      await expect(page.getByTestId("one-pager-row").getByRole("link").first()).toHaveText(CHECKOUT);
      const toast = page.getByText(`Moved ${CHECKOUT} up.`);
      await expect(toast).toBeVisible();
      await page.getByRole("button", { name: "Undo" }).click();
      await expect(page.getByTestId("one-pager-row").getByRole("link").first()).toHaveText(USAGE);
      expect(await onePagers(page)).toEqual(before);

      // Detailed › PRDs reads the same company order by default.
      await page.goto("/documents");
      const rows = page.getByTestId("documents-table").getByTestId("document-row").locator("td:first-child a");
      await expect(rows.first()).toHaveText(before[0]);
      expect((await rows.allInnerTexts()).filter((t) => before.includes(t))).toEqual(before);

      // A move that fails says so on its own line, and the order stays.
      await page.goto("/simple/one-pagers");
      await onePagers(page);
      await page.evaluate(() => localStorage.setItem("po-mock-fail-once", "POST /v1/documents/checkout-redesign/move"));
      await moveUp(page, CHECKOUT);
      await expect(page.getByRole("alert").filter({ hasText: "Oracle could not move the PRD. Try again." })).toBeVisible();
      expect(await onePagers(page)).toEqual(before);
    });
  });
}

test("Detailed › PRDs opens in the company order and a column sort can go back to it", async ({ page }) => {
  await login(page);
  await page.goto("/simple/one-pagers");
  const order = await onePagers(page);
  await page.goto("/documents");
  const rows = page.getByTestId("documents-table").getByTestId("document-row").locator("td:first-child a");
  await expect(rows.first()).toHaveText(order[0]);
  await expect(page.getByTestId("documents-order")).toHaveText("Company order");
  await page.getByTestId("sort-updated").click();
  await expect(page.getByRole("button", { name: "Back to company order" })).toBeVisible();
  await page.getByRole("button", { name: "Back to company order" }).click();
  await expect(page.getByTestId("documents-order")).toHaveText("Company order");
  expect((await rows.allInnerTexts()).filter((t) => order.includes(t))).toEqual(order);
});
