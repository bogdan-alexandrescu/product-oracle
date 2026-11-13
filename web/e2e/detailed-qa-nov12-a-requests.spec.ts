import { expect, test, type Page } from "./test";

import { login } from "./helpers";

/*
 * Detailed visual QA, Nov 12, 2026 (pass A), finding 5: the request panel names a feature by its
 * code and name wherever it shows one (the Feature choices, the Feature row and Oracle's
 * suggestion), so two features are told apart. The mock's Ground Truth keys Guided setup F-82;
 * the seeded requests link it and Oracle suggests it. Driven through the UI on the mock API; invented data only.
 */

const CODED = "F-82 Guided setup";
const CODE_FIRST = /^[A-Z]{1,3}-\d+[a-j]? \S/;

const inspector = (page: Page) =>
  page.getByTestId("request-inspector").filter({ visible: true });

async function openRequest(page: Page, title: string) {
  await page
    .getByTestId("nav-requests")
    .filter({ visible: true })
    .first()
    .click();
  await expect(page).toHaveURL(/\/requests$/);
  await page
    .getByTestId("request-row")
    .filter({ hasText: title })
    .getByRole("button", { name: title })
    .click();
  await expect(
    inspector(page).getByRole("heading", { name: title }),
  ).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
});

test("#5: the Feature choices read each feature's code before its name", async ({
  page,
}) => {
  await login(page);
  await openRequest(page, "Keep the delivery address between orders");
  const select = inspector(page).getByRole("combobox", { name: "Feature", exact: true });
  const options = select.locator("option");
  await expect(options.filter({ hasText: "Guided setup" })).toHaveText(
    CODED,
  );
  // The linked feature is the one picked, by code and name.
  await expect(select.locator("option:checked")).toHaveText(CODED);

  // The Disqualify form's "Already possible" picker names the features the same way.
  await inspector(page)
    .getByRole("button", { name: "Disqualify", exact: true })
    .click();
  await inspector(page)
    .getByLabel("Reason")
    .selectOption({ label: "Already possible" });
  const basis = inspector(page)
    .locator("select")
    .filter({ has: page.locator("option", { hasText: "Pick the feature" }) });
  await expect(
    basis.locator("option").filter({ hasText: "Guided setup" }),
  ).toHaveText(CODED);
  const coded = (await basis.locator("option").allTextContents()).filter((t) =>
    CODE_FIRST.test(t.trim()),
  );
  expect(coded.length).toBeGreaterThan(0);
});

test("#5: the Feature row and Oracle's suggestion read the feature's code before its name", async ({
  page,
}) => {
  // A viewer cannot change links: the panel shows them as rows.
  await login(page, "viewer@example.com");
  await openRequest(page, "Keep the delivery address between orders");
  await expect(
    inspector(page).locator('dt:text-is("Feature") + dd'),
  ).toHaveText(CODED);

  await openRequest(page, "Save my card for the next order");
  await expect(inspector(page).getByTestId("suggested-feature")).toHaveText(
    `Feature: ${CODED}`,
  );
});
