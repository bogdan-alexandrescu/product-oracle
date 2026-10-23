import { expect, type Page, test } from "@playwright/test";

import { SOURCES_STORAGE_KEY } from "../lib/api/mock/sources";
import { login } from "./helpers";

/**
 * #401: every date and time a person sees is in the Company time zone (Settings ›
 * Company), not UTC. Auckland is far from UTC, so a meeting at 14:00 UTC on Oct 13 is
 * 03:00 on Oct 14 there. Driven through the UI on the mock layer.
 */

async function setZone(page: Page, zone: string) {
  await page.goto("/settings/company");
  await page.getByLabel("Company time zone").selectOption(zone);
  await page.getByTestId("timezone-panel").getByRole("button", { name: "Save" }).click();
  await expect(page.getByTestId("timezone-panel").getByRole("status")).toHaveText("Saved");
}

// protects: the Fireflies picker shows meeting days and times in the Company time zone,
// labelled with it, its From/To are whole days there, and the source saves the days the
// person picked with the zone they are in.
// fails_when: the picker still says UTC, groups a meeting under its UTC day or time, or
// the saved days shift.
// no_claim: the API's reading of the saved days (pytest).
test("Fireflies picker: meeting days, times and From/To in the Company time zone", async ({ page }) => {
  await login(page);
  await setZone(page, "Pacific/Auckland");
  await page.goto("/settings/sources");
  const form = page.getByRole("form", { name: "Add a source" });
  await form.getByLabel("Kind").selectOption("fireflies");
  await expect(form.getByLabel("Connection")).toHaveValue(/.+/);
  const picker = form.getByTestId("fireflies-picker");
  const zone = picker.getByTestId("fireflies-timezone");
  await expect(zone).toContainText("Pacific/Auckland");
  await expect(zone).not.toContainText("UTC");

  await picker.getByRole("button", { name: "Choose" }).click();
  const meetings = picker.getByRole("group", { name: "Meetings" });
  await picker.getByLabel("Search meetings").fill("sprint planning #14");
  // 14:00 UTC on Tue Oct 13 is 03:00 on Wed Oct 14 in Auckland.
  const day = meetings.getByRole("group", { name: "Wed, Oct 14" });
  await expect(day).toContainText("AI agents sprint planning #14");
  await expect(day).toContainText("03:00");
  await expect(meetings.getByRole("group", { name: "Tue, Oct 13" })).toHaveCount(0);

  // Oct 14 in Auckland: the sprint planning is in, the Oct 13 standup (22:00 there) is not.
  await picker.getByLabel("Search meetings").fill("");
  await picker.getByLabel("From").fill("2026-10-14");
  await picker.getByLabel("Ongoing").uncheck();
  await picker.getByLabel("To", { exact: true }).fill("2026-10-14");
  await expect(meetings.getByRole("group", { name: "Wed, Oct 14" })).toContainText("AI agents sprint planning #14");
  await expect(meetings.getByRole("group", { name: "Tue, Oct 13" })).toHaveCount(0);
  await meetings.getByLabel("AI agents sprint planning #14").check();
  await expect(picker.getByTestId("fireflies-summary")).toHaveText("1 meeting, Oct 14 – Oct 14");

  await form.getByLabel("Name").fill("Planning calls");
  await form.getByRole("button", { name: "Add source" }).click();
  const row = page.getByRole("listitem", { name: "Planning calls" });
  await expect(row.getByTestId("fireflies-included")).toContainText("Oct 14 – Oct 14");
  // What the API receives: the days picked, and the zone they are days in.
  const config = await page.evaluate((key) => {
    const db = JSON.parse(localStorage.getItem(key) ?? "{}");
    return (db.sources ?? []).find((s: { name: string }) => s.name === "Planning calls")?.config;
  }, SOURCES_STORAGE_KEY);
  expect(config).toMatchObject({ date_from: "2026-10-14", date_to: "2026-10-14", timezone: "Pacific/Auckland" });
});

// protects: the blocker inspector shows its history times and an experiment's decision
// gate in the Company time zone, with the zone's short name beside a time.
// fails_when: history times are UTC or unlabelled, or the gate shows another day than
// the one picked.
// no_claim: the other screens #401 lists (they share the formatter).
test("blocker inspector: history and decision gate in the Company time zone", async ({ page }) => {
  await login(page);
  await setZone(page, "Pacific/Auckland");
  await page.goto("/baseline?tab=blockers");
  await page.getByTestId("blocker-row").filter({ hasText: "Same-day refund rule unanswered" }).click();
  const insp = page.getByTestId("blocker-inspector");
  await insp.getByRole("button", { name: "Plan experiment" }).click();
  const plan = insp.getByRole("form", { name: "Plan experiment" });
  await plan.getByLabel("Hypothesis").fill("Refunds settle the same day in the sandbox");
  await plan.getByLabel("Decision gate").fill("2027-03-10");
  await plan.getByRole("button", { name: "Plan" }).click();
  const x = insp.getByTestId("experiment").filter({ hasText: "Refunds settle the same day in the sandbox" });
  await expect(x).toContainText("Mar 10");

  const form = insp.getByRole("form", { name: "Change status" });
  await form.getByLabel("Status", { exact: true }).selectOption("resolved");
  await form.getByLabel("Reason").fill("The processor confirmed same-day refunds in writing");
  await form.getByRole("button", { name: "Set status" }).click();
  const history = insp.getByRole("list", { name: "History" });
  await expect(history).toContainText("Status changed from open to resolved");
  // Auckland is GMT+12, or GMT+13 in its summer.
  await expect(history).toContainText(/GMT\+1[23]/);
});
