import { deflateSync } from "node:zlib";

import type { Page } from "@playwright/test";

import { expect, test } from "./test";

import { login } from "./helpers";

/**
 * QA round 2 on Settings › Company and Settings › Notifications, driven through the UI on the
 * mock layer: the branding preview in the dark theme, the logo uploads and the accent swatch,
 * time zones in words with a search, an unset zone said the same way on both pages, the
 * horizons' Save and its checks, the pricing owner's field, and where the weekly report goes.
 */

/** A small solid PNG, built here so the test needs no image file. */
function png(width: number, height: number): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf: Buffer) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 0x33)]);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** WCAG contrast of two computed "rgb(r, g, b)" colours. */
function contrast(a: string, b: string): number {
  const lum = (c: string) => {
    const [r, g, bl] = (c.match(/\d+(\.\d+)?/g) ?? []).slice(0, 3).map((v) => {
      const s = Number(v) / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** The preview box's background and its name's colour. */
async function previewColours(page: Page, testId: string) {
  const box = page.getByTestId(testId);
  return box.evaluate((el) => ({
    bg: getComputedStyle(el).backgroundColor,
    text: getComputedStyle(el.querySelector("span")!).color,
  }));
}

test.describe("dark theme", () => {
  test.use({ colorScheme: "dark" });

  // protects: qa-settings-5 / qa-onboarding-2: the light preview stays white with a dark name
  // and the dark preview dark with a white name, whatever the app's theme.
  // fails_when: the dark theme turns the light preview's box dark (bg-white is the surface
  // token) or the names melt into their boxes (under 4.5:1).
  // no_claim: how an uploaded logo itself reads.
  test("qa-settings-5: the branding previews keep readable names in the dark theme", async ({ page }) => {
    await login(page);
    await page.goto("/settings/company");
    await expect(page.getByTestId("brand-preview-light")).toBeVisible();
    const light = await previewColours(page, "brand-preview-light");
    const dark = await previewColours(page, "brand-preview-dark");
    expect(light.bg).toBe("rgb(255, 255, 255)");
    expect(dark.bg).toBe("rgb(17, 24, 39)");
    expect(light.bg).not.toBe(dark.bg);
    expect(contrast(light.bg, light.text)).toBeGreaterThan(4.5);
    expect(contrast(dark.bg, dark.text)).toBeGreaterThan(4.5);
  });
});

// protects: qa-settings-20: the logos upload through styled buttons that name what they do
// and show what was uploaded, and the accent swatch says None until there is a colour.
// fails_when: the native "Choose File" control shows, the file's name is not shown after an
// upload, or the swatch is an empty box beside a placeholder colour.
// no_claim: the API's image checks (pytest test_branding.py).
test("qa-settings-20: logo uploads are buttons with the file named, and the swatch shows the accent", async ({ page }) => {
  await login(page);
  await page.goto("/settings/company");
  const card = page.getByTestId("branding-panel");
  const input = card.getByLabel("Logo", { exact: true });
  // The native control is kept for the file picker but out of sight (sr-only, 1 px).
  expect((await input.boundingBox())?.width ?? 0).toBeLessThanOrEqual(1);
  await expect(card.getByText("Upload logo", { exact: true })).toBeVisible();
  await expect(card.getByText("Upload dark logo", { exact: true })).toBeVisible();
  await input.setInputFiles({ name: "acme-logo.png", mimeType: "image/png", buffer: png(160, 40) });
  await expect(card.getByText("acme-logo.png")).toBeVisible();
  await expect(card.getByText("Replace logo", { exact: true })).toBeVisible();

  const swatch = card.getByTestId("accent-swatch");
  await card.getByLabel("Accent").fill("");
  await expect(swatch).toHaveText("None");
  await expect(card.getByLabel("Accent")).toHaveAttribute("placeholder", "e.g. #0369a1");
  await card.getByLabel("Accent").fill("#0369a1");
  await expect(swatch).toHaveText("");
  await expect(swatch).toHaveCSS("background-color", "rgb(3, 105, 161)");
});

// protects: qa-settings-19 / qa-onboarding-8 and qa-settings-8: the zone select says zones in
// Home's words with their UTC offset, common zones first, with a search; unset, it says
// "Not set · Pacific is used" as Notifications does.
// fails_when: options are raw ids, Pacific is shown as chosen while Notifications says not
// set, the search does not narrow the list, or Home names the zone differently.
// no_claim: every zone's wording (the browser's names).
test("qa-settings-19: time zones in words with offsets and a search; unset agrees with Notifications", async ({ page }) => {
  await login(page);
  await page.goto("/settings/notifications");
  await expect(page.getByTestId("report-zone")).toHaveText("Not set · Pacific is used");

  await page.goto("/settings/company");
  const panel = page.getByTestId("timezone-panel");
  const zone = panel.getByLabel("Company time zone");
  await expect(zone).toHaveValue("");
  await expect(zone.locator("option:checked")).toHaveText("Not set · Pacific is used");
  await expect(zone.locator("optgroup").first()).toHaveAttribute("label", "Common");
  await expect(zone.locator("optgroup").first().locator("option").first()).toHaveText(/^Pacific Time \(Los Angeles\) · UTC-[78]$/);
  for (const text of await zone.locator("option").allTextContents()) expect(text).not.toMatch(/^[A-Za-z]+\/[A-Za-z_]+$/);

  await panel.getByLabel("Find a time zone").fill("tokyo");
  const tokyo = zone.locator('option[value="Asia/Tokyo"]');
  await expect(tokyo).toHaveText(/\(Tokyo\) · UTC\+9$/);
  await expect(zone.locator('option[value="Europe/Berlin"]')).toHaveCount(0);
  const name = (await tokyo.textContent())!.split(" · ")[0];
  await zone.selectOption("Asia/Tokyo");
  await panel.getByRole("button", { name: "Save" }).click();
  await expect(panel.getByRole("status")).toHaveText("Saved");

  await page.goto("/settings/notifications");
  await expect(page.getByTestId("report-zone")).toHaveText(name);
  await page.goto("/home");
  await expect(page.getByTestId("setup-row-timezone")).toContainText(name);
});

// protects: qa-settings-6, qa-settings-18, qa-onboarding-20: Later's months are checked next
// to the fields in plain words, the horizons save with Save like every other panel, a save
// says Saved, and the way back to the defaults says what it does.
// fails_when: the raw "long_to_months ..." message shows, the button reads Confirm, nothing
// says it saved, or the button reads a bare Reset.
// no_claim: the API's own check (api/tests/test_tenant_settings_api.py).
test("qa-settings-6: horizons say what is wrong next to the fields, Save, Saved and Reset to defaults", async ({ page }) => {
  await login(page);
  await page.goto("/settings/company?from=setup#horizons");
  const horizons = page.locator("#horizons");
  await expect(horizons.getByRole("button", { name: "Confirm" })).toHaveCount(0);
  await horizons.getByLabel("From").fill("30");
  await horizons.getByLabel("To").fill("10");
  await horizons.getByRole("button", { name: "Save" }).click();
  const wrong = horizons.locator("#horizon-later-error");
  await expect(wrong).toHaveText("'To' must be after 'From' and at most 60 months.");
  await expect(horizons).not.toContainText("long_to_months");
  await expect(horizons.getByLabel("To")).toHaveAttribute("aria-invalid", "true");

  await horizons.getByLabel("To").fill("40");
  await expect(wrong).toHaveCount(0);
  await horizons.getByRole("button", { name: "Save" }).click();
  await expect(horizons.getByRole("status")).toHaveText("Saved · Back to Home");
  await expect(horizons.getByRole("button", { name: "Reset to defaults" })).toBeVisible();
  await horizons.getByRole("status").getByRole("link", { name: "Back to Home" }).click();
  await expect(page).toHaveURL(/\/home$/);
});

// protects: qa-settings-21: the pricing owner's field says what the person does instead of
// repeating the panel's title.
// fails_when: "Pricing owner" is both the title and the field's label.
// no_claim: who may be chosen (e2e/pricing.spec.ts).
test("qa-settings-21: the pricing owner field says who decides prices", async ({ page }) => {
  await login(page);
  await page.goto("/settings/company");
  const panel = page.getByTestId("pricing-owner-panel");
  await expect(panel.getByRole("heading", { name: "Pricing owner" })).toBeVisible();
  await expect(panel.getByRole("combobox", { name: "Decides prices" })).toBeVisible();
  await expect(panel.getByText("Pricing owner", { exact: true })).toHaveCount(1);
});

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  // protects: qa-settings-38 and qa-settings-42: with Slack not connected the weekly report
  // says it goes to the Inbox only, and on a phone the report's checkbox row is a 44 px tap.
  // fails_when: the text promises the Slack channel with no Slack, or the tap area is 16 px.
  // no_claim: posting to Slack (e2e/alignment-report.spec.ts).
  test("qa-settings-38: the weekly report says Inbox only without Slack; its checkbox is a 44 px tap", async ({ page }) => {
    await login(page);
    await page.goto("/settings/notifications");
    const schedule = page.getByTestId("report-schedule");
    await expect(page.getByRole("button", { name: "Connect Oracle to Slack" })).toBeVisible();
    await expect(schedule.getByTestId("report-where")).toContainText("Inbox only until Slack is connected.");
    await expect(schedule.getByTestId("report-where")).not.toContainText("Slack channel");
    const row = schedule.getByTestId("report-enabled");
    const box = (await row.boundingBox())!;
    expect(box.height).toBeGreaterThanOrEqual(44);
    expect(box.width).toBeGreaterThanOrEqual(44);
    const check = schedule.getByLabel("Make the weekly report");
    const before = await check.isChecked();
    await row.click({ position: { x: box.width - 4, y: box.height / 2 } });
    await expect(check).toBeChecked({ checked: !before });
  });
});
