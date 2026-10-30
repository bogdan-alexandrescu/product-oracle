import { expect, test, type Page } from "@playwright/test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";

/*
 * #519 item 3: Run rituals follows H11 Autonomy (the tick starts a ritual's own run at "Act
 * within limits", within the cost limit, and only reminds below it), so Settings › Autonomy
 * shows it as in effect. Each test's card: protects=...; fails_when=...; no_claim=...
 */

const row = (page: Page, key: string) => page.getByTestId(`autonomy-row-${key}`);
const step = (page: Page, key: string, label: string) => row(page, key).getByRole("group").getByRole("button", { name: label, exact: true });

// protects=an owner sets Run rituals to Act with a $5 limit and a reason; the row shows the limit
// and no "Takes effect when H2 Cadence engine ships" chip, as Oracle follows it now; fails_when=the
// row still says the level waits on H2; no_claim=the run the tick starts (pytest
// tests/test_rituals_autonomy.py covers it).
test("autonomy: Run rituals at Act within $5 a run is in effect, with no pending chip", async ({ page }) => {
  await login(page);
  await page.getByRole("navigation", { name: "Oracle" }).getByTestId("nav-settings").click();
  await page.getByRole("navigation", { name: "Settings" }).getByTestId("nav-autonomy").click();
  await expect(page.getByRole("heading", { level: 1, name: "Autonomy" })).toBeVisible();
  const rituals = row(page, "rituals");
  await expect(rituals).toContainText("Run rituals");
  await expect(rituals.getByTestId("autonomy-pending")).toHaveCount(0);
  await step(page, "rituals", "Act").click();
  const sheet = page.getByRole("dialog", { name: "Change Run rituals" });
  await expect(sheet.getByTestId("autonomy-to")).toContainText("Oracle starts a ritual's preparation runs");
  await sheet.getByLabel("Highest cost a run (USD)").fill("5");
  await sheet.getByLabel("Why").fill("Pre-read summaries are cheap and routine");
  await sheet.getByRole("button", { name: "Save" }).click();
  await expect(sheet).toBeHidden();
  await expect(step(page, "rituals", "Act")).toHaveAttribute("aria-pressed", "true");
  await expect(rituals.getByTestId("autonomy-limits")).toHaveText("up to $5 a run");
  await expect(rituals.getByTestId("autonomy-pending")).toHaveCount(0);
});

// protects=#524 review item 3: the "Oracle did" row of a ritual summary Oracle started is a link
// that opens that ritual's pre-read; fails_when=the row's subject has no href, so its summary is
// plain text; no_claim=the record the API writes (pytest tests/test_rituals_autonomy.py covers it).
test("autonomy: an Oracle did row of a ritual opens the ritual", async ({ page }) => {
  await page.addInitScript((key) => localStorage.setItem(key, "oracle-did-launch-ritual"), MOCK_SCENARIO_KEY);
  await login(page);
  await page.getByRole("navigation", { name: "Oracle" }).getByTestId("nav-inbox").click();
  const did = page.getByTestId("inbox-oracle-actions").getByRole("row").filter({ hasText: "Monthly roadmap refresh" });
  await expect(did).toContainText("Run rituals");
  await did.getByRole("link", { name: /^Started a summary of the pre-read for 'Monthly roadmap refresh'/ }).click();
  await expect(page).toHaveURL(/\/company\/rituals\/[0-9a-f-]{36}$/);
  await expect(page.getByRole("heading", { level: 2, name: "Monthly roadmap refresh" })).toBeVisible();
});
