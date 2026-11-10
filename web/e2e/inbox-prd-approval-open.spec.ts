import { login, signOut } from "./helpers";
import { expect, test, type Page } from "./test";

/**
 * Card inbox-prd-approval-open (Nov 4): protects = the Inbox's Open on a PRD draft waiting on
 * my approval opens that PRD's one-pager (?draft=<id>), its working-draft banner in sight with
 * Approve focused; Approve there takes the row out of my Inbox; fails_when = Open lands on the
 * roadmap ("No such roadmap"), or the one-pager offers the reviewer no Approve; no_claim = the
 * API's approval rules (api/tests/test_simple_one_pager_api.py).
 *
 * The mock's invented PRD "Guided setup" (./lib/api/mock/simple-one-pager.ts) has the seeded
 * approver as its required reviewer.
 */

const bar = (page: Page) => page.getByRole("status", { name: "Working draft" });

async function switchTo(page: Page, email?: string) {
  const size = page.viewportSize()!;
  await page.setViewportSize({ width: 1366, height: 820 });
  await signOut(page);
  await login(page, email);
  await page.setViewportSize(size);
}

for (const width of [1366, 390]) {
  test(`Open on a PRD draft waiting on me lands on its one-pager with Approve (${width})`, async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width, height: width < 640 ? 844 : 820 });
    // An owner edits a line of Guided setup and sends the draft for approval.
    await login(page);
    await page.goto("/simple/one-pagers/guided-setup");
    await page.getByRole("button", { name: "Edit “A setup checklist that shows" }).click();
    await page.getByLabel("New wording for").fill("A setup checklist with the next two steps");
    await page.getByRole("button", { name: "Save" }).click();
    await expect(bar(page)).toContainText("1 change");
    await bar(page).getByRole("button", { name: "Send for approval…" }).click();
    await page.getByTestId("send-for-approval").getByRole("button", { name: "Send for approval" }).click();
    await expect(bar(page).getByTestId("draft-waits-on")).toContainText("Sent for approval · waiting on");

    // The reviewer opens it from their Inbox.
    await switchTo(page, "approver@example.com");
    await page.goto("/inbox");
    const row = page.getByRole("row").filter({ has: page.getByTestId("simple-approval-context") });
    await expect(row).toHaveCount(1);
    const open = row.getByRole("link", { name: /^Open Guided setup version \d+ to approve it$/ });
    await open.evaluate((el) => el.scrollIntoView({ block: "center" }));
    await open.click();

    await expect(page).toHaveURL(/\/simple\/one-pagers\/guided-setup\?draft=[^&]+$/);
    await expect(page.getByText("No such roadmap")).toHaveCount(0);
    const approve = bar(page).getByRole("button", { name: "Approve" });
    await expect(approve).toBeInViewport();
    await expect(approve).toBeFocused();
    await approve.click();
    await expect(bar(page).getByRole("button", { name: "Approve" })).toHaveCount(0);

    await page.goto("/inbox");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.getByRole("row").filter({ has: page.getByTestId("simple-approval-context") })).toHaveCount(0);
  });
}
