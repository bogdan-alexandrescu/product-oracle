import { expect, test } from "./test";

import { login, openSection } from "./helpers";

/**
 * Visual QA, Nov 12 (detailed-a #7, #18), on the default mock company (invented data only).
 *
 * #7: protects = the Ground Truth's features have their codes (Setup checklist is F-01), shown in
 * the feature panel, and the Ground Truth flags band counts what the check finds in the default
 * company too (Setup error report serves no goal); fails_when = the panel shows no code, or the band is
 * missing because the default company reads no flags.
 *
 * #18: protects = the PRD's Goal trace names its goal by its name ("Activation"), never
 * by a place code (G1); fails_when = it reads "Serves G1 (activation)".
 */

test.use({ viewport: { width: 1440, height: 900 } });

test("#7: the default Ground Truth shows Setup checklist's code in its panel, and its one flag", async ({ page }) => {
  await login(page);
  await page.getByTestId("nav-baseline").click();
  await expect(page.getByRole("heading", { level: 1, name: "Ground Truth" })).toBeVisible();

  const band = page.getByTestId("gt-band");
  await expect(band).toBeVisible();
  await expect(band.getByTestId("gt-total")).toHaveText("1");
  await expect(band.getByTestId("gt-count-no_goal")).toContainText("1");
  await band.getByTestId("gt-count-no_goal").click();
  await expect(page.getByTestId("gt-row").filter({ hasText: "Setup error report" })).toBeVisible();

  await page.getByTestId("feature-F-01").getByRole("button", { name: /Setup checklist/ }).first().click();
  const panel = page.getByRole("dialog", { name: /Setup checklist/ });
  await expect(panel.getByTestId("drawer-code")).toHaveText("F-01");
  await expect(panel).toContainText("Feature · F-01");
});

test("#18: the PRD's Goal trace names its goal, never a place code", async ({ page }) => {
  await login(page);
  await page.goto("/documents/annual-billing/v/2");
  const trace = await openSection(page, "goal-trace");
  await expect(trace).toContainText("Serves Growth");
  await expect(trace).not.toContainText("G1 (");
  await expect(trace).not.toContainText(/\bG1\b/);
});
