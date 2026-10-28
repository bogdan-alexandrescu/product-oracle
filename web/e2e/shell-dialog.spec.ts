import { expect, test, type Locator, type Page } from "./test";

import { DATE_BASES_SCENARIO } from "../lib/api/mock/roadmap";
import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";

/*
 * The design system's one Dialog (qa-plan-29, qa-plan-55, qa-settings-12), driven as a person
 * would on the mock API: Record basis on Plan › Dates, New entry on the changelog and New
 * launch on Launches share one frame (title and close X, body, Cancel as a bordered button
 * before the primary action), focus moves into it and back to the button that opened it,
 * and typed work is not lost to a stray Escape or click outside.
 *
 * Card: protects=the dialog's frame, focus and the discard question; fails_when=Escape or a
 * click on the backdrop drops typed text without asking, Keep editing loses it, focus stays on
 * the page or does not come back, or Cancel is drawn as a borderless ghost; no_claim=the
 * dialogs' own submits (date-bases.spec.ts, launches-create.spec.ts).
 */

const LEAD = "commenter@example.com";

async function openDates(page: Page) {
  await page.addInitScript(([key, s]) => localStorage.setItem(key, s), [MOCK_SCENARIO_KEY, DATE_BASES_SCENARIO]);
  await login(page, LEAD);
  await page.goto("/plan/dates");
  await expect(page.getByRole("button", { name: "Record basis" })).toBeVisible();
}

/** The one frame: a modal named by its title, a close X, and a bordered Cancel before the primary action. */
async function expectOneStyle(dialog: Locator, title: string) {
  await expect(dialog).toHaveAttribute("role", "dialog");
  await expect(dialog).toHaveAttribute("aria-modal", "true");
  await expect(dialog.getByRole("heading", { level: 2, name: title })).toBeVisible();
  // The X is "Close": the dialog itself is named by its title.
  await expect(dialog.getByRole("button", { name: "Close", exact: true })).toBeVisible();
  const footer = dialog.getByTestId("dialog-footer");
  const cancel = footer.getByRole("button", { name: "Cancel" });
  await expect(cancel).toHaveAttribute("data-variant", "secondary");
  expect(await cancel.evaluate((el) => getComputedStyle(el).borderTopWidth)).toBe("1px");
  // Cancel first, the primary action last.
  const variants = await footer.locator("[data-variant]").evaluateAll((els) => els.map((el) => el.getAttribute("data-variant")));
  expect(variants[0]).toBe("secondary");
  expect(variants[variants.length - 1]).toBe("primary");
}

test("Record basis: focus moves to the first field, Tab stays inside, and focus returns to Record basis", async ({ page }) => {
  await openDates(page);
  const open = page.getByRole("button", { name: "Record basis" });
  await open.click();
  const dialog = page.getByRole("dialog", { name: "Record basis" });
  await expectOneStyle(dialog, "Record basis");
  await expect(dialog.getByLabel("PRD")).toBeFocused();
  // Tab round the whole dialog: focus never leaves it.
  for (let i = 0; i < 20; i++) {
    await page.keyboard.press("Tab");
    expect(await dialog.evaluate((el) => el.contains(document.activeElement))).toBe(true);
  }
  // Nothing typed: Escape closes at once.
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(open).toBeFocused();
});

test("Record basis: with typed text, Escape asks first; Keep editing keeps the text and Discard closes", async ({ page }) => {
  await openDates(page);
  const open = page.getByRole("button", { name: "Record basis" });
  await open.click();
  const dialog = page.getByRole("dialog", { name: "Record basis" });
  await dialog.getByLabel("Reference").fill("ENG-999");

  await page.keyboard.press("Escape");
  const ask = dialog.getByTestId("dialog-discard");
  await expect(ask).toContainText("Discard your changes?");
  await expect(dialog).toBeVisible();
  await ask.getByRole("button", { name: "Keep editing" }).click();
  await expect(ask).toHaveCount(0);
  await expect(dialog.getByLabel("Reference")).toHaveValue("ENG-999");

  // A click on the dimmed backdrop asks too.
  await page.mouse.click(5, 5);
  await expect(ask).toBeVisible();
  await expect(dialog.getByLabel("Reference")).toHaveValue("ENG-999");

  await ask.getByRole("button", { name: "Discard" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(open).toBeFocused();
});

test("New entry and New launch share the frame and ask before dropping typed work", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("po-mock-scenario", "launches"));
  await login(page);

  await page.goto("/roadmap/changelog");
  const newEntry = page.getByTestId("new-entry");
  await newEntry.click();
  const entry = page.getByRole("dialog", { name: "New entry" });
  await expectOneStyle(entry, "New entry");
  await expect(entry.getByLabel("Title")).toBeFocused();
  await entry.getByLabel("Title").fill("Faster exports");
  await page.keyboard.press("Escape");
  await expect(entry.getByTestId("dialog-discard")).toContainText("Discard your changes?");
  await entry.getByRole("button", { name: "Keep editing" }).click();
  await expect(entry.getByLabel("Title")).toHaveValue("Faster exports");
  // Cancel is the explicit choice: it closes without asking.
  await entry.getByRole("button", { name: "Cancel" }).click();
  await expect(entry).toHaveCount(0);
  await expect(newEntry).toBeFocused();

  await page.goto("/roadmap/launches");
  const newLaunch = page.getByTestId("new-launch");
  await newLaunch.click();
  const launch = page.getByRole("dialog", { name: "New launch" });
  await expectOneStyle(launch, "New launch");
  await launch.getByTestId("launch-item-option").nth(0).getByRole("checkbox").check();
  await page.keyboard.press("Escape");
  await expect(launch.getByTestId("dialog-discard")).toBeVisible();
  await launch.getByRole("button", { name: "Discard" }).click();
  await expect(launch).toHaveCount(0);
  await expect(newLaunch).toBeFocused();
});

test("Build roadmap uses the same frame", async ({ page }) => {
  await login(page);
  await page.goto("/plan/documents");
  await page.getByTestId("approved-prd").filter({ hasText: "Usage alerts PRD" }).getByRole("button", { name: "Build roadmap" }).click();
  const dialog = page.getByRole("dialog", { name: "Build roadmap" });
  await expectOneStyle(dialog, "Build roadmap");
  await expect(dialog.getByLabel("Roadmap", { exact: true })).toBeFocused();
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await expect(dialog).toHaveCount(0);
});

test("Settings › Sources: More actions moves focus into its menu, and Escape returns it to the button", async ({ page }) => {
  await login(page);
  await page.goto("/settings/sources");
  const chat = page.getByRole("listitem", { name: "Product chat" });
  const more = chat.getByRole("button", { name: "More actions for Product chat" });
  await more.click();
  const menu = chat.getByRole("menu", { name: "More actions for Product chat" });
  await expect(menu.getByRole("menuitem", { name: "Edit channels" })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(menu.getByRole("menuitem", { name: "Coverage" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(more).toBeFocused();
});

test("New launch: a track-only change asks before closing, and Cancel waits while it saves", async ({ page }) => {
  // protects=a changed Track counts as typed work; Cancel and the X are disabled while Create launch
  // is saving (fix-shell review); fails_when=Escape drops a changed track without asking, or Cancel
  // can be pressed mid-save; no_claim=the launch itself (launches-create.spec.ts).
  await page.addInitScript(() => localStorage.setItem("po-mock-scenario", "launches"));
  await login(page);
  await page.goto("/roadmap/launches");
  await page.getByTestId("new-launch").click();
  const launch = page.getByRole("dialog", { name: "New launch" });
  const track = launch.getByLabel("Track");
  const first = await track.inputValue();
  const other = await track.locator("option").evaluateAll((os, v) => os.map((o) => (o as HTMLOptionElement).value).find((x) => x !== v)!, first);
  await track.selectOption(other);
  await page.keyboard.press("Escape");
  await expect(launch.getByTestId("dialog-discard")).toContainText("Discard your changes?");
  await launch.getByRole("button", { name: "Discard" }).click();
  await expect(launch).toHaveCount(0);

  await page.evaluate(() => localStorage.setItem("po-mock-slow", "POST /v1/launches"));
  await page.getByTestId("new-launch").click();
  await launch.getByTestId("launch-item-option").nth(0).getByRole("checkbox").check();
  await launch.getByRole("button", { name: "Create launch" }).click();
  await expect(launch.getByRole("button", { name: "Creating…" })).toBeVisible();
  await expect(launch.getByRole("button", { name: "Cancel" })).toBeDisabled();
  await expect(launch.getByRole("button", { name: "Close", exact: true })).toBeDisabled();
  await expect(launch).toHaveCount(0);
});

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("Record basis opened from a Plan item's sheet: Escape asks inside the dialog and keeps the sheet", async ({ page }) => {
    // protects=Escape in a dialog over a sheet goes to the dialog (its discard question), not the
    // sheet; fails_when=the sheet's own Escape closes the sheet and the typed text with it;
    // no_claim=the basis itself (date-bases.spec.ts).
    await page.addInitScript(([key, s]) => localStorage.setItem(key, s), [MOCK_SCENARIO_KEY, DATE_BASES_SCENARIO]);
    await login(page, LEAD);
    await page.goto("/plan");
    await page.getByTestId("plan-row").filter({ visible: true }).filter({ hasText: "Alerts in the team chat" }).getByTestId("plan-title").click();
    const sheet = page.getByTestId("sheet-plan-item");
    await expect(sheet).toBeVisible();
    await sheet.getByRole("button", { name: "Verify date" }).click();
    const dialog = page.getByRole("dialog", { name: "Record basis" });
    await dialog.getByLabel("Reference").fill("ENG-999");
    await page.keyboard.press("Escape");
    await expect(dialog.getByTestId("dialog-discard")).toContainText("Discard your changes?");
    await expect(dialog.getByLabel("Reference")).toHaveValue("ENG-999");
    await expect(sheet).toBeVisible();
    await dialog.getByRole("button", { name: "Keep editing" }).click();
    await page.keyboard.press("Escape");
    await dialog.getByRole("button", { name: "Discard" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(sheet).toBeVisible();
  });
});
