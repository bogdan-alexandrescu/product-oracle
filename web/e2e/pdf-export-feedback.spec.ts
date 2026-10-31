import { MOCK_SCENARIO_KEY } from "../lib/api/mock/ids";
import { login } from "./helpers";
import { expect, test, type Page } from "./test";

// e2e-pdf-export (production pass, 2026-10-30): a PDF export tells the person exporting what
// happened, and a one-pager that runs past its page says so to them, not inside the PDF.
//
// Card detailed-pdf-toast: protects = Detailed's Export › Full › PDF starts the download,
//   closes the Export menu and says "PDF downloaded", as the one-pager's Export PDF does;
//   fails_when = the menu stays open or nothing is said; no_claim = the PDF's text (API tests).
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
      await page.getByTestId("version-toolbar").getByRole("button", { name: "Export", exact: true }).click();
      const pdf = page.getByRole("button", { name: "Export PDF", exact: true });
      const download = page.waitForEvent("download");
      await pdf.click();
      expect((await download).suggestedFilename()).toBe("saved-carts-v2.pdf");
      await expect(pdf).toBeHidden();
      await expect(page.getByRole("status").filter({ hasText: "PDF downloaded" })).toBeVisible();
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
