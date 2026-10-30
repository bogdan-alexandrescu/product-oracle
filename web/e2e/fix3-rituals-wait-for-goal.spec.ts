import { expect, test, type Page } from "./test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";

import { login } from "./helpers";

/*
 * Built-in rituals start paused until the first confirmed goal (owner decision 2026-10-29,
 * "Start paused until goals"), on the mock layer's "empty" scenario (a new company with no
 * goal): Company › Rituals says why the Weekly goals check-in is paused; a goal added and
 * confirmed on Baseline turns it on, while the Investor update (off by default) stays paused.
 */

const PHONE = { width: 390, height: 844 };
const WHY = "Starts when the first goal is confirmed";

test.use({ timezoneId: "America/Los_Angeles", locale: "en-US" });

const ritualRow = (page: Page, title: string) => page.getByTestId("ritual-row").filter({ hasText: title });

async function openRituals(page: Page) {
  await page.addInitScript((key) => localStorage.setItem(key, "empty"), MOCK_SCENARIO_KEY);
  await login(page);
  await page.goto("/company/rituals");
  await expect(ritualRow(page, "Weekly goals check-in")).toBeVisible();
}

async function confirmAGoal(page: Page) {
  await page.goto("/baseline");
  await page.getByRole("region", { name: "Goals", exact: true }).getByRole("button", { name: "Add", exact: true }).click();
  const form = page.getByRole("dialog", { name: "Add an item" });
  await form.getByLabel("Title").fill("Halve support tickets");
  await form.getByRole("button", { name: "Add", exact: true }).click();
  await page.getByRole("grid", { name: "Goals" }).getByRole("button", { name: "Halve support tickets" }).click();
  const d = page.getByRole("dialog", { name: "Halve support tickets" });
  await d.getByRole("button", { name: "Confirm" }).click();
  await expect(d.getByRole("status").filter({ hasText: "Confirmed" })).toBeVisible();
}

for (const phone of [false, true]) {
  test(`fix3-rituals: a new company's built-ins wait paused for the first goal, and confirming one turns them on${phone ? " (phone)" : ""}`, async ({ page }) => {
    // protects=the owner's "Start paused until goals"; fails_when=the built-ins start on, the
    // paused one does not say why, or the confirmed goal leaves it paused (or turns on one a
    // default leaves off); no_claim=the API's tick (api/tests/test_rituals_wait_for_goal.py).
    if (phone) await page.setViewportSize(PHONE);
    await openRituals(page);
    const checkin = ritualRow(page, "Weekly goals check-in");
    await expect(checkin).toContainText("Paused");
    await expect(checkin.getByTestId("ritual-waits")).toHaveText(WHY);
    await expect(checkin).not.toContainText("Next");
    // Off by default: paused, with no reason about goals.
    const investor = ritualRow(page, "Investor update");
    await expect(investor).toContainText("Paused");
    await expect(investor.getByTestId("ritual-waits")).toHaveCount(0);
    // Nothing of it in the Inbox while it waits.
    await page.goto("/inbox");
    await expect(page.getByText("Weekly goals check-in")).toHaveCount(0);

    await confirmAGoal(page);
    await page.goto("/company/rituals");
    await expect(checkin).toContainText("On");
    await expect(checkin).toContainText("Next");
    await expect(checkin.getByTestId("ritual-waits")).toHaveCount(0);
    await expect(investor).toContainText("Paused");
  });
}
