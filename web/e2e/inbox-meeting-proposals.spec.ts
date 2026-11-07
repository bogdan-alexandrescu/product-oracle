import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login, signOut } from "./helpers";
import { expect, test, type Locator, type Page } from "./test";

/**
 * inbox-meeting-proposals: a meeting changes only what it reviews; what it asks for on an item
 * it does not review waits in that item's owner's Inbox. In the mock's "meeting-agenda-owner"
 * scenario the invented PRD Usage alerts has the Welcome video on the Onboarding roadmap, which
 * approver@example.com decides. The owner runs a review of Usage alerts (the Alerts roadmap)
 * and cuts the Welcome video: nothing is cut, and the owner's own Inbox has no row for it.
 *
 * Card inbox-meeting-proposal-accept: protects = the Onboarding roadmap's owner finds one row in
 * their Inbox naming Welcome video, "Cut Welcome video", the meeting and when (month first),
 * counted in "N waiting"; Accept cuts the item (its panel says Cut) and the row leaves the Inbox;
 * fails_when = the Inbox draws no row for the proposal, it has no Accept, or Accept does not cut.
 *
 * Card inbox-meeting-proposal-decline: protects = Decline leaves the item as it was and the row
 * leaves the Inbox; fails_when = Decline cuts it or the row stays. Desktop and phone.
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

/** The owner reviews Usage alerts and cuts the Welcome video, on another roadmap. */
async function cutElsewhere(page: Page) {
  await login(page);
  await page.goto("/simple/meetings");
  await tap(page.getByRole("button", { name: /^Start review/ }).first());
  const sheet = page.getByRole("dialog", { name: "Start a review" });
  await sheet.getByLabel("PRD").selectOption({ label: "Usage alerts PRD" });
  await sheet.getByRole("checkbox", { name: "Theo Brandt" }).check();
  await tap(sheet.getByRole("button", { name: "Start", exact: true }));
  await expect(page.getByRole("heading", { name: "Review: Usage alerts PRD" })).toBeVisible();
  await tap(page.getByRole("navigation", { name: "Steps" }).getByRole("button", { name: "2 Roadmap" }));
  const slice = page.getByRole("region", { name: "Roadmap slice" });
  await tap(slice.getByRole("button", { name: "Cut Welcome video" }));
  await page.getByRole("alertdialog").getByRole("button", { name: "Cut" }).click();
  await expect(slice.getByTestId("roadmap-said")).toHaveText("Welcome video is on another roadmap: sent to its owner to decide.");
}

const proposalRow = (page: Page) => page.getByRole("row").filter({ hasText: "asked for by the meeting" }).filter({ hasText: "Welcome video" });

async function waiting(page: Page): Promise<number> {
  const chip = page.getByText(/^\d+ waiting$/).first();
  await expect(chip).toBeVisible();
  return Number((await chip.textContent())!.split(" ")[0]);
}

/** Welcome video's panel on the Onboarding roadmap, opened from the roadmap as a person would. */
async function openItem(page: Page): Promise<Locator> {
  await page.goto("/simple/roadmap");
  const roadmap = page.getByTestId("simple-roadmap");
  await expect(roadmap).toBeVisible();
  const filters = page.getByRole("button", { name: "Filters", exact: true });
  if (await filters.isVisible()) await tap(filters);
  await page.getByTestId("filter-roadmap").selectOption({ label: "Onboarding roadmap" });
  await expect(roadmap).toContainText("Onboarding roadmap");
  // A phone's Filters sheet closes before the roadmap is tapped, and a tap the closing sheet
  // swallowed is made again until the panel opens.
  const sheet = page.getByRole("dialog", { name: "Filters" });
  if (await sheet.isVisible()) {
    await page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();
  }
  const panel = page.getByRole("dialog").filter({ hasText: "Welcome video" }).last();
  await expect(async () => {
    if (!(await panel.isVisible())) await tap(roadmap.getByRole("button", { name: /^Welcome video/ }).first());
    await expect(panel).toBeVisible({ timeout: 3_000 });
  }).toPass({ timeout: 20_000 });
  return panel;
}

test.beforeEach(async ({ context }) => {
  await context.addInitScript((key) => localStorage.setItem(key, "meeting-agenda-owner"), MOCK_SCENARIO_KEY);
});

for (const phone of [false, true]) {
  const where = phone ? "phone" : "desktop";
  test.describe(where, () => {
    test.use({ viewport: phone ? { width: 390, height: 844 } : { width: 1440, height: 900 } });

    // card: inbox-meeting-proposal-accept
    test(`the roadmap's owner accepts a meeting's cut from their Inbox and the item is cut (${where})`, async ({ page }) => {
      test.setTimeout(90_000);
      await cutElsewhere(page);
      // The meeting's owner does not decide the Onboarding roadmap: no row in their Inbox.
      await page.goto("/inbox");
      await expect(page.getByTestId("inbox-needs")).toBeVisible();
      await expect(proposalRow(page)).toHaveCount(0);

      await switchTo(page, "approver@example.com");
      await page.goto("/inbox");
      const row = proposalRow(page);
      await expect(row).toHaveCount(1);
      await expect(row).toContainText(/Cut Welcome video · asked for by the meeting Review: Usage alerts PRD on [A-Z][a-z]{2} \d{1,2}(, \d{4})?, \d{1,2}:\d{2} [AP]M/);
      const before = await waiting(page);
      await tap(row.getByRole("button", { name: "Accept" }));
      await expect(page.getByText("Accepted: it is in your working draft")).toBeVisible();
      await expect(proposalRow(page)).toHaveCount(0);
      await expect.poll(() => waiting(page).catch(() => 0)).toBe(before - 1);

      // The item is cut, as Accept in Needs a decision cuts it.
      await expect((await openItem(page)).getByTestId("item-cut")).toHaveText(/^Cut on [A-Z][a-z]{2} \d+ by .+/);
    });

    // card: inbox-meeting-proposal-decline
    test(`declining a meeting's cut in the Inbox leaves the item (${where})`, async ({ page }) => {
      test.setTimeout(90_000);
      await cutElsewhere(page);
      await switchTo(page, "approver@example.com");
      await page.goto("/inbox");
      const row = proposalRow(page);
      await expect(row).toHaveCount(1);
      await tap(row.getByRole("button", { name: "Decline" }));
      await expect(page.getByText("Declined: the item is left as it was")).toBeVisible();
      await expect(proposalRow(page)).toHaveCount(0);
      const panel = await openItem(page);
      await expect(panel).toContainText("Welcome video");
      await expect(panel.getByTestId("item-cut")).toHaveCount(0);
    });
  });
}
