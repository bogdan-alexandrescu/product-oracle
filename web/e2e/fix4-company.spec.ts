import { expect, test, type Page } from "./test";

import { MOCK_FAIL_ONCE_KEY, MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";

/*
 * QA round 4 on Settings › Company and the Settings shell, driven through the UI on the mock
 * layer as the owner: the time zone in one searchable picker, Save only after a change in every
 * section, one message per problem, the Accent row's sizes, framed branding previews in the
 * dark theme, the tab bar at one height on every tab and the phone's page picker in full.
 * no_claim: the API's checks (pytest), Set up's walk-through (fix4-setup-onboarding.spec) and
 * other roles (fix4-setup-roles.spec).
 */

test.use({ viewport: { width: 1440, height: 900 } });

const timezone = (page: Page) => page.getByTestId("timezone-panel");

// protects: qa-settings-12: one control picks the zone; typing narrows a list right under it.
// fails_when: a separate search box and select are shown, typing shows nothing beside the
// field, or the keyboard cannot pick a zone.
test("qa-settings-12: the time zone is one searchable picker", async ({ page }) => {
  await login(page);
  await page.goto("/settings/company");
  const panel = timezone(page);
  await expect(panel.getByLabel("Find a time zone")).toHaveCount(0);
  await expect(panel.locator("select")).toHaveCount(0);
  const zone = panel.getByRole("combobox", { name: "Company time zone" });
  await expect(zone).toHaveAttribute("placeholder", "Not set · Pacific is used");

  await zone.fill("tokyo");
  const list = panel.getByRole("listbox", { name: "Time zones" });
  await expect(list).toBeVisible();
  // The list opens right under the field.
  const field = (await zone.boundingBox())!;
  const box = (await list.boundingBox())!;
  expect(box.y).toBeGreaterThanOrEqual(field.y + field.height - 1);
  expect(box.y).toBeLessThanOrEqual(field.y + field.height + 12);
  await expect(list.getByRole("option")).toHaveCount(1);
  await expect(list.getByRole("option")).toHaveText(/\(Tokyo\) · UTC\+9$/);

  // The keyboard picks it; Escape closes the list and keeps the zone.
  await zone.press("ArrowDown");
  await zone.press("Enter");
  await expect(list).toHaveCount(0);
  await expect(zone).toHaveAttribute("data-zone", "Asia/Tokyo");
  await expect(zone).toHaveValue(/\(Tokyo\) · UTC\+9$/);
  await zone.fill("berl");
  await zone.press("Escape");
  await expect(zone).toHaveValue(/\(Tokyo\)/);

  await zone.fill("no such place");
  await expect(list).toContainText("No time zone matches.");
  await zone.press("Escape");

  await panel.getByRole("button", { name: "Save" }).click();
  await expect(panel.getByRole("status")).toHaveText("Saved");
  await page.reload();
  await expect(timezone(page).getByRole("combobox", { name: "Company time zone" })).toHaveAttribute("data-zone", "Asia/Tokyo");
});

// protects: qa-settings-13: Horizons, Time zone and Pricing owner enable Save only after a
// change, each with a hint saying why it waits (unchanged default horizons can be confirmed).
// fails_when: a Save is pressable with nothing changed, or a section has no hint.
test("qa-settings-13: every section enables Save only after a change, with the hint", async ({ page }) => {
  await login(page);
  await page.goto("/settings/company");

  // Horizons: the defaults are confirmed by Save; once stored, Save waits for a change.
  const horizons = page.locator("#horizons");
  await expect(horizons.getByTestId("horizons-save-reason")).toHaveText("Save keeps the default horizons.");
  await horizons.getByLabel("Now").selectOption("2");
  await expect(horizons.getByTestId("horizons-save-reason")).toHaveCount(0);
  await horizons.getByRole("button", { name: "Save" }).click();
  await expect(horizons.getByRole("status")).toHaveText("Saved");
  await horizons.getByLabel("Next").selectOption("3");
  await horizons.getByLabel("Next").selectOption("2");
  await expect(horizons.getByRole("button", { name: "Save" })).toBeDisabled();
  await expect(horizons.getByTestId("horizons-save-reason")).toHaveText("Change a horizon to save it.");
  await horizons.getByLabel("Next").selectOption("4");
  await expect(horizons.getByRole("button", { name: "Save" })).toBeEnabled();

  // Pricing owner: one owner here, so nothing to change and Save waits (two owners: below).
  const pricing = page.getByTestId("pricing-owner-panel");
  await expect(pricing.getByRole("button", { name: "Save" })).toBeDisabled();
  await expect(pricing.getByTestId("pricing-owner-save-reason")).toHaveText("Admin is the only owner: make another member an owner to choose someone else.");

  // Time zone: waits for a pick, then for another one.
  const panel = timezone(page);
  await expect(panel.getByRole("button", { name: "Save" })).toBeDisabled();
  await expect(panel.getByTestId("timezone-save-reason")).toHaveText("Pick a time zone to save it.");
  const zone = panel.getByRole("combobox", { name: "Company time zone" });
  await zone.fill("Berlin");
  await panel.getByRole("listbox", { name: "Time zones" }).locator('[data-zone="Europe/Berlin"]').click();
  await panel.getByRole("button", { name: "Save" }).click();
  await expect(panel.getByRole("status")).toHaveText("Saved");
  await zone.fill("Berlin");
  await panel.getByRole("listbox", { name: "Time zones" }).locator('[data-zone="Europe/Berlin"]').click();
  await expect(panel.getByRole("button", { name: "Save" })).toBeDisabled();
  await expect(panel.getByTestId("timezone-save-reason")).toHaveText("Pick another time zone to save it.");
});

// protects: qa-settings-13 for the pricing owner, on the mock's "pricing" company (a second
// owner, Riley Park): Save waits for another owner, with the hint.
// fails_when: Save is pressable with the current owner still chosen.
test("qa-settings-13: the pricing owner's Save waits for another owner", async ({ page }) => {
  await page.addInitScript(([key, value]) => localStorage.setItem(key, value), [MOCK_SCENARIO_KEY, "pricing"]);
  await login(page);
  await page.goto("/settings/company");
  const pricing = page.getByTestId("pricing-owner-panel");
  const field = pricing.getByRole("combobox", { name: "Decides prices" });
  await expect(field.locator("option:checked")).toHaveText("Admin");
  await expect(pricing.getByRole("button", { name: "Save" })).toBeDisabled();
  await expect(pricing.getByTestId("pricing-owner-save-reason")).toHaveText("Not chosen yet: the earliest owner, Admin, decides until you pick someone else.");
  await field.selectOption({ label: "Riley Park" });
  await expect(pricing.getByRole("button", { name: "Save" })).toBeEnabled();
  await expect(pricing.getByTestId("pricing-owner-save-reason")).toHaveCount(0);
  await field.selectOption({ label: "Admin" });
  await expect(pricing.getByRole("button", { name: "Save" })).toBeDisabled();
});

// protects: qa-settings-14: a refused accent is said once, next to its field, and goes when
// the accent changes; a Save with it sends nothing.
// fails_when: the field's line and a red banner both say it, or the message stays after a fix.
test("qa-settings-14: a bad accent is reported once, next to its field", async ({ page }) => {
  await login(page);
  await page.goto("/settings/company");
  const card = page.getByTestId("branding-panel");
  await card.getByLabel("Accent").fill("#zzz");
  await card.getByRole("button", { name: "Save branding" }).click();
  await expect(card.getByRole("alert")).toHaveCount(1);
  await expect(card.getByTestId("accent-contrast").getByRole("alert")).toHaveText("Not a hex colour like #0369a1");
  await expect(card.getByLabel("Accent")).toHaveAttribute("aria-invalid", "true");
  await expect(card).not.toContainText("The accent must be a hex colour");

  await card.getByLabel("Accent").fill("#0369a1");
  await expect(card.getByRole("alert")).toHaveCount(0);
  await card.getByRole("button", { name: "Save branding" }).click();
  await expect(card.getByRole("status")).toHaveText("Saved");
  await expect(card.getByRole("alert")).toHaveCount(0);
});

// protects: qa-settings-14 for Horizons: a refused save's message goes once the horizons
// change again. fails_when: the old message stays beside the new values.
test("qa-settings-14: a refused Horizons save's message goes when a horizon changes", async ({ page }) => {
  await page.addInitScript(([key, call]) => localStorage.setItem(key, call), [MOCK_FAIL_ONCE_KEY, "PUT /v1/settings/planning_horizons"]);
  await login(page);
  await page.goto("/settings/company");
  const horizons = page.locator("#horizons");
  await horizons.getByLabel("Now").selectOption("2");
  await horizons.getByRole("button", { name: "Save" }).click();
  await expect(horizons.getByRole("alert")).toHaveCount(1);
  await horizons.getByLabel("To").fill("30");
  await expect(horizons.getByRole("alert")).toHaveCount(0);
  await horizons.getByRole("button", { name: "Save" }).click();
  await expect(horizons.getByRole("status")).toHaveText("Saved");
});

// protects: qa-settings-15: the Accent row in the form's own sizes.
// fails_when: the swatch's "None" is in 11 px type, or the hex field is in a monospace font.
test("qa-settings-15: the Accent row uses the form's type sizes and font", async ({ page }) => {
  await login(page);
  await page.goto("/settings/company");
  const card = page.getByTestId("branding-panel");
  await card.getByLabel("Accent").fill("");
  const swatch = card.getByTestId("accent-swatch");
  await expect(swatch).toHaveText("None");
  await expect(swatch).toHaveCSS("font-size", "13px");
  // "None" fits its swatch.
  expect(await swatch.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  const font = await card.getByLabel("Display name").evaluate((el) => getComputedStyle(el).fontFamily);
  await expect(card.getByLabel("Accent")).toHaveCSS("font-family", font);
  await expect(card.getByLabel("Accent")).toHaveCSS("font-size", "15px");
});

test.describe("dark theme", () => {
  test.use({ colorScheme: "dark" });

  // protects: qa-settings-16: both branding previews are framed by a visible edge in the dark theme.
  // fails_when: a preview's border is missing or the colour of its own background.
  test("qa-settings-16: both branding previews have a visible border", async ({ page }) => {
    await login(page);
    await page.goto("/settings/company");
    for (const id of ["brand-preview-light", "brand-preview-dark"]) {
      const preview = page.getByTestId(id);
      await expect(preview).toBeVisible();
      const { width, colour, background } = await preview.evaluate((el) => {
        const s = getComputedStyle(el);
        return { width: s.borderTopWidth, colour: s.borderTopColor, background: s.backgroundColor };
      });
      expect(width).toBe("1px");
      expect(colour).not.toBe(background);
    }
  });
});

// protects: qa-settings-11: the Settings tab bar sits at one height on every tab, and a tab's
// intro is in its tip as on the others (Autonomy, Webhooks).
// fails_when: the bar moves with an action button or a back link, or an intro line shows under the tabs.
test("qa-settings-11: the tab bar does not move between tabs; intros sit in the page tip", async ({ page }) => {
  await login(page);
  const nav = page.getByRole("navigation", { name: "Settings" });
  const tops: number[] = [];
  for (const path of ["/settings/members", "/settings/claude-accounts", "/settings/templates/one-pager", "/settings/webhooks"]) {
    await page.goto(path);
    await expect(nav).toBeVisible();
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    // The header's last parts (an action, chips) are drawn once the page has loaded.
    await page.waitForLoadState("networkidle");
    tops.push(Math.round((await nav.boundingBox())!.y));
  }
  expect(new Set(tops).size, `tab bar tops: ${tops.join(", ")}`).toBe(1);

  await expect(page.getByText("Tell your other tools when runs, drafts and approvals change.")).toBeHidden();
  await page.getByRole("button", { name: "About Webhooks" }).click();
  await expect(page.getByRole("tooltip").filter({ hasText: "Tell your other tools when runs, drafts and approvals change." })).toBeVisible();

  await page.goto("/settings/autonomy");
  await expect(page.getByRole("heading", { level: 2, name: "Knowledge", exact: true })).toBeVisible();
  await expect(page.getByText("How far Oracle goes on its own. You can change this any time.")).toBeHidden();
  await page.getByRole("button", { name: "About autonomy" }).click();
  await expect(page.getByRole("tooltip").filter({ hasText: "How far Oracle goes on its own." })).toBeVisible();
});

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  // protects: qa-onboarding-35: on a phone the Settings page picker takes the row and shows
  // the whole page name; Back to Home sits below it.
  // fails_when: the picker shares the row with Back to Home and cuts its value ("Connectio").
  test("qa-onboarding-35: the phone's Settings page picker shows the whole name", async ({ page }) => {
    await login(page);
    await page.goto("/settings/connections?from=setup");
    const select = page.getByTestId("settings-nav-select");
    await expect(select).toHaveValue("/settings/connections");
    const back = page.getByRole("navigation", { name: "Settings" }).getByRole("link", { name: "Back to Home" });
    await expect(back).toBeVisible();
    const s = (await select.boundingBox())!;
    const b = (await back.boundingBox())!;
    expect(b.y).toBeGreaterThanOrEqual(s.y + s.height);
    // The longest page name fits the picker in full (text width plus its arrow's padding).
    const fits = await select.evaluate((el: HTMLSelectElement) => {
      const s = getComputedStyle(el);
      const ctx = document.createElement("canvas").getContext("2d")!;
      ctx.font = `${s.fontWeight} ${s.fontSize} ${s.fontFamily}`;
      const widest = Math.max(...[...el.options].map((o) => ctx.measureText(o.text).width));
      return widest + parseFloat(s.paddingLeft) + parseFloat(s.paddingRight) <= el.clientWidth;
    });
    expect(fits).toBe(true);
  });
});
