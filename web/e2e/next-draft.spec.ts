import { expect, test, type Page } from "@playwright/test";

import { login, openSection, showAll } from "./helpers";

/**
 * C1e: accepting a suggestion stages it; "Build draft N+1" builds every staged change in
 * one job, shows one combined preview and applies it as exactly one version; the Inbox
 * shows feedback by state in tabs, New first.
 *
 * Fixture: Clinic outreach PRD (Galatia-like) on draft 5, with Goal trace (raised on v4)
 * and F-38 Outbound check (v5) staged, one declined with a note, one open with a
 * suggestion, one addressed in v4.
 */
const DOC = "/documents/clinic-outreach/v/5";

const buildButton = (page: Page) => page.getByTestId("build-draft").filter({ visible: true });
const sheet = (page: Page) => page.getByTestId("next-draft-sheet");

async function feedbackTab(page: Page) {
  await page.getByRole("tab", { name: "Feedback" }).filter({ visible: true }).click();
  await showAll(page);
}

const item = (page: Page, text: string) => page.getByTestId("feedback-item").filter({ visible: true, hasText: text });

/** The versions the switcher offers. */
async function versionNumbers(page: Page): Promise<string[]> {
  const switcher = page.getByRole("link", { name: /^v\d+$/ }).filter({ visible: true });
  return (await switcher.allTextContents()).map((t) => t.trim());
}

test("accepting a suggestion stages it for the next draft", async ({ page }) => {
  await login(page);
  await page.goto(DOC);
  await expect(buildButton(page)).toContainText("Build draft 6");
  await expect(buildButton(page).getByTestId("build-draft-count")).toHaveText("· 2 staged");

  await feedbackTab(page);
  // Every state reads on its item.
  await expect(item(page, "G2 retention").getByTestId("feedback-state")).toHaveText("Accepted · staged for draft 6");
  await expect(item(page, "40% figure").getByTestId("feedback-state")).toHaveText("Declined");
  await expect(item(page, "Name the clinics").getByTestId("feedback-state")).toHaveText("Addressed in v4");
  const open = item(page, "outbound check works");
  await expect(open.getByTestId("feedback-state")).toHaveText("Open");

  await open.getByRole("button", { name: "Accept" }).click();
  await expect(open.getByTestId("feedback-state")).toHaveText("Accepted · staged for draft 6");
  await expect(open.getByTestId("suggestion-staged")).toBeVisible();
  // Nothing was applied: still on v5, and the build action counts it.
  expect(await versionNumbers(page)).toEqual(["v1", "v2", "v3", "v4", "v5"]);
  await expect(buildButton(page).getByTestId("build-draft-count")).toHaveText("· 3 staged");
});

test("build draft 6: one job, one combined preview, apply makes exactly one version", async ({ page }) => {
  await login(page);
  await page.goto(DOC);
  await buildButton(page).click();
  const s = sheet(page);
  const items = s.getByTestId("staged-item");
  await expect(items).toHaveCount(2);
  await expect(items.filter({ hasText: "Goal trace" })).toContainText("v4");
  await expect(items.filter({ hasText: "F-38 Outbound check" })).toContainText("admin@example.com");
  for (const box of await s.getByRole("checkbox").all()) await expect(box).toBeChecked();
  await expect(s.getByTestId("build-estimate")).toContainText("$");

  await s.getByRole("button", { name: "Build draft 6" }).click();
  const preview = s.getByTestId("next-draft-preview");
  await expect(preview.getByTestId("next-draft-section")).toHaveCount(2);
  const check = preview.getByTestId("next-draft-section").filter({ hasText: "F-38 Outbound check" });
  await expect(check.locator("ins").first()).toContainText("Before");
  await expect(check.locator("del").first()).toContainText("After");
  await expect(s.getByTestId("kept-count")).toHaveText("2");

  await s.getByRole("button", { name: "Apply as draft 6" }).click();
  await expect(page).toHaveURL(/\/documents\/clinic-outreach\/v\/6\?tab=reports$/);
  // Exactly one new version, with both sections revised, and its 'what changed' report open.
  await expect(page.getByRole("tab", { name: "Reports" }).filter({ visible: true })).toHaveAttribute("aria-selected", "true");
  const reports = page.getByTestId("reports-panel").filter({ visible: true });
  await reports.getByRole("tab", { name: "What changed since v5" }).click();
  await expect(reports.getByRole("region", { name: "What changed" })).toContainText("F-38 Outbound check");
  await expect(reports.getByRole("region", { name: "What changed" })).toContainText("Goal trace");
  expect(await versionNumbers(page)).toEqual(["v1", "v2", "v3", "v4", "v5", "v6"]);
  await expect(await openSection(page, "f-38")).toContainText("Before each outbound call is placed");
  await expect(await openSection(page, "goal-trace")).toContainText("Serves G2 retention");
  await expect(buildButton(page)).toHaveCount(0);

  await feedbackTab(page);
  await expect(item(page, "G2 retention").getByTestId("feedback-state")).toHaveText("Addressed in v6");
  await expect(item(page, "before the call is placed").getByTestId("feedback-state")).toHaveText("Addressed in v6");
});

test("dropping a section from the preview keeps its item staged for the draft after", async ({ page }) => {
  await login(page);
  await page.goto(DOC);
  await buildButton(page).click();
  const s = sheet(page);
  await s.getByRole("button", { name: "Build draft 6" }).click();
  await s.getByRole("switch", { name: "Keep F-38 Outbound check" }).uncheck();
  await expect(s.getByTestId("kept-count")).toHaveText("1");
  await expect(s.getByTestId("next-draft-section").filter({ hasText: "F-38 Outbound check" })).toContainText("Stays staged");
  await s.getByRole("button", { name: "Apply as draft 6" }).click();
  await expect(page).toHaveURL(/\/documents\/clinic-outreach\/v\/6/);

  expect(await versionNumbers(page)).toEqual(["v1", "v2", "v3", "v4", "v5", "v6"]);
  await expect(await openSection(page, "f-38")).toContainText("After each outbound call");
  await expect(buildButton(page)).toContainText("Build draft 7");
  await expect(buildButton(page).getByTestId("build-draft-count")).toHaveText("· 1 staged");
  await feedbackTab(page);
  await expect(item(page, "before the call is placed").getByTestId("feedback-state")).toHaveText("Accepted · staged for draft 7");
  await expect(item(page, "G2 retention").getByTestId("feedback-state")).toHaveText("Addressed in v6");
});

test("discarding a build keeps everything staged", async ({ page }) => {
  await login(page);
  await page.goto(DOC);
  await buildButton(page).click();
  await sheet(page).getByRole("button", { name: "Build draft 6" }).click();
  await expect(sheet(page).getByTestId("next-draft-preview")).toBeVisible();
  await sheet(page).getByRole("button", { name: "Discard" }).click();
  await expect(sheet(page)).toHaveCount(0);
  expect(await versionNumbers(page)).toEqual(["v1", "v2", "v3", "v4", "v5"]);
  await expect(buildButton(page).getByTestId("build-draft-count")).toHaveText("· 2 staged");
});

test("unticking a staged item leaves it out of the build", async ({ page }) => {
  await login(page);
  await page.goto(DOC);
  await buildButton(page).click();
  const s = sheet(page);
  await s.getByRole("checkbox", { name: /Include Goal trace/ }).uncheck();
  await expect(s.getByTestId("pick-count")).toHaveText("1");
  await s.getByRole("button", { name: "Build draft 6" }).click();
  await expect(s.getByTestId("next-draft-section")).toHaveCount(1);
  await expect(s.getByTestId("next-draft-section")).toContainText("F-38 Outbound check");
});

test("Inbox: tabs by state with counts, New by default, and the badge counts only what needs me", async ({ page }) => {
  await login(page);
  await page.goto("/inbox");
  const tabs = page.getByTestId("inbox-state-tabs");
  const tab = (name: string) => tabs.getByRole("tab", { name: new RegExp(`^${name}`) });
  // New is the default tab on arrival, newest first.
  await expect(tab("New")).toHaveAttribute("aria-selected", "true");
  await expect(tab("New")).toHaveText("New5");
  await expect(tab("Open")).toHaveText("Open0");
  await expect(tab("Staged")).toHaveText("Staged2");
  await expect(tab("Declined")).toHaveText("Declined1");
  await expect(tab("Done")).toHaveText("Done5");
  const newRows = page.getByTestId("inbox-tab-new").locator("tr[data-row]");
  await expect(newRows).toHaveCount(5);
  await expect(newRows.first()).toContainText("Add a metric that shows the outbound check works");
  await expect(newRows.first().getByRole("link", { name: /^Review/ })).toHaveText("Review suggestions");

  // The badge: checkpoints 1 + cost 2 + questions 2 + new 5 + open 0; staged, declined and done do not count.
  await expect(page.getByTestId("nav-inbox-badge")).toHaveText("10");
  await expect(page.getByText("10 waiting").filter({ visible: true })).toBeVisible();

  await tab("Staged").click();
  const staged = page.getByTestId("inbox-tab-staged");
  const docRow = staged.locator('tr[data-state="staged-doc"]');
  await expect(docRow).toContainText("2 changes staged for draft 6");
  await expect(docRow).toContainText("Clinic outreach PRD");
  await expect(staged.locator('tr[data-state="staged"]')).toHaveCount(2);

  await tab("Declined").click();
  const declined = page.getByTestId("inbox-tab-declined").locator("tr[data-row]");
  await expect(declined).toHaveCount(1);
  await expect(declined.getByTestId("decline-note")).toHaveText("The 2024 audit is still the latest count; keep the figure.");
  await expect(declined.getByRole("link", { name: /^View/ })).toBeVisible();

  await tab("Done").click();
  await expect(page.getByTestId("inbox-tab-done").locator("tr[data-row]").filter({ hasText: "Name the clinics" })).toContainText("v4");

  // Build draft 6 from the Inbox opens the build sheet on the document.
  await tab("Staged").click();
  await docRow.getByRole("link", { name: "Build draft 6 of Clinic outreach PRD" }).click();
  await expect(page).toHaveURL(/\/documents\/clinic-outreach\/v\/5\?build=1$/);
  await expect(sheet(page).getByTestId("staged-item")).toHaveCount(2);
});

test("Inbox: arriving marks items seen; they stay New for this visit, Open on the next", async ({ page }) => {
  await login(page);
  await page.goto("/inbox");
  const tabs = page.getByTestId("inbox-state-tabs");
  await expect(tabs.getByRole("tab", { name: /^New/ })).toHaveText("New5");
  // Let the arrival's mark-seen call land, then come back.
  await page.waitForTimeout(500);
  await page.goto("/documents");
  await page.goto("/inbox");
  await page.reload();
  await expect(tabs.getByRole("tab", { name: /^New/ })).toHaveText("New0");
  await expect(tabs.getByRole("tab", { name: /^Open/ })).toHaveText("Open5");
  // New is still the default tab; the badge still counts open items.
  await expect(tabs.getByRole("tab", { name: /^New/ })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("nav-inbox-badge")).toHaveText("10");
});
