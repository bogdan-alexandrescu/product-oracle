import { expect, test, type Page } from "./test";

import { MOCK_ROLE_KEY } from "../lib/api/mock/server";
import { THEME_KEY } from "../lib/theme";
import { login } from "./helpers";

/*
 * #339: a PRD's track and its milestones on the Plan, driven through the UI on the mock
 * layer (NEXT_PUBLIC_API_MOCKS=1). The mock's track routes (lib/api/mock/roadmap.ts) mirror
 * the API's (api/oracle/roadmap/router.py; its rules are proven by the API's own tests): the
 * seeded Usage alerts PRD track, its undated "First release" milestone, a verified basis
 * (ENG-412) for 2026-11-30, and two-way tracker sync off. Each test proves what a person
 * sees and does on the screen.
 */

async function asRole(page: Page, role: "viewer" | "commenter" | "approver") {
  await page.addInitScript(([key, r]) => localStorage.setItem(key, r), [
    MOCK_ROLE_KEY,
    role,
  ] as const);
}

const track = (page: Page) =>
  page
    .getByTestId("plan-track")
    .filter({ visible: true })
    .filter({ hasText: "Usage alerts" });
const editor = (page: Page) =>
  page.getByTestId("plan-milestone").filter({ visible: true });

async function openPlan(page: Page) {
  await login(page);
  await page
    .getByRole("navigation", { name: "Oracle" })
    .getByRole("link", { name: "Plan", exact: true })
    .click();
  await expect(page).toHaveURL(/\/plan$/);
  await expect(track(page)).toBeVisible();
}

// protects = the track's title, owner and status change in place and stay changed;
// fails_when = an edit is not sent, or the panel shows the old value; no_claim = the API's
// owner checks (api/tests).
test("a track's title, owner and status are edited in place", async ({
  page,
}) => {
  await openPlan(page);
  const t = track(page);
  await expect(t.getByTestId("track-owner")).toHaveText("not set");
  await expect(t.getByTestId("track-health")).toHaveText("At risk");

  await t.getByRole("button", { name: "Rename" }).click();
  await t.getByLabel("Track title").fill("Usage alerts launch");
  await t.getByRole("button", { name: "Save" }).click();
  await expect(t.getByTestId("track-title")).toHaveText("Usage alerts launch");

  await t.getByRole("button", { name: "Set owner" }).click();
  await t.getByLabel("Find a person").fill("approver");
  await t.getByRole("option", { name: /approver@example\.com/ }).click();
  await expect(t.getByTestId("track-owner")).toContainText(
    "approver@example.com",
  );

  await t
    .getByRole("group", { name: "Track status" })
    .getByRole("button", { name: "Paused" })
    .click();
  await expect(t.getByTestId("track-health")).toHaveText("Paused");
  await t
    .getByRole("group", { name: "Track status" })
    .getByRole("button", { name: "Active" })
    .click();
  await expect(t.getByTestId("track-health")).toHaveText("At risk");

  await page.reload();
  await expect(track(page).getByTestId("track-title")).toHaveText(
    "Usage alerts launch",
  );
  await expect(track(page).getByTestId("track-owner")).toContainText(
    "approver@example.com",
  );
});

// protects = the milestone editor in the inspector: name, horizon, date with its verified
// basis, items and status; titles read "M1 · Oct 19 – Nov 30"; a date with no basis is refused
// with the API's reason; fails_when = a date is saved without a basis, or the title has no dates.
test("milestones are added and edited in the inspector, with dated titles", async ({
  page,
}) => {
  await openPlan(page);
  const t = track(page);
  const m1 = t
    .getByTestId("track-milestone")
    .filter({ hasText: "First release" });
  await expect(m1.getByTestId("milestone-title")).toHaveText("M1 · Oct 19 – Nov 30");

  await m1.click();
  const e = editor(page);
  await expect(e).toContainText("Milestone");
  await expect(e).not.toContainText("· selected");
  await expect(e.getByLabel("Name")).toHaveValue("First release");
  // A date with no verified basis that supports it is refused, with the reason.
  await e.getByLabel("Date").fill("2026-12-01");
  await expect(e.getByTestId("milestone-no-basis")).toBeVisible();
  await e.getByRole("button", { name: "Save milestone" }).click();
  await expect(e.getByRole("alert")).toContainText("never invents dates");
  // The date ENG-412 supports: the basis is offered and saved with it.
  await e.getByLabel("Date").fill("2026-11-30");
  await expect(e.getByRole("checkbox", { name: /ENG-412/ })).toBeChecked();
  const items = e.getByRole("group", { name: "Items" }).getByRole("checkbox");
  await expect(items.first()).toBeVisible();
  await items.first().uncheck();
  await e.getByRole("button", { name: "Save milestone" }).click();
  await expect(m1.getByTestId("milestone-title")).toHaveText(
    "M1 · Oct 19 – Nov 30",
  );

  // Add a second milestone in Next, then mark it done.
  await t.getByRole("button", { name: "Add milestone" }).click();
  await expect(editor(page)).toContainText("New milestone");
  await editor(page).getByLabel("Name").fill("Weekly digest");
  await editor(page)
    .getByRole("group", { name: "Horizon" })
    .getByRole("button", { name: "Next" })
    .click();
  await editor(page).getByRole("button", { name: "Add milestone" }).click();
  const m2 = t
    .getByTestId("track-milestone")
    .filter({ hasText: "Weekly digest" });
  await expect(m2.getByTestId("milestone-title")).toHaveText("M2 · no date");
  await expect(editor(page).getByLabel("Name")).toHaveValue("Weekly digest");
  await editor(page)
    .getByRole("group", { name: "Milestone status" })
    .getByRole("button", { name: "Done" })
    .click();
  await editor(page).getByRole("button", { name: "Save milestone" }).click();
  await expect(m2.getByTestId("milestone-status")).toHaveText("Done");
});

// protects = Check now and Draft roadmap from this track each work from the panel, and Push to
// tracker is disabled with the reason while two-way sync is off; fails_when = a click does
// nothing or the push is offered while sync is off; no_claim = what the run then drafts (runs specs).
test("check now, push to tracker and draft a roadmap from the track", async ({
  page,
}) => {
  await openPlan(page);
  const t = track(page);
  await t.getByRole("button", { name: "Check now" }).click();
  await expect(t.getByTestId("track-result")).toContainText("Now at risk");
  // qa-plan-8: with two-way sync off, Push to tracker is disabled and says why.
  await expect(t.getByRole("button", { name: "Push to tracker" })).toBeDisabled();
  await expect(
    t.getByRole("button", { name: "Push to tracker" }),
  ).toHaveAccessibleDescription(/Two-way tracker sync is off/);
  await t
    .getByRole("button", { name: "Draft roadmap from this track" })
    .click();
  await expect(page).toHaveURL(/\/runs\/[0-9a-f-]+$/);
});

// protects = #370 (#505): viewers see no track control, since they can never change a track,
// and a milestone reads read only; fails_when = a viewer is offered a control the API refuses.
test("viewers see no track controls", async ({
  page,
}) => {
  await asRole(page, "viewer");
  await openPlan(page);
  const t = track(page);
  await expect(t.getByTestId("track-owner")).toBeVisible();
  for (const name of [
    "Rename",
    "Change owner",
    "Set owner",
    "Add milestone",
    "Check now",
    "Draft roadmap from this track",
    "Push to tracker",
  ]) {
    await expect(t.getByRole("button", { name })).toHaveCount(0);
  }
  // A milestone opens read only: no fields, no Save, no role note (#370).
  await t.getByTestId("track-milestone").first().click();
  await expect(editor(page).getByTestId("milestone-name")).toBeVisible();
  await expect(
    editor(page).getByRole("button", { name: "Save milestone" }),
  ).toHaveCount(0);
  await expect(editor(page).getByRole("textbox")).toHaveCount(0);
  await expect(editor(page)).not.toContainText("needs the approver role");
});

// protects = on a phone (390 px, dark theme) the track panel fits and a milestone opens in a
// sheet; fails_when = the panel overflows the screen or the editor cannot be reached.
test("phone: the track panel fits and a milestone opens in a sheet", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(
    (key) => localStorage.setItem(key, "dark"),
    THEME_KEY,
  );
  await openPlan(page);
  const box = await track(page).boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  // Nothing inside the panel is wider than the panel.
  expect(
    await track(page).evaluate((el) => el.scrollWidth - el.clientWidth),
  ).toBeLessThanOrEqual(0);
  await track(page).getByTestId("track-milestone").first().click();
  const sheet = page.getByTestId("sheet-plan-milestone");
  await expect(sheet).toBeVisible();
  await expect(sheet.getByLabel("Name")).toHaveValue("First release");
});
