import { expect, test, type Page } from "./test";

import { GROUND_TRUTH_FLAGS_SCENARIO } from "../lib/api/mock/ground-truth";
import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";

/**
 * codes-on-join: every feature has a code, given when it joins the Ground Truth (added, or a
 * proposed one confirmed), as api/oracle/baseline/fixes.py code_on_join: the next F-number. The
 * save's notice says the code it got, and the feature shows by its code and name. Driven through
 * the UI against the mock (web/lib/api/mock/feature-codes.ts). Invented data only.
 */

const DESKTOP = { width: 1440, height: 900 };
test.use({ viewport: DESKTOP });

async function openFlags(page: Page) {
  await page.addInitScript(([key, value]) => localStorage.setItem(key, value), [MOCK_SCENARIO_KEY, GROUND_TRUTH_FLAGS_SCENARIO] as const);
  await login(page);
  await page.goto("/baseline");
  await expect(page.getByTestId("gt-band")).toBeVisible();
}

const row = (page: Page, name: string) => page.getByTestId("gt-row").filter({ hasText: name });

test("a feature added to the Ground Truth gets its code, shown before its name", async ({ page }) => {
  await openFlags(page);
  await page.getByTestId("gt-count-unlinked_item").click();
  await row(page, "Export to sheets").getByRole("button", { name: /Add to Ground Truth/ }).click();
  // The next F-number over every code (the scenario's codes run to F-112).
  await expect(page.getByTestId("gt-notice")).toContainText("Added “Export to sheets” to the Ground Truth as F-113.");
  // It has a code, so it is not flagged for one; it serves no goal yet, and reads by its code and name.
  await expect(page.getByTestId("gt-count-no_code")).toContainText("1");
  await page.getByTestId("gt-count-no_goal").click();
  await expect(page.getByRole("button", { name: "Pick a goal: F-113 Export to sheets" })).toBeVisible();
});

test("a feature added on the Ground Truth page is saved with its code", async ({ page }) => {
  await login(page);
  await page.goto("/ground-truth");
  await expect(page.getByRole("heading", { level: 1, name: "Ground Truth" })).toBeVisible();
  await page.getByRole("region", { name: "Feature × goal", exact: true }).getByRole("button", { name: "Add" }).click();
  const form = page.getByRole("dialog", { name: "Add an item" });
  await expect(form.getByLabel("Kind")).toHaveValue("feature");
  await form.getByLabel("Title").fill("Gift wrapping");
  await form.getByRole("button", { name: "Add", exact: true }).click();
  await expect(form).toHaveCount(0);
  await expect(page.getByRole("status").filter({ hasText: "Added" })).toContainText(/Added “Gift wrapping” as F-\d{2,}\./);
});

test("confirming a proposed feature gives it its code", async ({ page }) => {
  await login(page);
  await page.goto("/ground-truth");
  await expect(page.getByRole("heading", { level: 1, name: "Ground Truth" })).toBeVisible();
  // A run proposed Dark mode (invented): it is not in the Ground Truth yet, so it has no code (a run's key).
  await page.evaluate(() => {
    const db = JSON.parse(localStorage.getItem("po-mock-db-v2")!);
    Object.assign(db.baseline.entities.find((e: { key: string }) => e.key === "F-81"), { status: "proposed", key: "f.dark-mode" });
    localStorage.setItem("po-mock-db-v2", JSON.stringify(db));
  });
  await page.reload();
  const row = page.getByTestId("product-p.admin-console").getByRole("row").filter({ hasText: "Dark mode" });
  await row.getByRole("button", { name: /Dark mode/ }).first().click();
  const d = page.getByRole("dialog", { name: /Dark mode/ });
  await d.getByRole("button", { name: "Confirm" }).click();
  await expect(d.getByRole("status").filter({ hasText: "Confirmed" })).toContainText(/Confirmed “Dark mode” as F-\d{2,}\./);
});
