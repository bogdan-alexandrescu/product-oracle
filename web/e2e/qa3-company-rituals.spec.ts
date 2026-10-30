import { expect, test, type Page } from "./test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";

import { login } from "./helpers";

/*
 * Third QA walk of Company › Rituals and the Company header (qa-company-2, 32..36, 44, 45),
 * on the mock layer (lib/api/mock/rituals.ts, "rituals" scenario), driven through the UI as a
 * person would. Today is Wed Oct 28 2026 in Los Angeles. The Weekly goals check-in meets
 * Mondays 9:00 AM: last on Mon Oct 26 (held, its pre-read lists D-5 under Needs a decision),
 * next on Mon Nov 2. The Monthly roadmap refresh's Tue Nov 3 pre-read was prepared early.
 */

const TODAY = new Date("2026-10-28T17:00:00Z");
const COMMENTER = "commenter@example.com";
const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };

test.use({ timezoneId: "America/Los_Angeles", locale: "en-US" });

const ritualRow = (page: Page, title: string) => page.getByTestId("ritual-row").filter({ hasText: title });
const inspector = (page: Page) => page.getByTestId("ritual-inspector").filter({ visible: true });
const nav = (page: Page) => page.getByRole("navigation", { name: "Company" }).filter({ visible: true });

async function openRituals(page: Page, email?: string) {
  await page.clock.install({ time: TODAY });
  await page.addInitScript((key) => localStorage.setItem(key, "rituals"), MOCK_SCENARIO_KEY);
  await login(page, email);
  await page.goto("/company/rituals");
  await expect(ritualRow(page, "Weekly goals check-in")).toBeVisible();
}

test.describe("desktop", () => {
  test.use({ viewport: DESKTOP });

  test("qa-company-2: after Prepare now the row's Latest pre-read and the panel's newest occurrence are the same Nov 2 pre-read", async ({ page }) => {
    // protects=qa-company-2; fails_when=the row reads "None yet" or an older date beside
    // "Pre-read ready" while the panel lists Nov 2 as Ready; no_claim=the API's last_pre_read.
    await openRituals(page);
    await ritualRow(page, "Weekly goals check-in").click();
    await expect(inspector(page)).toContainText("Weekly goals check-in");
    await inspector(page).getByRole("button", { name: "Prepare now" }).click();
    await expect(page).toHaveURL(/\/company\/rituals\/[0-9a-f-]{36}$/);
    const occurrence = new URL(page.url()).pathname;

    await page.getByRole("link", { name: "← Rituals" }).click();
    await expect(page).toHaveURL(/\/company\/rituals$/);
    const row = ritualRow(page, "Weekly goals check-in");
    await expect(row.getByTestId("next-pre-read")).toHaveText("Pre-read ready");
    await expect(row).not.toContainText("None yet");
    const latest = row.getByTestId("last-pre-read");
    await expect(latest).toHaveText("Nov 2, 2026");
    await expect(latest).toHaveAttribute("href", occurrence);
    await expect(page.getByRole("columnheader", { name: "Latest pre-read" })).toBeVisible();

    await row.click();
    const newest = inspector(page).getByTestId("ritual-occurrences").getByRole("listitem").first();
    await expect(newest.getByRole("link")).toHaveText("Nov 2, 2026");
    await expect(newest.getByRole("link")).toHaveAttribute("href", occurrence);
    await expect(newest).toContainText("Ready");
  });

  for (const scheme of ["light", "dark"] as const) {
    test(`qa-company-32 (${scheme}): the selected row's State chip is the same pill as on the other rows`, async ({ page }) => {
      // protects=qa-company-32; fails_when=the selected row's "On" chip has no edge and melts
      // into the row's blue tint (the green and blue tints are near alike); no_claim=colours.
      await page.emulateMedia({ colorScheme: scheme });
      await openRituals(page);
      await ritualRow(page, "Weekly goals check-in").click();
      await expect(ritualRow(page, "Weekly goals check-in")).toHaveAttribute("aria-selected", "true");
      const style = (title: string) =>
        ritualRow(page, title)
          .getByTestId("ritual-state")
          .evaluate((el) => {
            const s = getComputedStyle(el);
            return { bg: s.backgroundColor, edge: s.boxShadow, text: el.textContent };
          });
      const selected = await style("Weekly goals check-in");
      const other = await style("Monthly roadmap refresh");
      expect(selected.text).toBe("On");
      expect(selected.edge).not.toBe("none");
      expect(selected).toEqual(other);
    });
  }

  test("qa-company-34: an occurrence keeps the Company title and tabs, then its own heading", async ({ page }) => {
    // protects=qa-company-34; fails_when="← Rituals" and the ritual's name sit above the tabs
    // in place of "Company"; no_claim=the blocks.
    await openRituals(page);
    await ritualRow(page, "Monthly roadmap refresh").getByTestId("next-pre-read").click();
    await expect(page).toHaveURL(/\/company\/rituals\/[0-9a-f-]{36}$/);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Company");
    await expect(nav(page).getByTestId("company-tab-rituals")).toHaveAttribute("aria-current", "page");
    const title = page.getByRole("heading", { level: 2, name: "Monthly roadmap refresh" });
    await expect(title).toBeVisible();
    const tabs = (await nav(page).boundingBox())!;
    const back = (await page.getByRole("link", { name: "← Rituals" }).boundingBox())!;
    const h = (await title.boundingBox())!;
    expect(back.y).toBeGreaterThanOrEqual(tabs.y + tabs.height);
    expect(h.y).toBeGreaterThan(back.y);
  });

  test("qa-company-35: the pre-read says once when its data is from, not on every block", async ({ page }) => {
    // protects=qa-company-35; fails_when="Data as of" repeats on each of the four blocks.
    await openRituals(page);
    await ritualRow(page, "Weekly goals check-in").getByTestId("last-pre-read").click();
    const blocks = page.getByTestId("ritual-block");
    await expect(blocks).toHaveCount(4);
    await expect(page.getByTestId("occurrence-as-of")).toHaveText(/^Data as of \w{3}, \w{3} \d+, \d+:\d{2} (AM|PM)$/);
    await expect(page.locator("main").getByText(/Data as of/)).toHaveCount(1);
    for (const b of await blocks.all()) await expect(b).not.toContainText("Data as of");
  });

  test("qa-company-36: Needs a decision's D-5 reads as a link and opens D-5 in Decisions", async ({ page }) => {
    // protects=qa-company-36; fails_when=D-5 is drawn in the body text's colour (reads as plain
    // text) or does not open /company/decisions?d=5 with D-5 selected.
    await openRituals(page);
    await ritualRow(page, "Weekly goals check-in").getByTestId("last-pre-read").click();
    const block = page.locator('[data-testid="ritual-block"][data-key="needs_decision"]');
    const link = block.getByRole("link", { name: "D-5 Ship usage caps before anomaly detection" });
    await expect(link).toHaveAttribute("href", "/company/decisions?d=5");
    const [linkColor, textColor] = await Promise.all([
      link.evaluate((el) => getComputedStyle(el).color),
      block.getByRole("heading").evaluate((el) => getComputedStyle(el).color),
    ]);
    expect(linkColor).not.toBe(textColor);
    await link.click();
    await expect(page).toHaveURL(/\/company\/decisions\?d=5$/);
    await expect(page.getByTestId("decision-inspector").filter({ visible: true })).toContainText("Ship usage caps before anomaly detection");
  });

  test("qa-company-45: a commenter's View only names its tab", async ({ page }) => {
    // protects=qa-company-45; fails_when=a bare "View only" beside "Company" reads as if all of
    // Company were read-only; no_claim=which tabs a commenter may change.
    await openRituals(page, COMMENTER);
    await expect(page.getByTestId("view-only").filter({ visible: true })).toHaveText("View only: Rituals");
    await nav(page).getByTestId("company-tab-strategy").click();
    await expect(page).toHaveURL(/\/company\/strategy$/);
    await expect(page.getByTestId("view-only").filter({ visible: true })).toHaveText("View only: Strategy");
  });
});

test.describe("phone", () => {
  test.use({ viewport: PHONE });

  test("qa-company-33 (phone): no row is marked until its sheet opens, and the sheet names the ritual once", async ({ page }) => {
    // protects=qa-company-33; fails_when=the first row is tinted as selected with no panel
    // shown, or the sheet repeats the title under "Ritual · selected".
    await openRituals(page);
    const marked = page.locator('[data-testid="ritual-row"][aria-selected="true"]');
    await expect(marked).toHaveCount(0);
    await ritualRow(page, "Investor update").click();
    const sheet = page.getByTestId("ritual-sheet");
    await expect(sheet).toBeVisible();
    await expect(sheet.getByText("Investor update", { exact: true })).toHaveCount(1);
    await expect(sheet).not.toContainText("selected");
    await expect(marked).toHaveCount(1);
    await page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();
    await expect(marked).toHaveCount(0);
  });

  test("qa-company-34 (phone): an occurrence's top bar says Company, its own heading names it once", async ({ page }) => {
    // protects=qa-company-34; fails_when=the ritual's name shows both in the top bar and as the page's title.
    await openRituals(page);
    await ritualRow(page, "Monthly roadmap refresh").getByTestId("next-pre-read").click();
    await expect(page).toHaveURL(/\/company\/rituals\/[0-9a-f-]{36}$/);
    await expect(page.getByRole("heading", { level: 2, name: "Monthly roadmap refresh" })).toBeVisible();
    await expect(page.getByTestId("phone-title")).not.toContainText("Monthly roadmap refresh");
    await expect(nav(page).getByTestId("company-tab-rituals")).toHaveAttribute("aria-current", "page");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });

  test("qa-company-44 (phone): every Company tab and Market sub-tab shows, and the add button says what it adds", async ({ page }) => {
    // protects=qa-company-44; fails_when=tabs hide behind a scrolling strip, or the header's
    // add action is a bare "+"; no_claim=which line each tab lands on.
    await openRituals(page);
    for (const key of ["strategy", "decisions", "rituals", "updates", "metrics", "market"]) {
      await expect(nav(page).getByTestId(`company-tab-${key}`)).toBeInViewport({ ratio: 1 });
    }
    const add = page.getByRole("button", { name: "Add ritual", exact: true }).filter({ visible: true });
    await expect(add).toHaveText("Ritual");
    await add.click();
    await expect(page.getByRole("form", { name: "Add ritual" })).toBeVisible();

    await nav(page).getByTestId("company-tab-market").click();
    await expect(page).toHaveURL(/\/company\/market$/);
    const sub = page.getByRole("tablist", { name: "Market" });
    for (const name of ["Alternatives", "Change log", "Pricing", "Win and loss"]) {
      await expect(sub.getByRole("tab", { name })).toBeInViewport({ ratio: 1 });
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
});
