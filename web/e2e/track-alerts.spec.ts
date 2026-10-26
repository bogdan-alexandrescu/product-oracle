import { expect, test, type Page } from "./test";

import { MOCK_ROLE_KEY, MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";

/*
 * F2 Track health in Plan and Inbox, driven through the UI on the mock layer
 * (NEXT_PUBLIC_API_MOCKS=1). The "track-alerts" scenario (lib/api/mock/roadmap.ts) seeds one
 * open date slip on the Usage alerts track: ENG-405, the tracker issue of "Daily alert digest
 * email", moved to Dec 9 while Beta rests on Nov 30. The mock stands in for the API's alert
 * rules (proven by api/tests/test_track_alerts.py); each test here proves what a person sees
 * and does on the screen.
 */

const ITEM = "Daily alert digest email";
const LABEL = "Usage alerts PRD · At risk · 1 need you";

async function withSlip(page: Page, role?: "viewer" | "approver") {
  await page.addInitScript((key) => localStorage.setItem(key, "track-alerts"), MOCK_SCENARIO_KEY);
  if (role) await page.addInitScript(([key, r]) => localStorage.setItem(key, r), [MOCK_ROLE_KEY, role] as const);
}

const rail = (page: Page) => page.getByRole("navigation", { name: "Oracle" });
const badge = (page: Page) => page.getByTestId("nav-inbox-badge");
const trackRow = (page: Page) => page.locator('[data-need="Track"]').filter({ visible: true }).filter({ has: page.getByTestId("track-label") });
const alertRows = (page: Page) => page.locator('[data-need="Track alert"]').filter({ visible: true });
const slipRow = (page: Page) => alertRows(page).filter({ hasText: ITEM });

async function openInbox(page: Page) {
  await rail(page).getByTestId("nav-inbox").click();
  await expect(page).toHaveURL(/\/inbox$/);
}

async function openPlan(page: Page) {
  await rail(page).getByRole("link", { name: "Plan", exact: true }).click();
  await expect(page).toHaveURL(/\/plan$/);
  await expect(page.getByTestId("plan-row").filter({ visible: true }).first()).toBeVisible();
}

const planRow = (page: Page) => page.locator('[data-testid="plan-row"][data-item="alert-digest"]').filter({ visible: true });

async function selectSlip(page: Page) {
  await planRow(page).getByTestId("plan-title").click();
  await expect(page.getByTestId("plan-inspector").filter({ visible: true })).toContainText(ITEM);
}

const card = (page: Page) => page.getByTestId("plan-inspector").filter({ visible: true }).getByTestId("plan-alert");

const badgeCount = async (page: Page) => Number((await badge(page).innerText()).replace(/\D+/g, "") || "0");

// protects = an owner's Inbox has one "Track" row for the slipping track, saying how many alerts
// need them, with the slip under it offering Accept new date, and the rail badge counts the
// alert; fails_when = no Track row, the wrong count or health word, no child row or no Accept
// new date, or the badge is the same as without the slip; no_claim = which alerts the API
// opens (api/tests/test_track_alerts.py) or the audience rules for approvers and leads.
test("an owner's Inbox shows the Track row with the slip and Accept new date; the badge counts it", async ({ page, browser }) => {
  // The same company without the slip: the badge's baseline.
  const plain = await browser.newPage();
  await login(plain);
  await expect(badge(plain)).toBeVisible();
  const without = await badgeCount(plain);
  await plain.close();

  await withSlip(page);
  await login(page);
  await expect(badge(page)).toHaveText(String(without + 1));
  await openInbox(page);
  await expect(trackRow(page).getByTestId("track-label")).toHaveText(LABEL);
  await expect(trackRow(page).getByRole("link", { name: "Open Usage alerts PRD in Plan" })).toBeVisible();
  await expect(alertRows(page)).toHaveCount(1);
  await expect(slipRow(page).getByTestId("track-alert-detail")).toHaveText("ENG-405 moved to Dec 9; Beta rests on Nov 30");
  await expect(slipRow(page).getByRole("button", { name: `Accept new date for ${ITEM}` })).toBeVisible();
  await expect(slipRow(page).getByRole("link", { name: `Open ${ITEM}` })).toBeVisible();
});

// protects = Accept new date in the Inbox takes the tracker's date in one click: the child row
// (and its now empty Track row) leaves, the badge drops by one, and the Plan row's Engineering
// cell reads the new verified date; fails_when = the row stays, the badge does not move, or the
// Plan still reads "slipped 9 d"; no_claim = the basis, withdrawal and milestone writes of the
// API's transaction (pytest).
test("Accept new date removes the child row and the Plan reads ENG-405 · Dec 9 ✓", async ({ page }) => {
  await withSlip(page);
  await login(page);
  await openPlan(page);
  await expect(planRow(page).getByTestId("plan-engineering")).toHaveText("ENG-405 · slipped 9 d");
  await openInbox(page);
  await expect(slipRow(page)).toBeVisible();
  const before = await badgeCount(page);
  await slipRow(page).getByRole("button", { name: `Accept new date for ${ITEM}` }).click();
  await expect(alertRows(page)).toHaveCount(0);
  await expect(trackRow(page)).toHaveCount(0);
  await expect(badge(page)).toHaveText(String(before - 1));
  await openPlan(page);
  await expect(planRow(page).getByTestId("plan-engineering")).toHaveText("ENG-405 · Dec 9 ✓");
});

// protects = Keep watching asks for an optional note in place, and the kept alert moves to the
// Done tab showing that note; fails_when = no note field, the row stays under New, or Done
// does not show "Kept · <note>"; no_claim = the alert re-opening when its facts change (API).
test("Keep watching with a note moves the alert to Done, showing the note", async ({ page }) => {
  await withSlip(page);
  await login(page);
  await openInbox(page);
  await slipRow(page).getByRole("button", { name: `Keep watching ${ITEM}` }).click();
  const field = page.getByTestId("track-keep-field").filter({ visible: true });
  await field.getByLabel("Note (optional)").fill("Engineering says Dec 9 holds");
  await field.getByRole("button", { name: "Keep watching" }).click();
  await expect(alertRows(page)).toHaveCount(0);
  await expect(trackRow(page)).toHaveCount(0);
  await page.getByTestId("inbox-state-tabs").getByRole("tab", { name: /^Done/ }).click();
  const done = page.getByTestId("inbox-tracks").locator('[data-need="Track"]').filter({ visible: true });
  await expect(done).toHaveCount(1);
  await expect(done.getByTestId("track-alert-outcome")).toHaveText("Kept · Engineering says Dec 9 holds");
});

// protects = the Plan's inspector for the slipped item shows the slip card in one sentence with
// Accept new date, Re-plan and Keep watching for an owner (reached from the Inbox's Open in
// Plan), and the same card with no buttons for a viewer; fails_when = no card, the wrong date
// words, a missing action, or a viewer offered a button the API refuses; no_claim = the other
// alert kinds' cards.
test("the slipped item's inspector shows the slip card with its actions; a viewer sees no buttons", async ({ page, browser }) => {
  await withSlip(page);
  await login(page);
  await openInbox(page);
  await trackRow(page).getByRole("link", { name: "Open Usage alerts PRD in Plan" }).click();
  await expect(page).toHaveURL(/\/plan\?item=alert-digest$/);
  await expect(card(page)).toHaveCount(1);
  await expect(card(page).getByTestId("plan-alert-detail")).toContainText("moved to Dec 9");
  await expect(card(page).getByTestId("plan-alert-detail")).toHaveText("ENG-405 moved to Dec 9; Beta rests on Nov 30");
  for (const name of ["Accept new date", "Re-plan", "Keep watching"]) {
    await expect(card(page).getByRole("button", { name })).toBeVisible();
  }

  const viewer = await browser.newPage();
  await withSlip(viewer, "viewer");
  await login(viewer);
  await openPlan(viewer);
  await selectSlip(viewer);
  await expect(card(viewer)).toHaveCount(1);
  await expect(card(viewer).getByTestId("plan-alert-detail")).toContainText("moved to Dec 9");
  await expect(card(viewer).getByRole("button")).toHaveCount(0);
  await viewer.close();
});

// protects = #618 review: Keep watching and Reopen are the alert's audience's (the track's
// owner, else every owner; the engineering leads for slips), so an approver on an unowned
// track sees the slip's other actions but neither of them, and the owner keeps and reopens;
// fails_when = the approver is offered Keep watching (which the API refuses with 403), or the
// owner loses Keep watching or Reopen; no_claim = the API's audience (test_track_alerts.py).
test("an approver outside the alert's audience is not offered Keep watching; the owner keeps and reopens", async ({ page, browser }) => {
  const approver = await browser.newPage();
  await withSlip(approver, "approver");
  await login(approver);
  await openPlan(approver);
  await selectSlip(approver);
  await expect(card(approver).getByRole("button", { name: "Re-plan" })).toBeVisible();
  await expect(card(approver).getByRole("button", { name: "Keep watching" })).toHaveCount(0);
  await expect(card(approver).getByRole("button", { name: "Reopen" })).toHaveCount(0);
  await approver.close();

  await withSlip(page);
  await login(page);
  await openPlan(page);
  await selectSlip(page);
  await card(page).getByRole("button", { name: "Keep watching" }).click();
  await card(page).getByRole("button", { name: "Keep watching" }).click();
  await expect(card(page).getByTestId("plan-alert-kept")).toBeVisible();
  await card(page).getByRole("button", { name: "Reopen" }).click();
  await expect(card(page).getByRole("button", { name: "Keep watching" })).toBeVisible();
});

// protects = Re-plan on the slip card drafts a roadmap run from the track and opens it, in
// Draft; fails_when = nothing happens, an error shows, or the run opens in another state;
// no_claim = the run's estimate and cost gates (runs specs).
test("Re-plan opens a draft roadmap run for the track", async ({ page }) => {
  await withSlip(page);
  await login(page);
  await openPlan(page);
  await selectSlip(page);
  await card(page).getByRole("button", { name: "Re-plan" }).click();
  await expect(page).toHaveURL(/\/runs\/[0-9a-f-]+$/);
  await expect(page.getByTestId("run-status").filter({ visible: true }).first()).toHaveText("Draft");
});

// protects = at 390 px the Track row and its child row render as cards, their actions usable,
// and nothing scrolls sideways; fails_when = horizontal scroll, a hidden child row or action;
// no_claim = other widths.
test("on a phone the Track row and its alert are cards with no horizontal scroll", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await withSlip(page);
  await login(page);
  await page.goto("/inbox");
  await expect(trackRow(page).getByTestId("track-label")).toHaveText(LABEL);
  await expect(slipRow(page)).toBeVisible();
  const accept = slipRow(page).getByRole("button", { name: `Accept new date for ${ITEM}` });
  await expect(accept).toBeVisible();
  const row = await slipRow(page).boundingBox();
  const button = await accept.boundingBox();
  expect(button!.width).toBeGreaterThan(row!.width * 0.6);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
