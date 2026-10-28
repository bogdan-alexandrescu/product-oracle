import { deflateSync } from "node:zlib";

import type { Locator, Page } from "@playwright/test";

import { expect, test } from "./test";

import { login } from "./helpers";

/**
 * QA pass on Settings › Company and Settings › Notifications (qa-settings-1, 2, 22, 23),
 * driven as a person would on the mock layer.
 */

/** A small solid grey PNG, built here so the test needs no image file. */
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
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 0x88)]);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const css = (el: Locator, prop: "backgroundColor" | "color") => el.evaluate((e, p) => getComputedStyle(e)[p], prop);

/** The previews keep their own colours: a white header with dark text, a dark slide with white text. */
async function expectFixedPreviews(page: Page) {
  const card = page.getByTestId("branding-panel");
  await expect(card.getByLabel("Display name")).toHaveValue("Example Co");
  const light = card.getByTestId("brand-preview-light");
  const dark = card.getByTestId("brand-preview-dark");
  expect(await css(light, "backgroundColor")).toBe("rgb(255, 255, 255)");
  expect(await css(light.getByText("Example Co"), "color")).toBe("rgb(17, 17, 17)");
  expect(await css(dark, "backgroundColor")).toBe("rgb(17, 24, 39)");
  expect(await css(dark.getByText("Example Co"), "color")).toBe("rgb(255, 255, 255)");
}

test.describe("dark theme", () => {
  test.use({ colorScheme: "dark" });

  // protects: qa-settings-1, in dark mode the Branding preview still shows a white header with
  // dark text and a dark slide with white text, so the company name reads in both.
  // fails_when: the previews take the theme's surface (bg-white / text-white map to it) and
  // the name disappears. no_claim: the export's own colours.
  test("qa-settings-1: the Branding preview keeps its colours in dark mode", async ({ page }) => {
    await login(page);
    await page.goto("/settings/company");
    // The page itself is dark: the theme took.
    expect(await css(page.locator("body"), "backgroundColor")).not.toBe("rgb(255, 255, 255)");
    await expectFixedPreviews(page);
  });
});

test.describe("light theme", () => {
  test.use({ colorScheme: "light" });

  test("qa-settings-1: the Branding preview keeps its colours in light mode", async ({ page }) => {
    await login(page);
    await page.goto("/settings/company");
    await expectFixedPreviews(page);
  });
});

// protects: qa-settings-2, with no Company time zone stored, Company and Notifications both
// say "Not set · Pacific is used"; once an owner picks one, both name it in words.
// fails_when: Company shows Los Angeles selected as if chosen while Notifications says not set.
// no_claim: the API's default (pytest).
test("qa-settings-2: an unset time zone reads the same on Company and Notifications", async ({ page }) => {
  await login(page);
  await page.goto("/settings/company");
  const panel = page.getByTestId("timezone-panel");
  const zone = panel.getByLabel("Company time zone");
  await expect(zone).toHaveValue("");
  await expect(zone.locator("option:checked")).toHaveText("Not set · Pacific is used");
  // Nothing to save until a zone is picked, and it says so.
  await expect(panel.getByRole("button", { name: "Save time zone" })).toBeDisabled();
  await expect(panel.getByTestId("timezone-hint")).toHaveText("Pick a time zone to set it.");

  await page.goto("/settings/notifications");
  await expect(page.getByTestId("report-schedule").getByTestId("report-zone")).toHaveText("Not set · Pacific is used");

  await page.goto("/settings/company");
  await page.getByLabel("Company time zone").selectOption("America/New_York");
  await page.getByRole("button", { name: "Save time zone" }).click();
  await expect(page.getByTestId("timezone-panel").getByRole("status")).toHaveText("Saved");
  await expect(page.getByLabel("Company time zone").locator("option:checked")).toHaveText("Eastern Time (New York)");
  await page.goto("/settings/notifications");
  await expect(page.getByTestId("report-schedule").getByTestId("report-zone")).toHaveText("Eastern Time (New York)");
});

// protects: qa-settings-22, an empty accent reads as "No accent" (not a sample hex in code
// font) and the logos are picked with labelled buttons, not the browser's bare file control.
// fails_when: the accent field shows #0369a1 as its placeholder in a code font, or there is
// no Upload logo button. no_claim: the API's image checks (branding.spec.ts).
test("qa-settings-22: Branding's empty accent and the logo upload buttons", async ({ page }) => {
  await login(page);
  await page.goto("/settings/company");
  const card = page.getByTestId("branding-panel");
  const accent = card.getByLabel("Accent");
  await expect(accent).toHaveValue("");
  await expect(accent).toHaveAttribute("placeholder", "No accent");
  expect(await accent.evaluate((e) => getComputedStyle(e).fontFamily)).not.toMatch(/mono/i);
  await expect(card.getByTestId("accent-swatch")).toHaveCSS("border-style", "dashed");
  await expect(card.getByTestId("accent-contrast")).toContainText("No accent");

  await expect(card.getByText("No logo", { exact: true })).toBeVisible();
  await expect(card.getByText("No dark logo", { exact: true })).toBeVisible();
  const chooser = page.waitForEvent("filechooser");
  await card.getByRole("button", { name: "Upload logo", exact: true }).click();
  await (await chooser).setFiles({ name: "logo.png", mimeType: "image/png", buffer: png(160, 40) });
  await expect(card.getByTestId("brand-preview-light").locator("img")).toHaveAttribute("src", /^data:image\/png;base64,/);
  await expect(card.getByRole("button", { name: "Replace logo", exact: true })).toBeVisible();
  await expect(card.getByRole("button", { name: "Remove logo", exact: true })).toBeVisible();
  await expect(card.getByRole("button", { name: "Upload dark logo" })).toBeVisible();

  await accent.fill("#0369a1");
  await expect(card.getByTestId("accent-swatch")).toHaveCSS("border-style", "solid");
});

/** Every Save on the Company page reads "Save", each named for its panel. */
async function expectSaves(page: Page) {
  for (const [scope, name] of [
    [page.locator("#horizons"), "Save horizons"],
    [page.getByTestId("timezone-panel"), "Save time zone"],
    [page.getByTestId("pricing-owner-panel"), "Save pricing owner"],
    [page.getByTestId("branding-panel"), "Save branding"],
  ] as const) {
    await expect(scope.getByRole("button", { name, exact: true })).toHaveText("Save");
  }
  await expect(page.getByRole("button", { name: "Confirm" })).toHaveCount(0);
}

// protects: qa-settings-23, one word for saving on Company (Horizons, Time zone, Pricing
// owner, Branding), each with its own accessible name, and time zones listed in words.
// fails_when: Horizons offers Confirm, Branding says Save branding, or a zone reads as its
// IANA name. no_claim: what each Save stores (setup.spec.ts, pricing.spec.ts, branding.spec.ts).
test("qa-settings-23: Save everywhere and time zones in words", async ({ page }) => {
  await login(page);
  await page.goto("/settings/company");
  await expectSaves(page);
  const zone = page.getByLabel("Company time zone");
  await expect(zone.locator('option[value="America/Los_Angeles"]')).toHaveText("Pacific Time (Los Angeles)");
  const raw = await zone.locator("option").evaluateAll((os) => os.map((o) => o.textContent ?? "").filter((t) => /\w\/\w/.test(t)));
  expect(raw).toEqual([]);
});

test("qa-settings-23: on a phone, the Company page's Saves and Branding fit", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  await page.goto("/settings/company");
  await expectSaves(page);
  const card = page.getByTestId("branding-panel");
  await expect(card.getByRole("button", { name: "Upload logo", exact: true })).toBeVisible();
  await expect(card.getByRole("button", { name: "Upload dark logo", exact: true })).toBeVisible();
  const wide = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  expect(wide).toBe(false);
});
