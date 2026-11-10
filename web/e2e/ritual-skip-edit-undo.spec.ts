import { expect, test, type Page } from "./test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";

import { login } from "./helpers";

/*
 * Company › Rituals › an occurrence, skipped by mistake: the ritual's owner edits the reason
 * in place, then undoes the skip and marks it held. On the mock layer's "rituals" scenario
 * (seeded on Fri Oct 23; its Monthly roadmap refresh ends Tue Nov 3 11:00 UTC), a day after
 * that end.
 */

test.use({ timezoneId: "America/New_York", locale: "en-US" });

async function openTheEndedRefresh(page: Page) {
  await page.clock.install({ time: new Date("2026-10-23T12:00:00Z") });
  await page.addInitScript((key) => localStorage.setItem(key, "rituals"), MOCK_SCENARIO_KEY);
  await login(page);
  await page.goto("/inbox");
  await page.clock.setSystemTime(new Date("2026-11-04T12:00:00Z"));
  await page.goto("/inbox");
  await page.getByTestId("inbox-state-tabs").getByRole("tab", { name: /^Seen/ }).click();
  const row = page.getByTestId("inbox-rituals").locator("tr[data-row]").filter({ hasText: "Record notes · Monthly roadmap refresh" });
  await row.getByRole("link", { name: "Open" }).click();
  await expect(page).toHaveURL(/\/company\/rituals\/[0-9a-f-]{36}$/);
}

test("the owner edits a skip's reason, then undoes the skip and marks the meeting held", async ({ page }) => {
  // protects=a skipped occurrence's reason is editable and the skip can be undone;
  // fails_when=the reason cannot be changed, Cancel saves, or the skip stays for good;
  // no_claim=the audit row (test_rituals.py).
  await openTheEndedRefresh(page);
  await page.getByRole("button", { name: "Skip", exact: true }).click();
  await page.getByLabel("Why it was skipped").fill("Team ofsite");
  await page.getByRole("button", { name: "Skip with this reason" }).click();
  const recorded = page.getByTestId("occurrence-notes");
  await expect(page.getByTestId("occurrence-state")).toHaveText("Skipped");
  await expect(recorded).toContainText("Team ofsite");

  await recorded.getByRole("button", { name: "Edit" }).click();
  await recorded.getByLabel("Why it was skipped").fill("Something else");
  await recorded.getByRole("button", { name: "Cancel" }).click();
  await expect(recorded).toContainText("Team ofsite");

  await recorded.getByRole("button", { name: "Edit" }).click();
  await expect(recorded.getByLabel("Why it was skipped")).toHaveValue("Team ofsite");
  await recorded.getByLabel("Why it was skipped").fill("Team offsite");
  await recorded.getByRole("button", { name: "Save" }).click();
  await expect(recorded).toContainText("Team offsite");
  await expect(recorded.getByRole("button", { name: "Save" })).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId("occurrence-notes")).toContainText("Team offsite");

  await page.getByTestId("occurrence-notes").getByRole("button", { name: "Undo skip" }).click();
  await expect(page.getByTestId("occurrence-state")).toHaveText("Ready");
  await expect(page.getByTestId("occurrence-notes")).toHaveCount(0);
  await page.getByLabel("Notes").fill("Held after all; agreed the new dates.");
  await page.getByRole("button", { name: "Mark held" }).click();
  await expect(page.getByTestId("occurrence-state")).toHaveText("Held");
  await expect(page.getByTestId("occurrence-notes")).toContainText("Held after all; agreed the new dates.");
});
