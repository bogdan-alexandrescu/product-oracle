import { login } from "./helpers";
import { expect, test, type Page } from "./test";

/**
 * simple-goalmap OP8 (Nov 12 QA): the Start a review dialog's headings carry their
 * explanation in an (i) beside the heading, not as prose under it, on every page that opens
 * it: Meetings, Roadmap and a PRD's one-pager. Driven through the UI on the mock's invented
 * data (Usage alerts, Guided setup), desktop and phone, as the company's owner.
 */

const TIPS = [
  ["What is reviewed", "The PRD, its roadmap slice, its open decisions"],
  ["Who attends", "The people invited to the review; they see its chat and its decisions."],
  ["Who changes things in the chat", "Who may move dates and edit the plan by asking the review's chat; everyone else can still comment."],
] as const;

const PAGES: [string, string, string][] = [
  ["Meetings", "/simple/meetings", "Start review"],
  ["Roadmap", "/simple/roadmap", "Start review"],
  ["one-pager", "/simple/one-pagers/usage-alerts", "Start a review meeting"],
];

async function openSheet(page: Page, url: string, button: string) {
  await login(page);
  await page.goto(url);
  const start = page.getByRole("button", { name: button }).first();
  await start.scrollIntoViewIfNeeded();
  await start.click();
  const sheet = page.getByRole("dialog", { name: "Start a review" });
  await expect(sheet.getByRole("group", { name: /Who attends/ })).toBeVisible();
  return sheet;
}

for (const phone of [false, true]) {
  test.describe(phone ? "phone" : "desktop", () => {
    test.use({ viewport: phone ? { width: 390, height: 844 } : { width: 1440, height: 900 } });

    for (const [name, url, button] of PAGES) {
      test(`${name}: each heading's explanation is in an (i) beside it`, async ({ page }) => {
        const sheet = await openSheet(page, url, button);
        for (const [heading, words] of TIPS) {
          const tip = sheet.getByRole("button", { name: `About ${heading}` });
          await expect(tip).toBeVisible();
          await expect(tip).toHaveAccessibleDescription(words);
          await expect(sheet.getByText(words, { exact: true })).toBeHidden();
          // Beside its heading: on the heading's line.
          const h = await sheet.locator("h3, legend").filter({ hasText: heading }).boundingBox();
          const t = await tip.boundingBox();
          expect(Math.abs(h!.y + h!.height / 2 - (t!.y + t!.height / 2))).toBeLessThan(14);
          await tip.click();
          await expect(sheet.getByRole("tooltip").filter({ hasText: words })).toBeVisible();
          await tip.click();
        }
      });
    }
  });
}
