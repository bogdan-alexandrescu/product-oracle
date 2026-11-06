import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { THEME_KEY } from "../lib/theme";
import { login } from "./helpers";
import { expect, test, type Page } from "./test";

/**
 * A count in a section's heading gets its one-click fix too (owner, Nov 5, 'Fix the heading
 * too'), on the mock's invented PRD "guided-setup" under the "one-pager-heading-count"
 * scenario: its "Later · 8 items" lists six, and its approved version 3 holds the same
 * sections.
 *
 * Test cards (protects / fails_when / no_claim):
 * - protects=an owner's "Use 6" on the heading item sets the heading in the PRD's draft: the
 *   item leaves, the one-pager says "Later · 6 items", Undo brings the item back, and after
 *   "Send for approval" the PRD's next version reads "Later · 6 items" on its full page and
 *   in its outline, under the same section link; fails_when=the heading item has no fix, the
 *   fix leaves the heading as it was, or the next version keeps "8 items"; no_claim=the op's
 *   own rules (api tests/test_simple_one_pager_numbers.py).
 */

const URL = "/simple/one-pagers/guided-setup";
const HEAD = "Numbers disagree in “Later · 8 items”";
const PER = "Numbers disagree in “Targets”";

const look = (page: Page) => page.getByRole("region", { name: "Needs a look" });
const item = (page: Page, text: string) => look(page).getByRole("listitem").filter({ has: page.getByTestId("needs-look-line").getByText(text, { exact: true }) });
const bar = (page: Page) => page.getByRole("status", { name: "Working draft" });

for (const phone of [false, true]) {
  for (const scheme of ["light", "dark"] as const) {
    const where = `${phone ? "phone" : "desktop"}, ${scheme}`;
    test.describe(where, () => {
      test.use({ viewport: phone ? { width: 390, height: 844 } : { width: 1440, height: 900 }, colorScheme: scheme });

      test(`an owner fixes the count in a heading, and the PRD's next version reads it (${where})`, async ({ page }) => {
        await page.context().addInitScript(
          ([sKey, tKey, t]) => {
            localStorage.setItem(sKey, "one-pager-heading-count");
            localStorage.setItem(tKey, t);
          },
          [MOCK_SCENARIO_KEY, THEME_KEY, scheme] as const,
        );
        await page.emulateMedia({ colorScheme: scheme });
        await login(page);
        await page.goto(URL);
        await expect(page.locator("html")).toHaveAttribute("data-theme", scheme);
        await expect(look(page).getByTestId("needs-look-line")).toHaveText([HEAD, PER]);

        // Use 6, then Undo: the item comes back with its fix.
        await item(page, HEAD).getByRole("button", { name: "Use 6" }).click();
        await expect(look(page).getByTestId("needs-look-line")).toHaveText([PER]);
        await expect(look(page).getByRole("status")).toHaveText("Set to 6: “Later · 6 items”");
        await look(page).getByRole("button", { name: "Undo" }).click();
        await expect(look(page).getByTestId("needs-look-line")).toHaveText([HEAD, PER]);

        // Use 6 again, and send the draft for approval: the PRD's next version is imported.
        const use = item(page, HEAD).getByRole("button", { name: "Use 6" });
        if (phone) expect((await use.boundingBox())!.height).toBeGreaterThanOrEqual(44);
        await use.click();
        await expect(look(page).getByRole("status")).toHaveText("Set to 6: “Later · 6 items”");
        await expect(look(page).getByTestId("needs-look-line")).toHaveText([PER]);
        await bar(page).getByRole("button", { name: "Send for approval…" }).click();
        const dialog = page.getByTestId("send-for-approval");
        await dialog.getByRole("button", { name: "Send for approval" }).click();
        await expect(dialog).toBeHidden();

        // The full PRD: its newest version says "Later · 6 items", in the page and its outline.
        await page.getByRole("link", { name: "Open in Detailed" }).click();
        await page.getByRole("link", { name: "Open latest (v4)" }).click();
        await expect(page).toHaveURL(/\/documents\/guided-setup\/v\/4/);
        // Its contents (the outline; on a phone, the Sections list) name the new heading under
        // the same section link, and the section opens with it.
        if (phone) await page.getByRole("button", { name: "Section 1 of 12" }).click();
        const contents = phone ? page.getByRole("dialog", { name: "Sections" }) : page.getByRole("navigation", { name: "Outline" });
        const entry = contents.getByRole("link", { name: "Later · 6 items, Not reviewed" });
        await expect(entry).toHaveAttribute("href", "/documents/guided-setup/v/4#later");
        await expect(contents.getByText("Later · 8 items")).toHaveCount(0);
        await entry.click();
        await expect(page.getByRole("region", { name: "Later · 6 items" }).getByRole("heading", { name: "Later · 6 items" })).toBeVisible();
      });
    });
  }
}
