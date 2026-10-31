import { expect, test, type Page } from "./test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";

import { login } from "./helpers";

/*
 * QA pass 4 fixes on Company › Rituals (and an occurrence page), Strategy (New vision and the
 * vision it starts) and Updates (New update), on the mock layer, driven through the UI as a
 * person would. Rituals use the "rituals" scenario (today Wed Oct 28 2026, the Company time
 * zone not set, so Los Angeles is used); Strategy uses "strategy-no-vision"; Updates use the
 * default scenario, whose seeded updates are "Investor update · September 2026" and
 * "Board update · October 2026" (the mock's today is in October 2026).
 */

const TODAY = new Date("2026-10-28T17:00:00Z");

test.use({ timezoneId: "America/Los_Angeles", locale: "en-US" });

const ritualRow = (page: Page, title: string) => page.getByTestId("ritual-row").filter({ hasText: title });
const inspector = (page: Page) => page.getByTestId("ritual-inspector").filter({ visible: true });

async function openRituals(page: Page) {
  await page.clock.install({ time: TODAY });
  await page.addInitScript((key) => localStorage.setItem(key, "rituals"), MOCK_SCENARIO_KEY);
  await login(page);
  await page.goto("/company/rituals");
  await expect(ritualRow(page, "Weekly goals check-in")).toBeVisible();
}

async function pick(page: Page, title: string) {
  await ritualRow(page, title).click();
  await expect(inspector(page)).toContainText(title);
}

test.describe("desktop", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("qa4-company-1: Delete on a custom ritual asks first, naming it; Back keeps it", async ({ page }) => {
    await openRituals(page);
    await page.getByRole("button", { name: "Add ritual" }).click();
    const form = page.getByRole("form", { name: "Add ritual" });
    await form.getByLabel("Title").fill("Design sync example");
    await form.getByRole("button", { name: "Add" }).click();
    await expect(ritualRow(page, "Design sync example")).toBeVisible();
    await pick(page, "Design sync example");

    await inspector(page).getByRole("button", { name: "Delete" }).click();
    const ask = page.getByRole("alertdialog", { name: "Delete Design sync example?" });
    await expect(ask).toBeVisible();
    await expect(ask).toContainText("Design sync example");
    await ask.getByRole("button", { name: "Back" }).click();
    await expect(ask).toHaveCount(0);
    await expect(ritualRow(page, "Design sync example")).toBeVisible();

    await inspector(page).getByRole("button", { name: "Delete" }).click();
    await page.getByRole("alertdialog", { name: "Delete Design sync example?" }).getByRole("button", { name: "Delete ritual" }).click();
    await expect(ritualRow(page, "Design sync example")).toHaveCount(0);
  });

  test("qa4-company-19: a bad length and lead time are flagged under both fields, in the app's words", async ({ page }) => {
    await openRituals(page);
    await pick(page, "Monthly roadmap refresh");
    const panel = inspector(page);
    await panel.getByLabel("Length (minutes)").fill("0");
    await panel.getByLabel("Pre-read lead time (hours)").fill("-3");
    await panel.getByRole("button", { name: "Save", exact: true }).click();
    await expect(panel.getByTestId("ritual-error-duration")).toHaveText("Use a length from 5 to 480 minutes.");
    await expect(panel.getByTestId("ritual-error-prep")).toHaveText("Use a lead time from 0 to 168 hours.");
    await expect(panel.getByLabel("Length (minutes)")).toHaveAttribute("aria-invalid", "true");
    // The browser's own bubble is off: the fields are not checked by it.
    expect(await panel.getByLabel("Length (minutes)").evaluate((el) => !!(el as HTMLInputElement).form?.noValidate)).toBe(true);

    // Fixing both clears the notes and saves.
    await panel.getByLabel("Length (minutes)").fill("45");
    await panel.getByLabel("Pre-read lead time (hours)").fill("2");
    await expect(panel.getByTestId("ritual-error-duration")).toHaveCount(0);
    await expect(panel.getByTestId("ritual-error-prep")).toHaveCount(0);
    await panel.getByRole("button", { name: "Save", exact: true }).click();
    await expect(panel.getByTestId("ritual-no-changes")).toHaveText("No changes");
  });

  test("qa4-company-21: the unset time zone reads as used until it is set, with the way to set it", async ({ page }) => {
    await openRituals(page);
    const line = page.getByTestId("rituals-zone");
    await expect(line).toHaveText("Times use Pacific Time (Los Angeles) until you set the company time zone. Set it");
    await expect(line.getByRole("link", { name: "Set it" })).toHaveAttribute("href", "/settings/company#timezone");
    await pick(page, "Monthly roadmap refresh");
    await expect(inspector(page).getByTestId("ritual-zone")).toHaveText("Pacific Time (Los Angeles) for now");
    await expect(page.locator("main")).not.toContainText("not set yet");
  });

  test("qa4-company-23: the occurrence header separates date, length, attendees and zone", async ({ page }) => {
    await openRituals(page);
    await ritualRow(page, "Monthly roadmap refresh").getByTestId("next-pre-read").click();
    const meta = page.getByTestId("occurrence-meta");
    await expect(meta).toBeVisible();
    expect(await meta.getByTestId("occurrence-meta-sep").count()).toBeGreaterThanOrEqual(3);
    await expect(meta).toHaveText(/min\s*·\s*\d+ attendees?\s*·\s*Times are in/);
  });

  test("qa4-company-27: Start from the empty template is a bordered button, not a text link", async ({ page }) => {
    await page.addInitScript((key) => localStorage.setItem(key, "strategy-no-vision"), MOCK_SCENARIO_KEY);
    await login(page);
    await page.goto("/company/strategy");
    await page.getByTestId("strategy-page").filter({ visible: true }).getByTestId("vision-card").getByRole("button", { name: "New vision" }).click();
    const dialog = page.getByRole("dialog", { name: "New vision" });
    const start = dialog.getByRole("button", { name: "Start from the empty template" });
    await expect(start).toHaveAttribute("data-variant", "secondary");
    expect(await start.evaluate((el) => getComputedStyle(el).borderTopStyle)).toBe("solid");
  });

  test("qa4-company-7: a vision started from the template says Created and Started by a person, never a token", async ({ page }) => {
    await page.addInitScript((key) => localStorage.setItem(key, "strategy-no-vision"), MOCK_SCENARIO_KEY);
    await login(page);
    await page.goto("/company/strategy");
    await page.getByTestId("strategy-page").filter({ visible: true }).getByTestId("vision-card").getByRole("button", { name: "New vision" }).click();
    await page.getByRole("dialog", { name: "New vision" }).getByRole("button", { name: "Start from the empty template" }).click();
    await expect(page).toHaveURL(/\/documents\/vision$/);
    const details = page.getByTestId("version-inspector").filter({ visible: true });
    await expect(details).toBeVisible();
    await expect(details).toContainText("Created");
    await expect(details).toContainText("Started by");
    await expect(details).not.toContainText("Imported");
    await expect(details.getByTestId("version-importer")).not.toHaveText(/token|draft-picker|integration/i);
    await expect(page.locator("main")).not.toContainText("API token");
    await expect(page.locator("main")).not.toContainText("draft-picker");
  });

  test("qa4-company-30: New update warns when its title is already taken", async ({ page }) => {
    await login(page);
    await page.goto("/company/updates");
    await page.getByRole("button", { name: "New update" }).click();
    const dialog = page.getByRole("dialog", { name: "New update" });
    await expect(dialog.getByLabel("Title")).toHaveValue(/^Investor update · /);
    await expect(dialog.getByTestId("update-title-taken")).toHaveCount(0);
    await dialog.getByRole("radio", { name: /^Board update/ }).check();
    await expect(dialog.getByLabel("Title")).toHaveValue("Board update · October 2026");
    await expect(dialog.getByTestId("update-title-taken")).toContainText("An update with this title already exists");
    await dialog.getByLabel("Title").fill("Board update · October 2026, second look");
    await expect(dialog.getByTestId("update-title-taken")).toHaveCount(0);
  });

  test("qa4-company-31: Draft with Oracle is disabled while the period starts after it ends", async ({ page }) => {
    await login(page);
    await page.goto("/company/updates");
    await page.getByRole("button", { name: "New update" }).click();
    const dialog = page.getByRole("dialog", { name: "New update" });
    await dialog.getByRole("radio", { name: /^Board update/ }).check();
    const draft = dialog.getByRole("button", { name: /^Draft with Oracle/ });
    await expect(draft).toBeEnabled();
    await dialog.getByLabel("From", { exact: true }).fill("2026-10-20");
    await dialog.getByLabel("To", { exact: true }).fill("2026-10-01");
    await expect(dialog.getByTestId("update-period-error")).toHaveText("The period starts after it ends.");
    await expect(draft).toBeDisabled();
    await dialog.getByLabel("To", { exact: true }).fill("2026-10-21");
    await expect(dialog.getByTestId("update-period-error")).toHaveCount(0);
    await expect(draft).toBeEnabled();
  });
});
