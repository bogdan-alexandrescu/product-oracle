import { login, openSection } from "./helpers";
import { expect, test } from "./test";

/**
 * raw-tokens-everywhere review: a PRD section's Markdown as its writer left it carries a citation
 * of two sources ("[c:r1, r2]"), a spaced one ("[c:front desk notes]"), a live read ("[l:2]"), a
 * source id ("[s:rebook]") and a citation that points to nothing ("[c:r9]"). The mock seeds them in
 * "Visit reminders" (2. Solution).
 *
 * Test card: protects=the section reads as words with a chip for each of its two sources and no
 * "?" chip; fails_when=any "[c:", "[l:" or "[s:" shows, or a source shows no chip, or an unknown
 * citation shows "?"; no_claim=the API's section text (body_text, oracle.docs.parser).
 */

for (const phone of [false, true]) {
  const where = phone ? "phone" : "desktop";
  test.describe(where, () => {
    test.use(phone ? { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true } : { viewport: { width: 1366, height: 820 } });

    test(`a PRD section shows no raw tokens (${where})`, async ({ page }) => {
      await login(page);
      await page.goto("/documents/visit-reminders/v/1");
      const section = await openSection(page, "solution");
      await expect(section).toContainText("Send reminders 24 hours ahead");
      await expect(section).toContainText("R opens the rebook page.");
      await expect(section).toContainText("Front desks see who confirmed");
      const text = await section.innerText();
      expect(text).not.toMatch(/\[[cls]:/);
      await expect(section.getByTestId("cite-r1")).toBeVisible();
      await expect(section.getByTestId("cite-r2")).toBeVisible();
      await expect(section.locator(".cite-chip-missing")).toHaveCount(0);
    });
  });
}
