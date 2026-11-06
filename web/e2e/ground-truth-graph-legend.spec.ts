import { expect, test } from "./test";

import { login } from "./helpers";

// protects=the Ground Truth graph's legend prose sits behind the (i) beside "Feature × goal", not on the page;
// fails_when=the Rings/Bars/dot sentences show on the page, or the (i) lacks them;
// no_claim=how the marks are drawn.
test("feature × goal: the legend's words are in the (i), not on the page", async ({ page }) => {
  await login(page);
  await page.goto("/ground-truth");
  await expect(page.getByTestId("goal-g.activation")).toBeVisible();

  const panel = page.getByRole("region", { name: "Feature × goal", exact: true });
  await expect(panel.getByRole("table", { name: "Feature × goal" })).toBeVisible();
  await expect(panel.getByTestId("ledger-legend")).toHaveCount(0);
  await expect(panel.getByText("Bars: how much a feature moves a goal")).toBeHidden();
  await expect(panel.getByText("A dot: no link.")).toBeHidden();

  await panel.getByRole("button", { name: "About Feature × goal" }).click();
  const tip = panel.getByRole("tooltip");
  await expect(tip).toBeVisible();
  await expect(tip).toContainText("Bars: how much a feature moves a goal, none to strong");
  await expect(tip).toContainText("Rings: confidence, 0 to 100%, from the item's evidence");
  await expect(tip).toContainText("A dot: no link.");
});
