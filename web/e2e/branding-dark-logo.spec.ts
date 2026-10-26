import { deflateSync } from "node:zlib";

import { expect, test } from "./test";

import { login } from "./helpers";

/**
 * O5 dark logo (owner decision, 2026-10-26): exports and decks use the dark logo when the
 * theme's background is dark and the logo otherwise; Settings › Company › Branding says which
 * one each built-in theme uses. Driven as a person would on the mock layer.
 */

/** A small solid PNG of `shade`, built here so the test needs no image file. */
function png(width: number, height: number, shade: number): Buffer {
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
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, shade)]);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const BUILT_IN = ["Clean document", "One-page brief", "Editorial memo", "Press release", "Technical spec", "Roadmap board"];

// protects: the Branding preview says, before a dark logo exists, that every export uses the
// logo, and after an owner uploads one, which logo each built-in theme's exports and decks use
// (each built-in theme has a light background, so the logo), and that dark backgrounds take
// the dark logo; removing the dark logo brings the first note back.
// fails_when: the note or the per-theme list is missing, or a theme names the wrong logo.
// no_claim: the luminance rule and the rendered exports (pytest test_branding.py).
test("branding: an owner uploads a dark logo and the preview says which logo each theme uses", async ({ page }) => {
  await login(page);
  await page.goto("/settings/company");
  const card = page.getByTestId("branding-panel");
  await card.getByLabel("Logo", { exact: true }).setInputFiles({ name: "logo.png", mimeType: "image/png", buffer: png(160, 40, 0x33) });
  await expect(card.getByTestId("brand-logo-size")).toHaveText("160 × 40 px");
  const note = card.getByTestId("brand-theme-note");
  await expect(note).toHaveText("With no dark logo, every export and deck uses the logo.");
  await expect(card.getByTestId("brand-theme-logos")).toHaveCount(0);

  await card.getByLabel("Dark logo", { exact: true }).setInputFiles({ name: "dark.png", mimeType: "image/png", buffer: png(160, 40, 0xf0) });
  await expect(card.getByRole("button", { name: "Remove dark logo" })).toBeVisible();
  await expect(note).toHaveText("Exports and decks use the dark logo on a dark background and the logo on a light one.");
  const rows = card.getByTestId("brand-theme-logos").getByRole("listitem");
  await expect(rows).toHaveCount(BUILT_IN.length);
  for (const [i, name] of BUILT_IN.entries()) {
    await expect(rows.nth(i)).toHaveText(`${name}: light background, uses the logo`);
  }

  // It sticks after a reload, for a viewer's eyes as well as the owner's.
  await page.reload();
  await expect(card.getByTestId("brand-theme-logos").getByRole("listitem")).toHaveCount(BUILT_IN.length);

  await card.getByRole("button", { name: "Remove dark logo" }).click();
  await expect(note).toHaveText("With no dark logo, every export and deck uses the logo.");
  await expect(card.getByTestId("brand-theme-logos")).toHaveCount(0);
});
