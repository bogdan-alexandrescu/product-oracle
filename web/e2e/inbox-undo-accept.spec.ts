import { expect, test, type Locator, type Page } from "./test";

import { login } from "./helpers";

/*
 * D14 follow-up: Undo after Accept, for the same 10 s and the same people (approvers) as
 * Decline's Undo. Accept on section text, Close on "nothing to change" and Merge on a
 * duplicate each say what they did with Undo; Undo puts the row back where it was (New, with
 * its buttons), the counts and the badge follow. Send answer has no Undo: the answer is posted
 * on the comment's thread. The "suggestions" mock is inbox-feedback.spec.ts's seed.
 *
 * Test card: protects=an accepted suggestion can be taken back where it was accepted;
 * fails_when=Undo is missing after Accept, Close or Merge, the row does not come back to New
 * with Accept again, the counts or badge stay, or Send answer offers an Undo it cannot keep;
 * no_claim=the API's refusals (a build using the change, an applied change: api
 * tests/test_undo_accept.py), shown in the same notice as any Undo error.
 */

async function suggestions(page: Page) {
  await page.addInitScript(() => localStorage.setItem("po-mock-scenario", "suggestions"));
  await login(page);
}

const tabs = (page: Page) => page.getByTestId("inbox-state-tabs");
const tab = (page: Page, name: string) => tabs(page).getByRole("tab", { name: new RegExp(`^${name}`) });
const tabCount = async (page: Page, name: string) => Number((await tab(page, name).innerText()).replace(/\D+/g, "") || "0");
const badge = (page: Page) => page.getByTestId(/^(nav|tab)-inbox-badge$/).filter({ visible: true });
const row = (page: Page, text: string, state = "new") =>
  page.getByTestId(`inbox-tab-${state}`).getByTestId("inbox-feedback").locator("tr[data-row]").filter({ hasText: text });
const notice = (page: Page) => page.getByTestId("inbox-acted");
const buttons = (r: Locator) => r.locator("td").last().locator("button, a").allInnerTexts();

const METRIC = "Add a metric that shows the outbound check works";
const QUANTIFY = "Can we quantify the demand from the sales calls?";
const QUESTION = "Who can see a workspace's billing page?";
const REMARK = "The scope reads well as it is.";

async function inbox(page: Page) {
  await page.goto("/inbox");
  await expect(tab(page, "New")).toHaveAttribute("aria-selected", "true");
  await expect(row(page, METRIC)).toHaveCount(1);
}

for (const [width, height] of [
  [1366, 820],
  [390, 844],
] as const) {
  test.describe(`${width} px`, () => {
    test.use({ viewport: { width, height } });

    test("Undo after Accept puts the staged change back in New, with Accept again", async ({ page }) => {
      await suggestions(page);
      await inbox(page);
      const before = Number(await badge(page).innerText());
      const newBefore = await tabCount(page, "New");
      const stagedBefore = await tabCount(page, "Staged");

      await row(page, METRIC).getByRole("button", { name: "Accept", exact: true }).click();
      await expect(notice(page)).toContainText("Staged for draft 6");
      await expect(row(page, METRIC)).toHaveCount(0);
      await expect(tab(page, "Staged")).toHaveText(`Staged${stagedBefore + 1}`);
      await expect(badge(page)).toHaveText(String(before - 1));

      await notice(page).getByRole("button", { name: "Undo" }).click();
      await expect(notice(page)).toHaveCount(0);
      await expect(row(page, METRIC)).toHaveCount(1);
      expect(await buttons(row(page, METRIC))).toEqual(["Accept", "Decline", "Open"]);
      await expect(tab(page, "New")).toHaveText(`New${newBefore}`);
      await expect(tab(page, "Staged")).toHaveText(`Staged${stagedBefore}`);
      await expect(badge(page)).toHaveText(String(before));
    });

    test("Undo after Close and after Merge re-opens the item; Send answer has no Undo", async ({ page }) => {
      await suggestions(page);
      await inbox(page);
      const doneBefore = await tabCount(page, "Done");

      await row(page, REMARK).getByRole("button", { name: "Close", exact: true }).click();
      await expect(notice(page)).toContainText("Nothing to change");
      await expect(tab(page, "Done")).toHaveText(`Done${doneBefore + 1}`);
      await notice(page).getByRole("button", { name: "Undo" }).click();
      await expect(row(page, REMARK)).toHaveCount(1);
      expect(await buttons(row(page, REMARK))).toEqual(["Close", "Decline", "Stage for agents", "Open"]);
      await expect(tab(page, "Done")).toHaveText(`Done${doneBefore}`);

      await row(page, QUANTIFY).getByRole("button", { name: "Merge" }).click();
      await expect(notice(page)).toContainText("Merged");
      await notice(page).getByRole("button", { name: "Undo" }).click();
      await expect(row(page, QUANTIFY)).toHaveCount(1);
      expect(await buttons(row(page, QUANTIFY))).toEqual(["Merge", "Open"]);

      await row(page, QUESTION).getByRole("button", { name: "Send answer" }).click();
      await expect(notice(page)).toContainText("Answer sent");
      await expect(notice(page).getByRole("button", { name: "Undo" })).toHaveCount(0);
      await expect(row(page, QUESTION)).toHaveCount(0);
    });
  });
}
