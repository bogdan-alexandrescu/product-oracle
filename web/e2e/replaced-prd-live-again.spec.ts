import { AREA_PRDS, OLD_PRD } from "../lib/api/mock/one-roadmap";
import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";
import { expect, test, type Page } from "./test";

/*
 * replaced-prd-history (re-review): one rule everywhere, a PRD is history only while a live PRD
 * replaces it. Against the mock's "one-roadmap" scenario (invented data): Trust plan, replaced by
 * User Safety and Scale, is left out of Simple's One-pagers; once both are moved to Trash from
 * the documents page, Trust plan is listed again.
 */

const OLD = OLD_PRD[1];

async function moveToTrash(page: Page, title: string) {
  await page.goto("/documents");
  await expect(page.getByTestId("documents-table")).toBeVisible();
  const row = page.getByTestId("document-row").filter({ hasText: title });
  // A scroll closes a row menu: centre the row and open again until Delete… takes.
  await expect(async () => {
    await row.first().evaluate((el) => el.scrollIntoView({ block: "center" }));
    if (!(await page.getByRole("menuitem", { name: "Delete…" }).isVisible()))
      await row.first().getByRole("button", { name: `Actions for ${title}` }).click();
    await page.getByRole("menuitem", { name: "Delete…" }).click({ timeout: 2_000 });
  }).toPass({ timeout: 20_000 });
  const dialog = page.getByRole("dialog", { name: `Delete ${title}` });
  // Both are published: the copy elsewhere stays.
  await dialog.getByLabel("Delete it here; the external copy stays where it is").check();
  await dialog.getByRole("button", { name: "Move to Trash" }).click();
  await expect(dialog).toHaveCount(0);
}

/**
 * protects = a PRD whose every replacement is in Trash is live again in Simple: One-pagers lists
 * it; fails_when = Trust plan stays left out after User Safety and Scale are moved to Trash;
 * no_claim = the order of the rows.
 */
test("a PRD whose replacements are in Trash is listed again", async ({ page }) => {
  test.setTimeout(60_000);
  await page.context().addInitScript(([key, value]) => localStorage.setItem(key, value), [MOCK_SCENARIO_KEY, "one-roadmap"] as const);
  await login(page);
  const list = page.getByTestId("simple-one-pagers");
  await page.goto("/simple/one-pagers");
  await expect(list.getByRole("link", { name: AREA_PRDS[0][1], exact: true })).toBeVisible();
  await expect(list.getByRole("link", { name: OLD, exact: true })).toHaveCount(0);

  for (const [, title] of AREA_PRDS) await moveToTrash(page, title);

  await page.goto("/simple/one-pagers");
  await expect(list.getByRole("link", { name: OLD, exact: true })).toBeVisible();
});
