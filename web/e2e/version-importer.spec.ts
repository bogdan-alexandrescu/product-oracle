import { expect, test, type Page } from "./test";

import { login } from "./helpers";

// #256: the PRD overview's version panel says who imported a version by name: a
// member's display name, "Oracle" for a run, an API token's name. The id is only in
// the tooltip.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

async function pick(page: Page, n: number) {
  const row = page.getByTestId("versions-table").getByRole("row").filter({ hasText: `Version ${n}` });
  await row.getByRole("gridcell").nth(2).click();
  await expect(row).toHaveAttribute("aria-selected", "true");
}

test("each version names who imported it, with the id only in the tooltip", async ({ page }) => {
  await login(page);
  await page.goto("/documents/online-deposits");
  const by = page.getByTestId("version-inspector").getByTestId("version-importer");
  for (const [n, name] of [
    [1, "Approver"],
    [2, "agent-track"],
    [3, "Oracle"],
  ] as const) {
    await pick(page, n);
    await expect(by).toHaveText(name);
    await expect(by).toHaveAttribute("title", UUID);
    await expect(page.getByTestId("version-inspector")).not.toContainText(/[0-9a-f]{8}-[0-9a-f]{4}-/);
  }
});
