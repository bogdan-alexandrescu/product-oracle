import { expect, test, type Page } from "./test";

import { GROUND_TRUTH_FLAGS_SCENARIO } from "../lib/api/mock/ground-truth";
import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";

/**
 * The owner's pick (Nov 10, proposal A): Home's Ground Truth flags, one line at the foot of the
 * Waiting for you card ("9 Ground Truth flags", the why behind its (i)), opening a sheet titled
 * "Ground Truth flags · 9" that holds the Ground Truth page's own flags band, each flag with its
 * fix. In the "ground-truth-flags" scenario: linking the PRD's F-09 Guest seats to a feature
 * clears it and its roadmap item F-09a, so Home's count drops to 7 at once, and Undo in the
 * sheet brings back 9. A viewer reads the line and the flags with no fixes; a phone shows the
 * sheet full screen; the default company has one flag (Dark mode serves no goal), and with none
 * left there is no line.
 */

const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };

async function home(page: Page, email?: string, scenario: string | null = GROUND_TRUTH_FLAGS_SCENARIO) {
  if (scenario) await page.addInitScript(([key, value]) => localStorage.setItem(key, value), [MOCK_SCENARIO_KEY, scenario] as const);
  await login(page, email);
  await page.goto("/simple");
}

const line = (page: Page) => page.getByTestId("gtf-line");
/** The line's words: its count and name (why is behind its (i)). */
const count = (page: Page) => page.getByTestId("gtf-open");
const sheet = (page: Page) => page.getByRole("dialog", { name: /Ground Truth flags/ });
const row = (page: Page, name: string) => sheet(page).getByTestId("gt-row").filter({ hasText: name });
const notice = (page: Page) => sheet(page).getByTestId("gt-notice");

async function openKind(page: Page, kind: string) {
  await sheet(page).getByTestId(`gt-count-${kind}`).click();
  await expect(sheet(page).getByTestId(`gt-list-${kind}`)).toBeVisible();
}

for (const colorScheme of ["light", "dark"] as const)
  test(`Home's Waiting card counts the flags; linking Guest seats drops it to 7, Undo brings 9 back (${colorScheme})`, async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await page.emulateMedia({ colorScheme });
    await home(page);
    // The line's words are its count and name; why is behind its (i).
    await expect(count(page)).toHaveText("9 Ground Truth flags");
    await expect(page.getByRole("region", { name: /^(Summary|Waiting for you)$/ }).getByTestId("gtf-line")).toBeVisible();
    await line(page).getByRole("button", { name: "About Ground Truth flags" }).click();
    await expect(line(page).getByRole("tooltip")).toHaveText("Anything that breaks the Ground Truth is allowed, and flagged here with its fix.");
    await page.keyboard.press("Escape");

    await page.getByTestId("gtf-open").click();
    await expect(sheet(page)).toBeVisible();
    await expect(sheet(page).getByRole("heading").first()).toHaveText("Ground Truth flags · 9");
    // The flags by kind, as the Ground Truth page lists them.
    await expect(sheet(page).getByTestId("gt-count-unlinked_item")).toContainText("Not in the Ground Truth");
    await expect(sheet(page).getByTestId("gt-count-unlinked_item")).toContainText("3");
    await expect(sheet(page).getByTestId("gt-count-slice_parent_missing")).toContainText("2");
    for (const kind of ["prd_feature_missing", "no_code", "no_goal", "runs_today_on_roadmap"]) await expect(sheet(page).getByTestId(`gt-count-${kind}`)).toContainText("1");

    await openKind(page, "prd_feature_missing");
    await expect(row(page, "Guest seats")).toContainText("PRD Scale");
    await row(page, "Guest seats").getByRole("button", { name: /Link to a feature/ }).click();
    const picker = page.getByTestId("gt-picker");
    await picker.getByLabel("Find a feature").fill("F-12");
    await picker.getByRole("button", { name: "F-12 Digest emails" }).click();
    await expect(picker).toHaveCount(0);
    await expect(notice(page)).toContainText("Linked “F-09 Guest seats” to “Digest emails”.");
    await expect(sheet(page).getByRole("heading").first()).toHaveText("Ground Truth flags · 7");
    await expect(count(page)).toHaveText("7 Ground Truth flags");

    await notice(page).getByRole("button", { name: "Undo" }).click();
    await expect(notice(page)).toContainText("Undone.");
    await expect(sheet(page).getByRole("heading").first()).toHaveText("Ground Truth flags · 9");
    await expect(count(page)).toHaveText("9 Ground Truth flags");
    await sheet(page).getByRole("button", { name: "Close" }).first().click();
    await expect(sheet(page)).toHaveCount(0);
    // Home reads it again: still 9.
    await page.reload();
    await expect(count(page)).toHaveText("9 Ground Truth flags");
  });

for (const viewport of [DESKTOP, PHONE])
  test(`a viewer sees the line and reads the flags with no fixes (${viewport.width})`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await home(page, "viewer@example.com");
    await expect(count(page)).toHaveText("9 Ground Truth flags");
    await page.getByTestId("gtf-open").click();
    for (const kind of ["unlinked_item", "prd_feature_missing", "no_code"]) {
      await openKind(page, kind);
      await expect(sheet(page).getByTestId(`gt-list-${kind}`).getByTestId("gt-row").first()).toBeVisible();
      await expect(sheet(page).getByRole("button", { name: /Add to Ground Truth|Link to a feature|Give it a code|Pick a goal|Confirm it|Take it off/ })).toHaveCount(0);
    }
  });

for (const colorScheme of ["light", "dark"] as const)
  test(`a phone shows the sheet full screen (390, ${colorScheme})`, async ({ page }) => {
    await page.setViewportSize(PHONE);
    await page.emulateMedia({ colorScheme });
    await home(page);
    await line(page).scrollIntoViewIfNeeded();
    await page.getByTestId("gtf-open").click();
    await expect(sheet(page)).toBeVisible();
    const box = await sheet(page).boundingBox();
    expect(box).not.toBeNull();
    expect(Math.round(box!.x)).toBe(0);
    expect(Math.round(box!.width)).toBe(PHONE.width);
    expect(Math.round(box!.height)).toBeGreaterThanOrEqual(PHONE.height - 1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });

test("the default company's one flag (Dark mode serves no goal): picking a goal leaves no flags, and Home shows no line", async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await home(page, undefined, null);
  await expect(page.getByRole("region", { name: /^(Summary|Waiting for you)$/ }).first()).toBeVisible();
  await expect(count(page)).toHaveText("1 Ground Truth flag");
  await count(page).click();
  await openKind(page, "no_goal");
  await row(page, "Dark mode").getByRole("button", { name: /Pick a goal/ }).click();
  await page.getByTestId("gt-picker").getByRole("button").filter({ hasText: "Raise activation" }).click();
  await expect(notice(page)).toContainText(/Dark mode” now serves “Raise activation”/);
  await expect(line(page)).toHaveCount(0);
  await sheet(page).getByRole("button", { name: "Close" }).first().click();
  await page.reload();
  await expect(page.getByRole("region", { name: /^(Summary|Waiting for you)$/ }).first()).toBeVisible();
  await expect(line(page)).toHaveCount(0);
});
