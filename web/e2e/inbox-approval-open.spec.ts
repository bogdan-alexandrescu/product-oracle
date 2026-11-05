import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login, signOut } from "./helpers";
import { expect, test, type Locator, type Page } from "./test";

/**
 * B-QA fix 2, card inbox-approval-open-lands: protects = the Inbox's Open on a roadmap version
 * waiting for my approval goes to the roadmap with ?draft=<that draft>, the one parameter the
 * roadmap reads to bring that draft's banner into sight, and its line with Approve is shown
 * there; fails_when = Open passes a parameter the roadmap does not read (approve=), or the
 * approval line or its Approve is not in sight. Desktop (1440) and phone (390).
 *
 * In the mock's "inbox-reviewer" scenario approver@example.com is a required reviewer of the
 * Alerts roadmap.
 */

async function tap(l: Locator) {
  await l.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await l.click();
}

async function switchTo(page: Page, email: string) {
  const size = page.viewportSize()!;
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/home");
  await signOut(page);
  await login(page, email);
  await page.setViewportSize(size);
}

test.beforeEach(async ({ context }) => {
  await context.addInitScript((key) => localStorage.setItem(key, "inbox-reviewer"), MOCK_SCENARIO_KEY);
});

for (const width of [1440, 390]) {
  test(`Open on a roadmap waiting on me lands on its draft with Approve in sight (${width})`, async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page);
    // The owner changes the Alerts roadmap and sends it for review.
    await page.goto("/simple/roadmap");
    await expect(page.getByTestId("simple-roadmap")).toBeVisible();
    await page.getByTestId("filter-roadmap").selectOption({ label: "Alerts roadmap" });
    const bar = page.locator('[data-testid="timeline-row"][data-item="alert-export"] [data-testid="timeline-bar"]').first();
    await expect(bar).toBeVisible();
    await bar.focus();
    await page.keyboard.press("ArrowRight");
    await expect(page.getByTestId("draft-count")).toHaveText("1");
    await page.getByTestId("draft-banner").getByRole("button", { name: "Send for review" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Sent for review" })).toBeVisible();

    // The required reviewer opens it from their Inbox.
    await page.setViewportSize({ width, height: width < 640 ? 844 : 900 });
    await switchTo(page, "approver@example.com");
    await page.goto("/inbox");
    const row = page.getByRole("row").filter({ has: page.getByTestId("simple-approval-context") });
    await expect(row).toHaveCount(1);
    await tap(row.getByRole("link", { name: /^Open Alerts roadmap version \d+ to approve it$/ }));

    // The link names the draft by the parameter the roadmap reads, and nothing it does not read.
    await expect(page).toHaveURL(/\/simple\/roadmap\?roadmap=[^&]+&draft=[^&]+$/);
    expect(page.url()).not.toContain("approve=");
    const approval = page.getByTestId("draft-approval");
    await expect(approval).toContainText(/Alerts roadmap version \d+ is waiting for your approval/);
    const approve = approval.getByRole("button", { name: "Approve" });
    await expect(approve).toBeVisible();
    await expect(approve).toBeInViewport();
  });
}
