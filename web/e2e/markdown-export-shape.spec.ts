import { readFileSync } from "node:fs";

import { expect, test } from "./test";

import { login } from "./helpers";

// The full Markdown export from the version page's Export menu reads as the API writes it.
// api/oracle/export/render.py render_markdown (X-17): "The stored markdown as plain markdown:
// no banner comment, its days month first ("Nov 30, 2026") as in the HTML, PDF and deck. [...]
// Its [c:id] citations are Markdown footnotes ([^1], defined at the end), never raw markers";
// each definition is the source's title and where it is (api/oracle/raw_tokens.py citation_labels:
// "Customer interview notes (upload: notes.pdf)").

const TECH_BRIEF = "/documents/checkout-redesign-early-shipping-cost-spec/v/2";

test.use({ viewport: { width: 1440, height: 900 } });

test("markdown export: no banner line, days month first, citations as footnotes", async ({ page }) => {
  await login(page);
  await page.goto(TECH_BRIEF);
  await expect(page.getByTestId("document-sections")).toBeVisible();
  await page.getByTestId("version-toolbar").getByRole("button", { name: "Export", exact: true }).click();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export Markdown (.md)" }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe("checkout-redesign-early-shipping-cost-spec-v2.md");
  const md = readFileSync((await file.path())!, "utf8");

  // No banner comment: the file starts with its front matter, so it imports again.
  expect(md).not.toContain("<!-- ");
  expect(md.startsWith("---\n")).toBe(true);
  expect(md).toContain("{#spec}");

  // A day in the text reads month first, never ISO.
  expect(md).toContain("approved Oct 17, 2026.");
  expect(md).not.toContain("approved 2026-10-17");

  // The first citation is footnote 1, in the text and defined at the end; no raw marker is left.
  expect(md).toContain("(version 1)[^1].");
  expect(md).toMatch(/\n\[\^1\]: Checkout redesign PRD, version 1 \(upload: \/documents\/checkout-redesign\/v\/1\)\n?$/m);
  expect(md).not.toMatch(/\[c:/);
});
