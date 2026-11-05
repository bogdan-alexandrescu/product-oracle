import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { OLD_MILESTONES_SCENARIO } from "../lib/api/mock/one-roadmap";
import { login } from "./helpers";
import { expect, test, type Page } from "./test";

/*
 * old-milestones (the owner, Nov 4: "Move them over"): goal milestones still on the older
 * Trust plan roadmap (history beside the company roadmap) are brought onto the company
 * roadmap by an owner from Key dates: "Bring old milestones over" shows what moves first,
 * runs once, and the milestones show on the timeline and in Key dates; one whose items are
 * all gone asks Keep or Drop (in Key dates and in Needs a decision, in its count), and the
 * action is gone once nothing is left. Mock scenario "old-milestones" (invented data).
 */

async function open(page: Page, email?: string) {
  await page.addInitScript(([k, v]) => localStorage.setItem(k, v), [MOCK_SCENARIO_KEY, OLD_MILESTONES_SCENARIO] as const);
  await login(page, email);
  await page.goto("/simple/roadmap");
  await expect(page.getByTestId("simple-roadmap")).toBeVisible();
}

const keyDates = async (page: Page) => {
  await page.getByTestId("key-dates-open").click();
  const editor = page.getByTestId("key-dates-editor");
  await expect(editor).toBeVisible();
  return editor;
};

test("an owner brings old milestones over from Key dates, then keeps or drops the ones with no items left", async ({ page }) => {
  await open(page);
  // Needs a decision counts the one with no items left before anything runs.
  await expect(page.getByTestId("needs-decision")).toContainText("1");
  let editor = await keyDates(page);
  const preview = editor.getByTestId("old-milestones-preview");
  await expect(preview).toContainText("2 milestones from older roadmaps will move to the company roadmap");
  const safety = preview.getByTestId("old-milestone-move").filter({ hasText: "Safety tools in beta" });
  await expect(safety).toContainText("Nov 27 · Grow retention");
  await expect(safety).toContainText("From Trust plan roadmap");
  await expect(safety).toContainText("Waits on Report button on every post, Block list");
  // Only the item still on the company roadmap moves with it.
  await expect(preview.getByTestId("old-milestone-move").filter({ hasText: "Ready for twice the load" })).toContainText("Waits on Read replicas in two regions");
  await expect(preview).toContainText("1 needs your call: none of their items are left.");
  const ask = editor.getByTestId("old-milestone-ask");
  await expect(ask).toHaveCount(1);
  await expect(ask).toContainText("Seller badge pilot");
  await expect(ask).toContainText("Old milestone with no items left: Keep or Drop");
  // Nothing has moved yet: not on the timeline.
  await expect(page.locator('[data-testid="ms-diamond"][title*="Safety tools in beta"]')).toHaveCount(0);

  await editor.getByRole("button", { name: "Bring old milestones over" }).click();
  await expect(page.getByText("Brought 2 old milestones over")).toBeVisible();
  await expect(editor.getByTestId("old-milestones-preview")).toHaveCount(0);
  await expect(editor.getByRole("button", { name: "Bring old milestones over" })).toHaveCount(0);
  await expect(editor.getByTestId("key-date-milestone").filter({ hasText: "Safety tools in beta" })).toContainText("Milestone brought over from Trust plan roadmap");
  await expect(editor.getByTestId("key-date-milestone").filter({ hasText: "Ready for twice the load" })).toContainText("Dec 11");
  await expect(editor.getByTestId("old-milestone-ask")).toHaveCount(1);
  await editor.getByRole("button", { name: "Close" }).click();
  await expect(page.locator('[data-testid="ms-diamond"][title*="Safety tools in beta"]')).toHaveCount(1);
  await expect(page.locator('[data-testid="ms-diamond"][title*="Ready for twice the load"]')).toHaveCount(1);

  // The no-items one in Needs a decision: Keep puts it on the company roadmap, gone from the list and every count.
  await expect(page.getByTestId("needs-decision")).toContainText("1");
  await page.getByTestId("needs-decision").click();
  const tray = page.getByTestId("decision-tray");
  await expect(tray.getByTestId("tray-counter").filter({ hasText: "Old milestones" })).toContainText("1");
  await tray.getByRole("button", { name: "Keep Seller badge pilot" }).click();
  await expect(page.getByText("Kept 'Seller badge pilot' on the company roadmap")).toBeVisible();
  await expect(tray.getByTestId("tray-old-milestones")).toHaveCount(0);
  await expect(tray.getByTestId("tray-counter").filter({ hasText: "Old milestones" })).toHaveCount(0);
  await expect(page.getByTestId("needs-decision")).toContainText("0");
  await tray.getByRole("button", { name: "Close" }).click();
  await expect(page.locator('[data-testid="ms-diamond"][title*="Seller badge pilot"]')).toHaveCount(1);

  // Nothing left to bring: Key dates has no old milestones part at all.
  editor = await keyDates(page);
  await expect(editor.getByTestId("old-milestones")).toHaveCount(0);
  await expect(editor.getByTestId("key-date-milestone").filter({ hasText: "Seller badge pilot" })).toContainText("Nov 20");
});

test("Drop leaves an old milestone with no items left behind", async ({ page }) => {
  await open(page);
  const editor = await keyDates(page);
  await editor.getByRole("button", { name: "Drop Seller badge pilot" }).click();
  await expect(page.getByText("Dropped 'Seller badge pilot'")).toBeVisible();
  await expect(editor.getByTestId("old-milestone-ask")).toHaveCount(0);
  // The two with items still wait to be brought over.
  await expect(editor.getByTestId("old-milestones-preview")).toContainText("2 milestones");
  await expect(editor.getByTestId("old-milestones-preview")).not.toContainText("your call");
  await editor.getByRole("button", { name: "Close" }).click();
  await expect(page.getByTestId("needs-decision")).toContainText("0");
  await expect(page.locator('[data-testid="ms-diamond"][title*="Seller badge pilot"]')).toHaveCount(0);
});

test("an approver sees nothing to bring over or decide", async ({ page }) => {
  await open(page, "approver@example.com");
  const editor = await keyDates(page);
  await expect(editor.getByTestId("old-milestones")).toHaveCount(0);
  await expect(editor.getByRole("button", { name: "Bring old milestones over" })).toHaveCount(0);
});
