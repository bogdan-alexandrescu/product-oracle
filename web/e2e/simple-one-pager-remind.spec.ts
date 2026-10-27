import { login, signOut } from "./helpers";
import { expect, test, type Page } from "./test";

/**
 * Remind on a one-pager (owner, 2026-10-26), driven through the UI on the mock's invented
 * PRD "guided-setup" (./lib/api/mock/simple-one-pager.ts, its required reviewer the seeded
 * approver), on desktop and phone, light and dark.
 *
 * Card one-pager-remind: protects = an owner's submitted draft names who it waits on in
 * the working-draft bar, Remind beside it sends the reviewer an Inbox nudge "<name> is
 * waiting for your review of Guided setup" (Open goes to the one-pager), the bar then says
 * "Reminded just now" and, two hours on, "Reminded 2h ago" with no Remind button; a day
 * later Remind is back; fails_when = Remind is missing for the owner, sends nothing, can
 * be pressed twice in a day, or the Inbox row is missing; no_claim = Slack delivery and the
 * API's once-a-day rule (api/tests/test_simple_one_pager_api.py).
 *
 * Card one-pager-remind-roles: protects = the reviewer the draft waits on and a commenter
 * read the bar without Remind; fails_when = a reviewer or a reader is offered Remind;
 * no_claim = the API's 403 (api/tests/test_simple_one_pager_api.py).
 */

const URL = "/simple/prds/guided-setup";
const bar = (page: Page) => page.getByRole("status", { name: "Working draft" });

async function submitted(page: Page) {
  await login(page);
  await page.goto(URL);
  await page.getByRole("button", { name: "Edit line 2" }).click();
  await page.getByLabel("Line 2").fill("A setup checklist with the next two steps");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(bar(page)).toContainText("1 change");
  await bar(page).getByRole("button", { name: "Submit for review" }).click();
  await expect(bar(page).getByTestId("draft-waits-on")).toContainText("waiting on review from");
}

for (const phone of [false, true]) {
  for (const scheme of ["light", "dark"] as const) {
    test.describe(`${phone ? "phone" : "desktop"} · ${scheme}`, () => {
      test.use({ viewport: phone ? { width: 390, height: 844 } : { width: 1366, height: 820 }, colorScheme: scheme });

      test("an owner reminds the waiting reviewer once a day", async ({ page }) => {
        await submitted(page);
        await bar(page).getByRole("button", { name: "Remind" }).click();
        await expect(bar(page).getByTestId("reminded-at")).toHaveText("Reminded just now");
        await expect(bar(page).getByRole("button", { name: "Remind" })).toHaveCount(0);
        await page.clock.fastForward("02:00:00");
        await page.reload();
        await expect(bar(page).getByTestId("reminded-at")).toHaveText("Reminded 2h ago");
        await expect(bar(page).getByRole("button", { name: "Remind" })).toHaveCount(0);

        await signOut(page);
        await login(page, "approver@example.com");
        await page.goto("/inbox");
        const nudge = page.getByText(/is waiting for your review of Guided setup/).first();
        await expect(nudge).toBeVisible();
        await page.goto(URL);
        await expect(bar(page)).toContainText("waiting on review from");
        await expect(bar(page).getByRole("button", { name: "Remind" })).toHaveCount(0);

        await signOut(page);
        await login(page);
        await page.clock.fastForward("23:00:00");
        await page.goto(URL);
        await expect(bar(page).getByRole("button", { name: "Remind" })).toBeVisible();
      });

      test("a commenter reads the bar without Remind", async ({ page }) => {
        await submitted(page);
        await signOut(page);
        await login(page, "commenter@example.com");
        await page.goto(URL);
        await expect(page.getByRole("heading", { level: 1, name: "Guided setup" })).toBeVisible();
        await expect(page.getByRole("button", { name: "Remind" })).toHaveCount(0);
        await expect(page.getByRole("button", { name: "Submit for review" })).toHaveCount(0);
      });
    });
  }
}
