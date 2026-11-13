import { expect, test, type Page } from "./test";

import { GROUND_TRUTH_FLAGS_SCENARIO } from "../lib/api/mock/ground-truth";
import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";

/**
 * Visual QA, Nov 12 (detailed-a #1, #2, #10, #11), on the Ground Truth page in the
 * "ground-truth-flags" scenario: every feature shows its code with its name (the Graph tab's rows,
 * the flag rows and the notices a fix leaves), a feature a run only proposed reads once on its
 * flag row, and the feature panel's lock line wraps rather than cutting its date.
 */

test.use({ viewport: { width: 1440, height: 900 } });

async function open(page: Page) {
  await page.addInitScript(([key, value]) => localStorage.setItem(key, value), [MOCK_SCENARIO_KEY, GROUND_TRUTH_FLAGS_SCENARIO] as const);
  await login(page);
  await page.goto("/baseline");
  await expect(page.getByTestId("gt-band")).toBeVisible();
}

const row = (page: Page, name: string) => page.getByTestId("gt-row").filter({ hasText: name });

async function openKind(page: Page, kind: string) {
  await page.getByTestId(`gt-count-${kind}`).click();
  await expect(page.getByTestId(`gt-list-${kind}`)).toBeVisible();
}

test("#1: the Graph tab's feature rows show each feature's code with its name", async ({ page }) => {
  await open(page);
  await expect(page.getByRole("tab", { name: /Graph/ })).toHaveAttribute("aria-selected", "true");
  for (const [key, name] of [
    ["F-02", "Audit log"],
    ["F-03", "Night alerts"],
  ]) {
    const title = page.getByTestId(`feature-${key}`).getByRole("button", { name: `${key} ${name}`, exact: true });
    await expect(title).toBeVisible();
    await expect(title).toHaveText(`${key} ${name}`);
  }
});

test("#2: the runs-today row and the Take it off the roadmap notice name F-03 Night alerts", async ({ page }) => {
  await open(page);
  await openKind(page, "runs_today_on_roadmap");
  const alerts = row(page, "Night alerts");
  await expect(alerts.getByTestId("code-chip")).toHaveAccessibleName("F-03 Night alerts");
  await alerts.getByRole("button", { name: /Take it off the roadmap/ }).click();
  await expect(page.getByTestId("gt-notice")).toContainText("Took “F-03 Night alerts” off the roadmap.");
});

test("#2: the Pick a goal notice names F-02 Audit log", async ({ page }) => {
  await open(page);
  await openKind(page, "no_goal");
  await row(page, "Audit log").getByRole("button", { name: /Pick a goal/ }).click();
  await page.getByTestId("gt-picker").getByRole("button").filter({ hasText: "Raise activation" }).click();
  await expect(page.getByTestId("gt-notice")).toContainText("“F-02 Audit log” now serves “Raise activation”.");
});

test("#10: the Not linked row shows Weekly digest once, as F-14 Weekly digest", async ({ page }) => {
  await open(page);
  await openKind(page, "unlinked_item");
  const digest = row(page, "Weekly digest");
  await expect(digest.getByTestId("code-chip")).toHaveCount(1);
  await expect(digest.getByTestId("code-chip")).toHaveAccessibleName("F-14 Weekly digest");
  await expect(digest.getByTestId("gt-unconfirmed").locator('[data-kind="warn"]')).toHaveText("Waiting to be confirmed");
  const text = await digest.innerText();
  expect(text.split("Weekly digest").length - 1).toBe(1);
});

test("#11: the feature panel's lock line wraps instead of cutting its date", async ({ page }) => {
  await open(page);
  const feature = page.locator('[data-testid^="feature-"]').filter({ hasText: "Guided setup" });
  await feature.getByRole("button", { name: /Guided setup/ }).first().click();
  const lock = page.getByRole("dialog", { name: /Guided setup/ }).getByTestId("lock-note");
  await expect(lock).toContainText("Oct 15");
  await expect(lock).not.toHaveClass(/\btruncate\b/);
  const fits = await lock.evaluate((el) => el.scrollWidth <= el.clientWidth);
  expect(fits).toBe(true);
});
