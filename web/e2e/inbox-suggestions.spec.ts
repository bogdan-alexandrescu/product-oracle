import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login, signOut } from "./helpers";
import { expect, test, type Locator, type Page } from "./test";

/**
 * inbox-meeting-proposals fix: everything in Simple waiting on me has its own Inbox row that
 * opens where it is decided. In the mock's "inbox-reviewer" scenario approver@example.com is a
 * required reviewer of the Alerts roadmap, and commenter@example.com's feature ask Bulk export,
 * on no roadmap, waits on the owners.
 *
 * Card inbox-date-suggestion: protects = Oracle's open dates for an item the owner decides are a
 * row naming the item and the dates; Open shows Oracle's dates on the roadmap, and the item's
 * name opens its feature panel; fails_when = no row, or either opens nothing.
 *
 * Card inbox-goal-suggestion: protects = a feature Oracle suggests for Keep alerts quiet is a row
 * naming the feature and the goal; Open shows the goal's suggestions with it; fails_when = no
 * row, or Open does not show it.
 *
 * Card inbox-feature-ask-open: protects = a proposal on no roadmap (a feature ask) still has
 * Open, to Requests; fails_when = no Open.
 *
 * Card inbox-simple-approval: protects = a roadmap version sent for review waits in its required
 * reviewer's Inbox, reached from Simple's rail whose count equals "N waiting": the roadmap by
 * name, the version, who sent it and when (month first); Open goes to the roadmap, where Approve
 * publishes it and the row leaves; fails_when = no row, the counts differ, or Approve is not
 * there. Desktop and phone.
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

async function waiting(page: Page): Promise<number> {
  const chip = page.getByText(/^\d+ waiting$/).first();
  await expect(chip).toBeVisible();
  return Number((await chip.textContent())!.split(" ")[0]);
}

/** Simple's rail (More on a phone) to the Inbox, by a click; returns the count it showed. */
async function openInboxFromRail(page: Page, phone: boolean): Promise<number> {
  await page.goto("/simple");
  let link: Locator;
  let count: Locator;
  if (phone) {
    await tap(page.getByTestId("simple-tab-more"));
    const sheet = page.getByRole("dialog", { name: "More" });
    link = sheet.getByRole("link", { name: "Inbox", exact: true });
    count = sheet.getByTestId("simple-more-inbox-count");
  } else {
    const rail = page.getByTestId("simple-nav");
    link = rail.getByRole("link", { name: "Inbox", exact: true });
    count = rail.getByTestId("simple-nav-inbox-count");
  }
  await expect(count).toBeVisible();
  const n = Number((await count.textContent())!.trim());
  await tap(link);
  await expect(page).toHaveURL(/\/inbox$/);
  return n;
}

/** The owner reads the roadmap (Oracle's dates and goal suggestions are made as it is first read). */
async function readRoadmap(page: Page) {
  await page.goto("/simple/roadmap");
  await expect(page.getByTestId("simple-roadmap")).toBeVisible();
}

const MONTH_FIRST = /[A-Z][a-z]{2} \d{1,2}(, \d{4})?, \d{1,2}:\d{2} [AP]M/;

test.beforeEach(async ({ context }) => {
  await context.addInitScript((key) => localStorage.setItem(key, "inbox-reviewer"), MOCK_SCENARIO_KEY);
});

for (const phone of [false, true]) {
  const where = phone ? "phone" : "desktop";
  test.describe(where, () => {
    test.use({ viewport: phone ? { width: 390, height: 844 } : { width: 1440, height: 900 } });

    // card: inbox-date-suggestion
    test(`Oracle's dates wait in the Inbox; Open shows them on the roadmap and the name opens the feature panel (${where})`, async ({ page }) => {
      test.setTimeout(90_000);
      await login(page);
      await readRoadmap(page);
      await page.goto("/inbox");
      const row = page.getByRole("row").filter({ has: page.getByTestId("date-suggestion-context") }).first();
      await expect(row).toBeVisible();
      await expect(row.getByTestId("date-suggestion-context")).toContainText(/Oracle suggests [A-Z][a-z]{2} \d{1,2}/);
      const name = (await row.getByTestId("feature-name").textContent())!.trim();
      await tap(row.getByRole("link", { name: `Open Oracle's dates for ${name}` }));
      await expect(page).toHaveURL(/\/simple\/roadmap\?.*dates=/);
      await expect(page.getByTestId("suggestion-popover")).toBeVisible();
      await expect(page.getByTestId("suggestion-popover")).toContainText("Oracle suggests");

      await page.goto("/inbox");
      const again = page.getByRole("row").filter({ has: page.getByTestId("date-suggestion-context") }).filter({ hasText: name }).first();
      await tap(again.getByTestId("feature-name"));
      await expect(page).toHaveURL(/\/simple\/roadmap\?.*item=/);
      await expect(page.getByRole("dialog").filter({ hasText: name }).last()).toBeVisible();
    });

    // card: inbox-goal-suggestion
    test(`a goal's suggested feature waits in the Inbox and Open shows the goal's suggestions (${where})`, async ({ page }) => {
      test.setTimeout(90_000);
      await login(page);
      await readRoadmap(page);
      await page.goto("/inbox");
      const row = page.getByRole("row").filter({ hasText: "Oracle suggests it for the goal Keep alerts quiet" }).first();
      await expect(row).toBeVisible();
      await expect(row.getByTestId("goal-suggestion-context")).toContainText(MONTH_FIRST);
      const title = (await row.locator("span[title]").first().getAttribute("title"))!;
      await tap(row.getByRole("link", { name: "Open the suggestions for Keep alerts quiet" }));
      await expect(page).toHaveURL(/\/simple\/roadmap\?.*suggestions=/);
      await expect(page.getByTestId("goal-suggestion").filter({ hasText: title }).first()).toBeVisible();
    });

    // card: inbox-feature-ask-open
    test(`a proposal on no roadmap opens where it is decided (${where})`, async ({ page }) => {
      await login(page);
      await page.goto("/inbox");
      const row = page.getByRole("row").filter({ hasText: "Bulk export" }).filter({ hasText: "asked for by" });
      await expect(row).toHaveCount(1);
      await tap(row.getByRole("link", { name: "Open Bulk export in Requests" }));
      await expect(page).toHaveURL(/\/requests$/);
    });

    // card: inbox-simple-approval
    test(`a version sent for review waits on its required reviewer, who approves it from the Inbox (${where})`, async ({ page }) => {
      test.setTimeout(120_000);
      await login(page);
      // The owner changes the Alerts roadmap and sends it for review (on a desktop, by the keyboard).
      const size = page.viewportSize()!;
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto("/simple/roadmap");
      await page.getByTestId("filter-roadmap").selectOption({ label: "Alerts roadmap" });
      const bar = page.locator('[data-testid="timeline-row"][data-item="alert-export"] [data-testid="timeline-bar"]').first();
      await expect(bar).toBeVisible();
      await bar.focus();
      await page.keyboard.press("ArrowRight");
      await expect(page.getByTestId("draft-count")).toHaveText("1");
      await page.getByTestId("draft-banner").getByRole("button", { name: "Send for review" }).click();
      await expect(page.getByRole("status").filter({ hasText: "Sent for review" })).toBeVisible();
      await page.setViewportSize(size);

      await switchTo(page, "approver@example.com");
      const railCount = await openInboxFromRail(page, phone);
      const row = page.getByRole("row").filter({ has: page.getByTestId("simple-approval-context") });
      await expect(row).toHaveCount(1);
      await expect(row).toContainText(/Alerts roadmap version \d+/);
      await expect(row.getByTestId("simple-approval-context")).toContainText(/^Sent for review by \S.* on /);
      await expect(row.getByTestId("simple-approval-context")).toContainText(MONTH_FIRST);
      // The rail's count is the page's "N waiting", the approval among them.
      expect(await waiting(page)).toBe(railCount);

      await tap(row.getByRole("link", { name: /^Open Alerts roadmap version \d+ to approve it$/ }));
      await expect(page).toHaveURL(/\/simple\/roadmap\?roadmap=/);
      const approval = page.getByTestId("draft-approval");
      await expect(approval).toContainText(/Alerts roadmap version \d+ is waiting for your approval/);
      await tap(approval.getByRole("button", { name: "Approve" }));
      await expect(page.getByText("Approved: Alerts roadmap is published")).toBeVisible();

      await page.goto("/inbox");
      await expect(page.getByTestId("inbox-needs")).toBeVisible();
      await expect(page.getByRole("row").filter({ has: page.getByTestId("simple-approval-context") })).toHaveCount(0);
      await expect.poll(() => waiting(page).catch(() => 0)).toBe(railCount - 1);
    });
  });
}
