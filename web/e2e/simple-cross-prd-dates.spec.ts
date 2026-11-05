import { expect, test, type Page } from "./test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { ADMIN } from "./helpers";

/**
 * A feature may depend on a feature of another area PRD (the owner, Nov 4). In Simple, an item
 * typed to start before the other PRD's feature it waits on ends gets a plain warning line that
 * names that feature with its PRD. On the mock layer ("simple-cross-prd-dates": the Setup
 * checklist of Guided setup waits on the Alert rules engine of Usage alerts), driven from Home.
 *
 * Test cards:
 * - "warned": protects=Home's broken links list the Setup checklist, naming the Alert rules
 *   engine with its PRD; fails_when=the line leaves out which PRD holds the dependency.
 * - "phone": the same line at 390 px.
 */

async function signIn(page: Page) {
  await page.context().addInitScript(
    ([key, value]) => {
      if (!sessionStorage.getItem("cross-prd-dates")) {
        localStorage.removeItem("po-mock-db-v2");
        sessionStorage.setItem("cross-prd-dates", "1");
      }
      localStorage.setItem(key, value);
    },
    [MOCK_SCENARIO_KEY, "simple-cross-prd-dates"] as const,
  );
  await page.goto("/login");
  await page.getByLabel("Email").fill(ADMIN.email);
  await page.getByLabel("Password").fill(ADMIN.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).not.toHaveURL(/\/login/);
  await page.goto("/simple");
  await expect(page.getByTestId("simple-page").getByTestId("home-sentence")).toBeVisible();
}

const warning = (page: Page) =>
  page
    .getByTestId("simple-page")
    .getByTestId("home-broken-item")
    .filter({ has: page.locator(".text-crit", { hasText: "Setup checklist" }) })
    .getByTestId("home-broken")
    .filter({ hasText: "which it depends on" });

for (const [name, viewport] of [
  ["warned", { width: 1440, height: 900 }],
  ["phone", { width: 390, height: 844 }],
] as const) {
  test.describe(name, () => {
    test.use({ viewport });

    test(`${name}: a typed start before another PRD's dependency ends names that PRD`, async ({ page }) => {
      await signIn(page);
      await expect(warning(page).first()).toBeVisible();
      await expect(warning(page).first()).toContainText(/Alert rules engine’? \(Usage alerts PRD\), which it depends on, ends \w{3} \d+/);
    });
  });
}
