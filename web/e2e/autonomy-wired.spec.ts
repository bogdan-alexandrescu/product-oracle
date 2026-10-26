import { expect, test, type Page } from "./test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";

/*
 * H11 Autonomy wired by the picks that shipped: Order priorities (C9), Watch the roadmap (F2),
 * Decide reversible calls (H1) and Check outcomes (H3) are in effect, so Settings › Autonomy no
 * longer says they wait on a pick; and Watch the roadmap's level sets which fixes a date slip
 * offers on the Plan. The mock stands in for the API's rules (api/tests/test_autonomy_wired.py
 * proves them). Each test's card: protects=...; fails_when=...; no_claim=...
 */

const row = (page: Page, key: string) => page.getByTestId(`autonomy-row-${key}`);
const step = (page: Page, key: string, label: string) => row(page, key).getByRole("group").getByRole("button", { name: label, exact: true });
const rail = (page: Page) => page.getByRole("navigation", { name: "Oracle" });

async function openAutonomy(page: Page) {
  await rail(page).getByTestId("nav-settings").click();
  await page.getByRole("navigation", { name: "Settings" }).getByTestId("nav-autonomy").click();
  await expect(page.getByRole("heading", { level: 1, name: "Autonomy" })).toBeVisible();
}

// protects=the four shipped responsibilities show no "Takes effect when <pick> ships" chip, and
// Watch the roadmap reads at Recommend (what F2 built); fails_when=a row still waits on its pick, or
// the roadmap row reads Observe; no_claim=what each level does (pytest covers it).
test("autonomy: priorities, roadmap watch, decisions and outcomes are in effect", async ({ page }) => {
  await login(page);
  await openAutonomy(page);
  for (const key of ["priorities", "roadmap_watch", "decisions", "outcomes"]) {
    await expect(row(page, key)).toBeVisible();
    await expect(row(page, key).getByTestId("autonomy-pending")).toHaveCount(0);
  }
  await expect(step(page, "roadmap_watch", "Recommend")).toHaveAttribute("aria-pressed", "true");
  await expect(row(page, "roadmap_watch").getByTestId("autonomy-sentence")).toHaveText(
    "Oracle proposes date and scope changes with evidence; a person decides.",
  );
});

// protects=an owner sets Watch the roadmap to Observe with a reason, and the slipped item's card on
// the Plan then only flags the slip (Keep watching), with no Accept new date or Re-plan; fails_when=
// Observe still offers Oracle's fixes; no_claim=the accept-date write (track-alerts.spec.ts).
test("autonomy: at Observe a date slip only flags, with no fixes offered", async ({ page }) => {
  await page.addInitScript((key) => localStorage.setItem(key, "track-alerts"), MOCK_SCENARIO_KEY);
  await login(page);
  await openAutonomy(page);
  await step(page, "roadmap_watch", "Observe").click();
  const sheet = page.getByRole("dialog", { name: "Change Watch the roadmap" });
  await expect(sheet.getByTestId("autonomy-to")).toContainText("Oracle watches tracks every hour and flags drift.");
  await sheet.getByLabel("Why").fill("We review slips in the weekly meeting");
  await sheet.getByRole("button", { name: "Save" }).click();
  await expect(sheet).toBeHidden();
  await expect(step(page, "roadmap_watch", "Observe")).toHaveAttribute("aria-pressed", "true");

  await rail(page).getByRole("link", { name: "Plan", exact: true }).click();
  await expect(page).toHaveURL(/\/plan$/);
  const planRow = page.locator('[data-testid="plan-row"][data-item="alert-digest"]').filter({ visible: true });
  await planRow.getByTestId("plan-title").click();
  const card = page.getByTestId("plan-inspector").filter({ visible: true }).getByTestId("plan-alert");
  await expect(card).toHaveCount(1);
  await expect(card.getByTestId("plan-alert-detail")).toHaveText("ENG-405 moved to Dec 9; Beta rests on Nov 30");
  await expect(card.getByRole("button", { name: "Keep watching" })).toBeVisible();
  await expect(card.getByRole("button", { name: "Accept new date" })).toHaveCount(0);
  await expect(card.getByRole("button", { name: "Re-plan" })).toHaveCount(0);
});
