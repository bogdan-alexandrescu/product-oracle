import { expect, test, type Page } from "./test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";

import { login } from "./helpers";

/*
 * The review's minors on the second QA pass of Company (Strategy, Rituals, Metrics,
 * Decisions), driven through the UI on the mock layer as the owner. Each test names what
 * it protects and when it fails.
 */

const CAPS = "Ship usage caps before anomaly detection";

const rows = (page: Page) => page.getByTestId("decision-row");
const group = (page: Page, name: string) => page.getByTestId("decision-filters").getByRole("group", { name, exact: true });

test.use({ viewport: { width: 1440, height: 900 } });

// protects=qa-company-20 (one button per action): an owner with no product strategy sees one
// New product strategy, on its card; the empty stack points to it; fails_when=the empty stack
// shows a second button.
test("strategy: no product strategy yet offers one New product strategy, on its card", async ({ page }) => {
  await login(page);
  await page.goto("/company/strategy");
  const empty = page.getByTestId("stack-empty");
  await expect(empty).toContainText("once a product strategy is approved");
  await expect(page.getByRole("button", { name: "New product strategy" })).toHaveCount(1);
  await expect(empty.getByRole("button")).toHaveCount(0);
  await page.getByTestId("strategy-card").getByRole("button", { name: "New product strategy" }).click();
  await expect(page.getByRole("dialog", { name: "New product strategy" })).toBeVisible();
});

// protects=the mock follows the API's prepare_usd: at Run rituals "Act within limits", within
// the limit, Prepare now on an active check-in writes its summary too, so it asks first with
// the cost; fails_when=Prepare now starts at once without saying what it spends.
test("rituals: at Act within limits, Prepare now asks first and names the summary's cost", async ({ page }) => {
  await page.clock.install({ time: new Date("2026-10-28T17:00:00Z") });
  await page.addInitScript((key) => localStorage.setItem(key, "rituals"), MOCK_SCENARIO_KEY);
  await login(page);
  await page.goto("/settings/autonomy");
  const rituals = page.getByTestId("autonomy-row-rituals");
  await rituals.getByRole("group").getByRole("button", { name: "Act", exact: true }).click();
  const sheet = page.getByRole("dialog", { name: "Change Run rituals" });
  await sheet.getByLabel("Highest cost a run (USD)").fill("5");
  await sheet.getByLabel("Why").fill("Pre-read summaries are cheap and routine");
  await sheet.getByRole("button", { name: "Save" }).click();
  await expect(sheet).toBeHidden();

  await page.goto("/company/rituals");
  await page.getByTestId("ritual-row").filter({ hasText: "Weekly goals check-in" }).click();
  const inspector = page.getByTestId("ritual-inspector").filter({ visible: true });
  await expect(inspector).toContainText("Weekly goals check-in");
  await inspector.getByRole("button", { name: "Prepare now" }).click();
  const ask = page.getByRole("alertdialog", { name: "Prepare now" });
  await expect(ask).toContainText("writes its summary: one Oracle run of about $3.00");
  await ask.getByRole("button", { name: "Back" }).click();
  await expect(page).toHaveURL(/\/company\/rituals$/);
});

// protects=the threshold's problem is read with the field; fails_when=the field's
// description is only its help text while it is invalid.
test("metrics: a wrong threshold is described by its own note", async ({ page }) => {
  await login(page);
  await page.goto("/company/metrics");
  await page.getByTestId("metrics-empty").filter({ visible: true }).getByRole("button", { name: "Add your first metric" }).click();
  const dialog = page.getByRole("dialog", { name: "Add metric" });
  const threshold = dialog.getByLabel("Threshold (%)");
  await threshold.fill("900");
  await dialog.getByRole("button", { name: "Add metric" }).click();
  await expect(dialog.getByTestId("metric-error-threshold")).toHaveText("Write a number from 1 to 500, or leave it empty.");
  await expect(threshold).toHaveAccessibleDescription(/Write a number from 1 to 500, or leave it empty\./);
  await expect(threshold).toHaveAccessibleDescription(/is a variance too/);
});

// protects=Clear filters clears every filter, the kind too; fails_when=the list stays empty
// on the kind and needs a second click on Show all kinds.
test("decisions: Clear filters resets the kind as well", async ({ page }) => {
  await login(page);
  await page.goto("/company/decisions?state=all");
  await expect(rows(page).filter({ hasText: CAPS })).toBeVisible();
  await group(page, "Kind")
    .getByRole("button", { name: /^Checkpoints/ })
    .click();
  const search = page.getByLabel("Search decisions");
  await search.fill("usage caps");
  await search.press("Enter");
  const empty = page.getByTestId("decisions-empty");
  await expect(empty).toContainText("No decisions match");
  await empty.getByRole("button", { name: "Clear filters" }).click();
  await expect(rows(page).filter({ hasText: CAPS })).toBeVisible();
  await expect(page.getByTestId("decisions-empty")).toHaveCount(0);
});
