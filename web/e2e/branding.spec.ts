import { readFile } from "node:fs/promises";
import { deflateSync } from "node:zlib";

import { expect, test } from "./test";

import { login } from "./helpers";

/**
 * O5 lane 4 (spec-O5 section 4, acceptance criterion 20; owner answer O5-Q8): Settings ›
 * Company › Branding, driven as a person would on the mock layer.
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

// protects: an owner uploads a PNG logo, sees it on a light header and a dark slide, sets
// an accent with a contrast result (a too-light one is refused with the API's message),
// switches the "Made with Product Oracle" mark, and the document page's HTML export then
// carries the logo in its header.
// fails_when: there is no Branding card, the upload or the preview does not work, a
// too-light accent is saved, nothing sticks after a reload, or the export lacks the logo.
// no_claim: the API's image checks and the real renderer (pytest test_branding.py).
test("branding: an owner uploads a logo and sets an accent, and the HTML export shows the logo", async ({ page }) => {
  await login(page);
  await page.goto("/settings/company");
  const card = page.getByTestId("branding-panel");
  await expect(card.getByRole("heading", { name: "Branding" })).toBeVisible();
  await expect(card.getByLabel("Display name")).toHaveValue("Example Co");
  await expect(card.getByLabel("Show 'Made with Product Oracle' on shared pages")).toBeChecked();
  await expect(card.getByTestId("brand-preview-light").locator("img")).toHaveCount(0);

  // An SVG is refused, as the API refuses it.
  await card.getByLabel("Logo", { exact: true }).setInputFiles({
    name: "logo.svg",
    mimeType: "image/svg+xml",
    buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
  });
  await expect(card.getByRole("alert")).toContainText("Upload a PNG, JPEG or WebP");

  await card.getByLabel("Logo", { exact: true }).setInputFiles({ name: "logo.png", mimeType: "image/png", buffer: png(160, 40) });
  const light = card.getByTestId("brand-preview-light").locator("img");
  await expect(light).toHaveAttribute("src", /^data:image\/png;base64,/);
  await expect(card.getByTestId("brand-preview-dark").locator("img")).toHaveAttribute("src", /^data:image\/png;base64,/);
  await expect(card.getByTestId("brand-logo-size")).toHaveText("160 × 40 px");

  await card.getByLabel("Accent").fill("#e0f2fe");
  await expect(card.getByTestId("accent-contrast")).toContainText("Too light");
  await card.getByRole("button", { name: "Save branding" }).click();
  await expect(card.getByRole("alert")).toHaveText("This colour is too light to read on white. Pick a darker one.");
  await card.getByLabel("Accent").fill("#0369a1");
  await expect(card.getByTestId("accent-contrast")).toContainText("5.93:1");
  await card.getByLabel("Show 'Made with Product Oracle' on shared pages").uncheck();
  await card.getByRole("button", { name: "Save branding" }).click();
  await expect(card.getByRole("status")).toHaveText("Saved");

  await page.reload();
  await expect(page.getByTestId("branding-panel").getByLabel("Accent")).toHaveValue("#0369a1");
  await expect(page.getByTestId("branding-panel").getByLabel("Show 'Made with Product Oracle' on shared pages")).not.toBeChecked();
  await expect(page.getByTestId("brand-preview-light").locator("img")).toHaveAttribute("src", /^data:image\/png;base64,/);

  await page.goto("/documents/checkout-redesign/v/2");
  await page.getByRole("button", { name: "Export", exact: true }).click();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export HTML" }).click();
  const html = await readFile((await (await download).path())!, "utf8");
  expect(html).toMatch(/<img class="brand-logo"[^>]*src="data:image\/png;base64,/);
  expect(html).toContain("#0369a1");
  expect(html).not.toContain("Made with Product Oracle");
});

// protects: everyone else reads the company's branding without controls to change it.
// fails_when: a viewer sees Save, an upload control or an editable field.
// no_claim: the API's owner check (pytest).
test("branding: a viewer reads it and cannot change it", async ({ page }) => {
  await login(page, "viewer@example.com");
  await page.goto("/settings/company");
  const card = page.getByTestId("branding-panel");
  await expect(card.getByRole("heading", { name: "Branding" })).toBeVisible();
  await expect(card).toContainText("Example Co");
  await expect(card.getByRole("button", { name: "Save branding" })).toHaveCount(0);
  await expect(card.getByLabel("Logo", { exact: true })).toHaveCount(0);
  await expect(card.getByLabel("Display name")).toHaveCount(0);
});
