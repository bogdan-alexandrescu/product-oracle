import { expect, test, type Locator, type Page } from "./test";

import { login } from "./helpers";

/*
 * QA pass 4 on the Inbox (qa4-work-32, 35, 38), driven through the UI on the mock: the default
 * scenario, and the "suggestions" one (inbox-act-in-place.spec.ts's seed) where Oracle pushed
 * back on Team workspaces' custom roles.
 */

const ROLES = "Add custom roles to the first release";

const tabs = (page: Page) => page.getByTestId("inbox-state-tabs");
const tab = (page: Page, name: string) => tabs(page).getByRole("tab", { name: new RegExp(`^${name}`) });

async function openInbox(page: Page) {
  await page.goto("/inbox");
  await expect(page.getByRole("heading", { level: 1, name: "Inbox" })).toBeVisible();
  await expect(tabs(page)).toBeVisible();
}

test.describe("desktop", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("qa4-work-32: Accept on a comment Oracle pushed back on asks why accept it, not 'why keep your call'", async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("po-mock-scenario", "suggestions"));
    await login(page);
    await openInbox(page);
    await expect(tab(page, "New")).toHaveAttribute("aria-selected", "true");
    const row = page.getByTestId("inbox-tab-new").getByTestId("inbox-feedback").locator("tr[data-row]").filter({ hasText: ROLES });
    await row.getByRole("button", { name: "Accept", exact: true }).click();
    const why = row.getByLabel("Oracle pushed back. Why accept anyway?");
    await expect(why).toBeVisible();
    await expect(why).toBeFocused();
    await expect(row).not.toContainText("keep your call");
    await row.getByRole("button", { name: "Accept", exact: true }).click();
    await expect(row.getByTestId("inbox-action-error")).toHaveText("Say why you accept it.");
  });

  test("qa4-work-35: Sources that need attention lines its For and Age up with the table above", async ({ page }) => {
    await login(page);
    await openInbox(page);
    const main = page.getByTestId("inbox-needs").locator("[role=tabpanel] tr[data-row]").first();
    const sources = page.getByTestId("inbox-sources").locator("tr[data-row]").first();
    await expect(main).toBeVisible();
    await expect(sources).toBeVisible();
    const x = async (r: Locator, n: number) => (await r.locator(`td:nth-child(${n})`).boundingBox())!;
    for (const n of [3, 4, 5]) {
      const [a, b] = [await x(main, n), await x(sources, n)];
      expect(Math.abs(a.x - b.x)).toBeLessThanOrEqual(1);
      expect(Math.abs(a.width - b.width)).toBeLessThanOrEqual(1);
    }
  });

  test("qa4-work-38: the baseline checkpoint row says what is needed, not 'nothing left to decide'", async ({ page }) => {
    await login(page);
    await openInbox(page);
    const label = page.getByTestId("checkpoint-label").filter({ hasText: "Confirm the baseline" }).first();
    await expect(label).toHaveText(/^Confirm the baseline: (approve to continue|all \d+ items? handled, approve to continue)$/);
    await expect(page.getByTestId("inbox-needs")).not.toContainText("nothing left to decide");
  });
});
