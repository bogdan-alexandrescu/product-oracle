import { login } from "./helpers";
import { expect, test, type Locator, type Page } from "./test";

/**
 * The fix2-simple-decide review's findings on the meeting screen and its start sheet, driven
 * through the UI on the mock's invented PRD "Guided setup", desktop and phone, light and dark,
 * as the company's owner.
 *
 * End meeting: its confirm has Back focused, so Enter does not end the meeting for everyone.
 * Send: an action item with no words is not dropped silently; the warning goes once the item
 * is filled in or removed, without another Save. Phone: Join, Approve, Move/Cut/Restore, End
 * meeting, the attendee chips and an action item's × are 44 px tall. Plain words: "Presenter
 * plus one or two people"; a person who may not start a review is told whom to ask, with no
 * role names.
 */

const sheet = (page: Page) => page.getByRole("dialog", { name: "Start a review" });

async function tap(l: Locator) {
  await l.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await l.click();
}

async function startReview(page: Page) {
  await login(page);
  await page.goto("/simple/meetings");
  await tap(page.getByRole("button", { name: "Start review" }).first());
  const s = sheet(page);
  await s.getByLabel("PRD").selectOption({ label: "Guided setup" });
  await s.getByRole("checkbox", { name: "Commenter" }).check();
  await expect(s.getByRole("radio", { name: "Presenter plus one or two people" })).toBeVisible();
  await tap(s.getByRole("button", { name: "Start", exact: true }));
  await expect(page.getByRole("heading", { name: "Review: Guided setup" })).toBeVisible();
}

async function endIt(page: Page) {
  await tap(page.getByRole("button", { name: "End meeting" }));
  await page.getByRole("alertdialog").getByRole("button", { name: "End meeting" }).click();
  await expect(page.getByTestId("end-screen")).toBeVisible();
}

const height = async (l: Locator) => (await l.boundingBox())!.height;

for (const phone of [false, true]) {
  for (const scheme of ["light", "dark"] as const) {
    test.describe(`${phone ? "phone" : "desktop"} · ${scheme}`, () => {
      test.use({ viewport: phone ? { width: 390, height: 844 } : { width: 1512, height: 900 }, colorScheme: scheme });

      test("End meeting's confirm: Back has the focus, Enter keeps the meeting on", async ({ page }) => {
        await startReview(page);
        await tap(page.getByRole("button", { name: "End meeting" }));
        const ask = page.getByRole("alertdialog");
        await expect(ask.getByRole("button", { name: "Back" })).toBeFocused();
        await page.keyboard.press("Enter");
        await expect(ask).toHaveCount(0);
        await expect(page.getByRole("timer", { name: "Meeting clock" })).toBeVisible();
        await expect(page.getByTestId("end-screen")).toHaveCount(0);
      });

      test("Send does not drop an empty action item silently; the warning goes once it is filled in", async ({ page }) => {
        await startReview(page);
        await endIt(page);
        const minutes = page.getByRole("region", { name: "Minutes" });
        await tap(minutes.getByRole("button", { name: "Add action item" }));
        const delivery = page.getByRole("region", { name: "Delivery" });
        await tap(delivery.getByRole("button", { name: "Send" }));
        await expect(minutes.getByRole("alert")).toHaveText("Type what the action item is, or remove it.");
        await expect(delivery.getByRole("status", { name: "Sent" })).toHaveCount(0);
        await minutes.getByLabel("Action item 1", { exact: true }).fill("Write the SSO note");
        await expect(minutes.getByRole("alert")).toHaveCount(0);
        await tap(delivery.getByRole("button", { name: "Send" }));
        await expect(delivery.getByRole("status", { name: "Sent" })).toBeVisible();
        await expect(minutes).toContainText("Write the SSO note");
      });

      if (phone) {
        test("phone: the meeting scrolls as the page, with no inner scrolling layer", async ({ page }) => {
          await startReview(page);
          const screen = page.getByTestId("meeting-screen");
          expect((await screen.boundingBox())!.y).toBe(0);
          await page.getByRole("region", { name: "All decisions" }).scrollIntoViewIfNeeded();
          expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
          expect(await screen.evaluate((el) => el.scrollTop)).toBe(0);
        });

        test("phone: the meeting's buttons and chips are 44 px tall", async ({ page }) => {
          await startReview(page);
          expect(await height(page.getByRole("button", { name: "End meeting" }))).toBeGreaterThanOrEqual(44);
          expect(await height(page.getByRole("button", { name: "Commenter is here" }))).toBeGreaterThanOrEqual(44);
          await page.getByRole("button", { name: "Edit line 2" }).click();
          await page.getByLabel("Line 2").fill("A checklist that names the next step");
          await page.getByRole("button", { name: "Save" }).click();
          expect(await height(page.getByRole("button", { name: /^Approve one-pager edits/ }))).toBeGreaterThanOrEqual(44);
          await tap(page.getByRole("navigation", { name: "Steps" }).getByRole("button", { name: "2 Roadmap" }));
          const slice = page.getByRole("region", { name: "Roadmap slice" });
          const first = slice.locator("li").first();
          const title = (await first.locator("strong").innerText()).trim();
          expect(await height(first.getByRole("button", { name: `Cut ${title}` }))).toBeGreaterThanOrEqual(44);
          expect(await height(slice.getByRole("button", { name: /^Move / }).first())).toBeGreaterThanOrEqual(44);
          await tap(first.getByRole("button", { name: `Cut ${title}` }));
          expect(await height(slice.getByRole("button", { name: `Restore ${title}` }))).toBeGreaterThanOrEqual(44);
          await endIt(page);
          const minutes = page.getByRole("region", { name: "Minutes" });
          await tap(minutes.getByRole("button", { name: "Add action item" }));
          const remove = minutes.getByRole("button", { name: "Remove action item 1" });
          expect(await height(remove)).toBeGreaterThanOrEqual(44);
          expect((await remove.boundingBox())!.width).toBeGreaterThanOrEqual(44);
        });
      }
    });
  }
}
