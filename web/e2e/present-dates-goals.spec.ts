import { expect, test, type Page } from "./test";

import { login } from "./helpers";

// Visual QA pass E: Present mode of Saved carts v2. Dates in the brief's text read month
// first (E-11), a goal in the items table carries its name (E-12), and a version with no
// brief says so by the PRD's title (E-15).

const ISO = /\d{4}-\d{2}-\d{2}/;

async function openPresent(page: Page) {
  await login(page);
  await page.goto("/documents/saved-carts/v/2");
  await page
    .getByRole("link", { name: "Present" })
    .filter({ visible: true })
    .first()
    .click();
  await expect(page).toHaveURL(/\/documents\/saved-carts\/v\/2\/present$/);
  await expect(page.getByTestId("slide-counter")).toHaveText("1 / 10");
}

const current = (page: Page) =>
  page.getByTestId("audience-view").locator(".current-slide");

async function next(page: Page, to: number) {
  await page.getByRole("button", { name: "Next slide" }).click();
  await expect(page.getByTestId("slide-counter")).toHaveText(`${to} / 10`);
}

test.use({ viewport: { width: 1440, height: 900 } });

test("E-11, E-12: every slide's dates read month first; the items table names its goal", async ({
  page,
}) => {
  await openPresent(page);
  expect(await current(page).innerText()).not.toMatch(ISO);
  for (let n = 2; n <= 10; n++) {
    await next(page, n);
    const text = await current(page).innerText();
    expect(text, `slide ${n}`).not.toMatch(ISO);
    if (n === 5) {
      await expect(current(page).locator(".slide-title")).toHaveText(
        "Features by milestone",
      );
      const goals = current(page).locator("tbody tr td:nth-child(3)");
      await expect(goals).toHaveText([
        "G2 Retention",
        "G2 Retention",
        "G2 Retention",
      ]);
    }
    if (n === 9) {
      await expect(current(page).locator(".slide-title")).toHaveText(
        "Decisions needed",
      );
      await expect(current(page)).toContainText("needed by Nov 1, 2026");
      await expect(current(page)).toContainText("needed by Nov 15, 2026");
    }
  }
});

test("E-15: a version without a brief names the PRD by its title", async ({
  page,
}) => {
  await login(page);
  await page.goto("/documents/checkout-redesign/v/2/present");
  await expect(page.getByTestId("present-mode")).toContainText(
    "Version 2 of Checkout redesign PRD has no brief to present: open the full PRD instead.",
  );
  await expect(page.getByTestId("present-mode")).not.toContainText(
    "checkout-redesign",
  );
});
