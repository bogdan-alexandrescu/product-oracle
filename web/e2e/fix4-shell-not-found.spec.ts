import { expect, test, type Page } from "./test";

import { login } from "./helpers";

/*
 * qa-shell-7, qa-shell-11: a stale link is the app's one not-found pattern everywhere: "<Thing>
 * not found", one sentence, one way back to its list and Go to Home.
 * protects = what a person reads on an old link; fails_when = the API's own words show, a back
 * control is drawn twice, Go to Home or the way back is missing; no_claim = the API's 404s.
 */

const SPEC_ID = "c3000000-0000-4000-8000-000000000001";
const BRIEF = "/documents/checkout-redesign-early-shipping-cost-spec/v/1";

/** The page's one way back and Go to Home; no other link names the same list. */
async function expectWaysOn(page: Page, back: string, backHref: string | RegExp) {
  const link = page.getByRole("link", { name: back, exact: true }).filter({ visible: true });
  await expect(link).toHaveCount(1);
  await expect(link).toHaveAttribute("href", backHref);
  await expect(page.getByRole("link", { name: "Go to Home" }).filter({ visible: true })).toHaveCount(1);
}

test("qa-shell-7: an old design link, in dark, is Design not found with Back to the tech brief and Go to Home", async ({ page }) => {
  await login(page);
  await page.evaluate(() => localStorage.setItem("oracle-theme", "dark"));
  await page.goto(`/specs/${SPEC_ID}/design/c3000000-0000-4000-8000-0000000000ff`);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.getByRole("heading", { level: 1, name: "Design not found" })).toHaveCount(1);
  await expect(page.getByTestId("design-not-found").filter({ visible: true })).toContainText("This design doesn't exist or was deleted.");
  await expect(page.getByText("design artifact version not found")).toHaveCount(0);
  await expectWaysOn(page, "Back to the tech brief", BRIEF);
  await page.getByRole("link", { name: "Back to the tech brief" }).filter({ visible: true }).click();
  await expect(page).toHaveURL(new RegExp(`${BRIEF}$`));
});

test("qa-shell-11: a missing PRD offers Back to PRDs and Go to Home", async ({ page }) => {
  await login(page);
  await page.goto("/documents/no-such-doc");
  await expect(page.getByRole("heading", { level: 1, name: "Document not found" })).toHaveCount(1);
  await expectWaysOn(page, "Back to PRDs", "/documents");
  await page.getByRole("link", { name: "Go to Home" }).filter({ visible: true }).click();
  await expect(page).toHaveURL(/\/home$/);
});

test("qa-shell-11: a missing run has a single way back to Runs, and Go to Home", async ({ page }) => {
  await login(page);
  await page.goto("/runs/no-such-run");
  await expect(page.getByRole("heading", { level: 1, name: "Run not found" }).filter({ visible: true })).toHaveCount(1);
  // The crumb "Runs" above the title is gone: Back to Runs is the one back control.
  await expect(page.locator("[data-page-back]").filter({ visible: true })).toHaveCount(0);
  await expectWaysOn(page, "Back to Runs", "/runs");
});

test("qa-shell-11: an unknown request is Page not found with Back to Requests", async ({ page }) => {
  await login(page);
  await page.goto("/requests/no-such-request");
  await expect(page.getByRole("heading", { level: 1, name: "Page not found" })).toHaveCount(1);
  await expectWaysOn(page, "Back to Requests", "/requests");
  await page.getByRole("link", { name: "Back to Requests" }).click();
  await expect(page).toHaveURL(/\/requests$/);
});

test("qa-shell-11: Simple's missing one-pager is One-pager not found with Back to One-pagers and Go to Home", async ({ page }) => {
  await login(page);
  await page.goto("/simple/one-pagers/no-such-prd");
  await expect(page.getByRole("heading", { level: 1, name: "One-pager not found" })).toHaveCount(1);
  await expect(page.getByText("This one-pager doesn't exist or was deleted.")).toBeVisible();
  await expect(page.getByText(/No PRD at this address/)).toHaveCount(0);
  // One way back: no "One-pagers" crumb besides Back to One-pagers.
  await expect(page.getByTestId("one-pager-missing").getByRole("link")).toHaveCount(2);
  await expectWaysOn(page, "Back to One-pagers", "/simple/one-pagers");
  await page.getByRole("link", { name: "Back to One-pagers" }).click();
  await expect(page).toHaveURL(/\/simple\/one-pagers$/);
});
