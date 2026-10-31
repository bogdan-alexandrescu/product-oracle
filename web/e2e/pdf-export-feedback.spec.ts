import { readFile } from "node:fs/promises";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/ids";
import { login } from "./helpers";
import { expect, test, type Page } from "./test";

// e2e-pdf-export (production pass, 2026-10-30): a PDF export tells the person exporting what
// happened, and a one-pager that runs past its page says so to them, not inside the PDF.
//
// Card detailed-pdf-toast: protects = Detailed's Export › Full › PDF starts the download,
//   closes the Export menu and says "PDF downloaded", as the one-pager's Export PDF does;
//   fails_when = the menu stays open or nothing is said; no_claim = the PDF's text (API tests).
// Card export-company-name: protects = an export carries no placeholder company ("Example Co",
//   the seed's) and, once an owner names the company in Settings › Company, that name;
//   fails_when = "Example Co" is printed; no_claim = the PDF's layout (API tests).
// Card branding-asks-for-a-name: protects = Settings › Company › Branding never offers the
//   seed's placeholder as the display name: the field is empty and says exports print no name
//   until one is added, a save without a name or with the placeholder is refused, and an export
//   after an accent-only save still prints no "Example Co"; fails_when = "Example Co" is
//   pre-filled, saved or exported; no_claim = the API's own check (test_pdf_export_text.py).
// Card one-pager-overflow-note: protects = a one-pager that runs to 2 pages downloads and its
//   note says so ("It runs to 2 pages"); fails_when = the note is missing; no_claim = the
//   layout itself (the API's check, test_pdf_export_text.py).

const CARTS = "/documents/saved-carts/v/2";
const ONE_PAGER = "/simple/prds/guided-setup";

for (const [name, viewport] of [
  ["desktop", { width: 1440, height: 900 }],
  ["phone", { width: 390, height: 844 }],
] as const) {
  test.describe(name, () => {
    test.use({ viewport });

    test("Detailed's Export PDF closes the menu and says the PDF downloaded", async ({ page }) => {
      await login(page);
      await page.goto(CARTS);
      await expect(page.getByTestId("document-sections")).toBeVisible();
      // A phone keeps the version's actions behind More.
      if (name === "phone") await page.getByTestId("version-more").click();
      await page.getByRole("button", { name: "Export", exact: true }).click();
      const pdf = page.getByRole("button", { name: "Export PDF", exact: true });
      const download = page.waitForEvent("download");
      await pdf.click();
      expect((await download).suggestedFilename()).toBe("saved-carts-v2.pdf");
      await expect(pdf).toBeHidden();
      await expect(page.getByRole("status").filter({ hasText: "PDF downloaded" })).toBeVisible();
    });

    test("an export carries the company's own name, never the placeholder", async ({ page }) => {
      await login(page);
      const exportHtml = async () => {
        await page.goto(CARTS);
        if (name === "phone") await page.getByTestId("version-more").click();
        await page.getByRole("button", { name: "Export", exact: true }).click();
        const download = page.waitForEvent("download");
        await page.getByRole("button", { name: "Export HTML", exact: true }).click();
        return readFile((await (await download).path())!, "utf8");
      };
      expect(await exportHtml()).not.toContain("Example Co");
      await page.goto("/settings/company");
      const card = page.getByTestId("branding-panel");
      await card.getByLabel("Display name").fill("Northwind Labs");
      await card.getByRole("button", { name: "Save branding" }).click();
      await expect(card.getByRole("status")).toHaveText("Saved");
      const html = await exportHtml();
      expect(html).toContain('<span class="brand-name">Northwind Labs</span>');
      expect(html).not.toContain("Example Co");
    });

    test("Branding asks for the company's name and never offers the placeholder", async ({ page }) => {
      await login(page);
      await page.goto("/settings/company");
      const card = page.getByTestId("branding-panel");
      const field = card.getByLabel("Display name");
      await expect(field).toHaveValue("");
      await expect(card.getByTestId("brand-name-hint")).toHaveText("Exports print no company name until you add one.");
      await card.getByLabel("Accent").fill("#0369a1");
      await card.getByRole("button", { name: "Save branding" }).click();
      await expect(card.getByRole("alert")).toContainText("display name");
      await field.fill("Example Co");
      await card.getByRole("button", { name: "Save branding" }).click();
      await expect(card.getByRole("alert")).toHaveText("“Example Co” is a stand-in name. Type your company's name.");
      await page.goto(CARTS);
      if (name === "phone") await page.getByTestId("version-more").click();
      await page.getByRole("button", { name: "Export", exact: true }).click();
      const download = page.waitForEvent("download");
      await page.getByRole("button", { name: "Export HTML", exact: true }).click();
      expect(await readFile((await (await download).path())!, "utf8")).not.toContain("Example Co");
      await page.goto("/settings/company");
      await field.fill("Northwind Labs");
      await card.getByRole("button", { name: "Save branding" }).click();
      await expect(card.getByRole("status")).toHaveText("Saved");
      await expect(card.getByTestId("brand-name-hint")).toHaveCount(0);
    });

    test("a one-pager that runs past its page says so to the person exporting", async ({ page }) => {
      await overflowing(page);
      await login(page, "viewer@example.com");
      await page.goto(ONE_PAGER);
      await expect(page.getByRole("heading", { level: 1, name: "Guided setup" })).toBeVisible();
      const download = page.waitForEvent("download");
      await page.getByRole("button", { name: "Export PDF" }).click();
      await download;
      const toast = page.getByRole("status").filter({ hasText: "PDF downloaded" });
      await expect(toast).toHaveText("PDF downloaded. It runs to 2 pages: shorten it to fit one.");
    });
  });
}

async function overflowing(page: Page) {
  await page.addInitScript((k) => localStorage.setItem(k, "one-pager-overflow"), MOCK_SCENARIO_KEY);
}
