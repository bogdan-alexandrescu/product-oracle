import { expect, test, type Page } from "./test";

import { login } from "./helpers";

/**
 * QA pass 4, shell lane: Home, at desktop and phone width, on the mock's default company.
 *
 * protects = qa-shell-22 (the selected PRD's two counts have different names: its open review
 * feedback, and its sections not yet reviewed, never two "Open"s that disagree), qa-shell-23
 * (Needs you's "Oracle asks" row has the same bordered Open as every other row; "More" comes
 * before "+N more in Inbox" on a phone too).
 * no_claim = the API's inbox counts (the in-browser mock stands in).
 */

const lines = (page: Page) => page.getByTestId("home-needs-table").locator("tr[data-row]");

for (const [name, viewport] of [
  ["desktop", { width: 1440, height: 900 }],
  ["phone", { width: 390, height: 844 }],
] as const) {
  test.describe(name, () => {
    test.use({ viewport });

    test("qa-shell-22: the selected PRD names its open feedback and its sections not reviewed apart", async ({ page }) => {
      await login(page);
      const checkout = page.getByTestId("home-in-flight-table").getByTestId("flight-row").filter({ hasText: "Checkout redesign PRD" });
      // A phone shows the inspector after a tap (qa-company-32).
      if (name === "phone") await checkout.click();
      const inspector = page.getByTestId("home-inspector");
      await expect(inspector.getByRole("heading", { name: "Checkout redesign PRD" })).toBeVisible();
      await expect(inspector.getByTestId("stat-open").locator("dt")).toHaveText("Open feedback");
      const legend = inspector.getByTestId("inspector-sections");
      await expect(legend).toContainText("Not reviewed");
      await expect(legend).not.toContainText(/\bOpen\b/);
    });

    test("qa-shell-23: Oracle asks has the bordered Open of every row; More comes before its link", async ({ page }) => {
      await login(page);
      const asks = lines(page).filter({ hasText: "Oracle asks" });
      await expect(asks.getByRole("button", { name: "Answer" })).toBeVisible();
      const askOpen = asks.getByRole("link", { name: /^Open\b/ }).first();
      const runOpen = lines(page).filter({ hasText: "$14.20 / $9.00" }).getByRole("link", { name: "Open", exact: true });
      await expect(askOpen).toBeVisible();
      await expect(runOpen).toBeVisible();
      expect(await askOpen.getAttribute("class")).toBe(await runOpen.getAttribute("class"));

      const more = lines(page).filter({ has: page.getByTestId("home-needs-more") });
      const label = (await more.getByText("More", { exact: true }).boundingBox())!;
      const link = (await more.getByTestId("home-needs-more").boundingBox())!;
      // One line, the label first, as on a desktop.
      expect(label.x + label.width).toBeLessThanOrEqual(link.x);
      expect(Math.abs(label.y + label.height / 2 - (link.y + link.height / 2))).toBeLessThan(12);
    });
  });
}
