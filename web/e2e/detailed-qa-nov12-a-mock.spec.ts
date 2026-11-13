import { expect, test } from "./test";

import { login, openSection } from "./helpers";

/**
 * Visual QA, Nov 12 (detailed-a #7, #18), on the default mock company (invented data only).
 *
 * #7: protects = the Ground Truth's features have their codes (Guided setup is F-82), shown in
 * the feature panel, and the Ground Truth flags band counts what the check finds in the default
 * company too (Dark mode serves no goal); fails_when = the panel shows no code, or the band is
 * missing because the default company reads no flags.
 *
 * #18: protects = the PRD's Goal trace names its goal by its name ("Raise activation"), never
 * by a place code (G1); fails_when = it reads "Serves G1 (activation)".
 */

test.use({ viewport: { width: 1440, height: 900 } });

test("#7: the default Ground Truth shows Guided setup's code in its panel, and its one flag", async ({ page }) => {
  await login(page);
  await page.getByTestId("nav-baseline").click();
  await expect(page.getByRole("heading", { level: 1, name: "Ground Truth" })).toBeVisible();

  const band = page.getByTestId("gt-band");
  await expect(band).toBeVisible();
  await expect(band.getByTestId("gt-total")).toHaveText("1");
  await expect(band.getByTestId("gt-count-no_goal")).toContainText("1");
  await band.getByTestId("gt-count-no_goal").click();
  await expect(page.getByTestId("gt-row").filter({ hasText: "Dark mode" })).toBeVisible();

  await page.getByTestId("feature-F-82").getByRole("button", { name: /Guided setup/ }).first().click();
  const panel = page.getByRole("dialog", { name: /Guided setup/ });
  await expect(panel.getByTestId("drawer-code")).toHaveText("F-82");
  await expect(panel).toContainText("Feature · F-82");
});

test("#18: the PRD's Goal trace names its goal, never a place code", async ({ page }) => {
  await login(page);
  await page.goto("/documents/checkout-redesign/v/2");
  const trace = await openSection(page, "goal-trace");
  await expect(trace).toContainText("Serves Raise activation");
  await expect(trace).not.toContainText("G1 (");
  await expect(trace).not.toContainText(/\bG1\b/);
});
