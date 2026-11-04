import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { ADMIN, login, signOut } from "./helpers";
import { expect, test, type Locator, type Page } from "./test";

/**
 * inbox-meeting-proposals owner: the Inbox lists every Simple proposal waiting on me, not only a
 * meeting's. In the mock's "meeting-agenda-owner" scenario approver@example.com decides the
 * invented Onboarding roadmap. A commenter asks Oracle to rename its Welcome video (a proposal),
 * and the owner's review of Usage alerts cuts it (a meeting's proposal).
 *
 * Card inbox-all-proposals-both: protects = the approver reaches the Inbox from Simple's rail by
 * a click (More on a phone); it has one row for each proposal, each with Accept and Decline: the
 * Ask Oracle one says "asked through Ask Oracle by" the commenter, the meeting's names the
 * meeting, each with its time month first; the rail's Inbox count equals the page's "N waiting";
 * fails_when = the Ask Oracle proposal has no row, a row has no Accept or Decline, the rail has
 * no Inbox, or its count differs from the page's.
 *
 * Card inbox-all-proposals-accept: protects = Accept on the Ask Oracle proposal renames the item
 * on its roadmap and the row leaves, "N waiting" one less; fails_when = Accept does not apply
 * it or the row stays. Desktop and phone.
 */

const WHEN = /on [A-Z][a-z]{2} \d{1,2}(, \d{4})?, \d{1,2}:\d{2} [AP]M/;

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

/** The commenter asks Oracle to rename the Welcome video and proposes it. */
async function askRename(page: Page, phone: boolean) {
  await login(page, "commenter@example.com");
  await page.goto("/simple");
  await tap(page.getByTestId(phone ? "phone-ask" : "simple-ask").filter({ visible: true }).first());
  const ask = page.getByTestId("ask-chat").filter({ visible: true });
  await expect(ask).toBeVisible();
  await ask.getByLabel("Message Oracle").fill("rename Welcome video to Welcome tour");
  await tap(ask.getByRole("button", { name: "Send" }));
  const card = ask.getByTestId("chat-card").filter({ hasText: "Rename Welcome video" });
  await tap(card.getByRole("button", { name: "Propose" }));
  await expect(card.getByTestId("chat-card-outcome")).toContainText("Proposed to");
}

/** The owner reviews Usage alerts and cuts the Welcome video, on another roadmap. */
async function cutInMeeting(page: Page) {
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
  await expect(link).toHaveAccessibleDescription(/waiting on you/);
  const n = Number((await count.textContent())!.trim());
  await tap(link);
  await expect(page).toHaveURL(/\/inbox$/);
  return n;
}

async function waiting(page: Page): Promise<number> {
  const chip = page.getByText(/^\d+ waiting$/).first();
  await expect(chip).toBeVisible();
  return Number((await chip.textContent())!.split(" ")[0]);
}

const askRow = (page: Page) => page.getByRole("row").filter({ hasText: "asked through Ask Oracle by" }).filter({ hasText: "Welcome video" });
const meetingRow = (page: Page) => page.getByRole("row").filter({ hasText: "asked for by the meeting" }).filter({ hasText: "Welcome video" });

test.beforeEach(async ({ context }) => {
  await context.addInitScript((key) => localStorage.setItem(key, "meeting-agenda-owner"), MOCK_SCENARIO_KEY);
});

for (const phone of [false, true]) {
  const where = phone ? "phone" : "desktop";
  test.describe(where, () => {
    test.use({ viewport: phone ? { width: 390, height: 844 } : { width: 1440, height: 900 } });

    // card: inbox-all-proposals-both, inbox-all-proposals-accept
    test(`an Ask Oracle proposal and a meeting's both wait in the Inbox, reached from Simple's rail; Accept applies one (${where})`, async ({ page }) => {
      test.setTimeout(120_000);
      await askRename(page, phone);
      await switchTo(page, ADMIN.email);
      await cutInMeeting(page);

      await switchTo(page, "approver@example.com");
      const badge = await openInboxFromRail(page, phone);
      const ask = askRow(page);
      const meeting = meetingRow(page);
      await expect(ask).toHaveCount(1);
      await expect(meeting).toHaveCount(1);
      await expect(ask).toContainText(/Rename Welcome video/);
      await expect(ask).toContainText(WHEN);
      await expect(meeting).toContainText(/Cut Welcome video · asked for by the meeting Review: Usage alerts PRD/);
      await expect(meeting).toContainText(WHEN);
      for (const row of [ask, meeting]) {
        await expect(row.getByRole("button", { name: "Accept" })).toBeVisible();
        await expect(row.getByRole("button", { name: "Decline" })).toBeVisible();
      }
      // The rail's count is the page's "N waiting".
      const before = await waiting(page);
      expect(badge).toBe(before);

      await tap(ask.getByRole("button", { name: "Accept" }));
      await expect(page.getByText("Accepted: it is in your working draft")).toBeVisible();
      await expect(askRow(page)).toHaveCount(0);
      await expect(meetingRow(page)).toHaveCount(1);
      await expect.poll(() => waiting(page).catch(() => 0)).toBe(before - 1);

      // Accept applied it: the item reads by its new name on its roadmap.
      await page.goto("/simple/roadmap");
      const roadmap = page.getByTestId("simple-roadmap");
      await expect(roadmap).toBeVisible();
      const filters = page.getByRole("button", { name: "Filters", exact: true });
      if (await filters.isVisible()) await tap(filters);
      await page.getByTestId("filter-roadmap").selectOption({ label: "Onboarding roadmap" });
      if (await page.getByRole("dialog", { name: "Filters" }).isVisible()) await page.keyboard.press("Escape");
      await expect(roadmap.getByRole("button", { name: /^Welcome tour/ }).first()).toBeVisible();
    });
  });
}
