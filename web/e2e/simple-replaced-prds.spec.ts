import { AREA_PRDS, OLD_PRD } from "../lib/api/mock/one-roadmap";
import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";
import { expect, test, type Locator, type Page } from "./test";

/*
 * simple-replaced-prds (the owner, Nov 4): a PRD marked replaced is history, read in Detailed
 * only; Simple shows only the PRDs that replaced it. Against the mock's "one-roadmap" scenario
 * (web/lib/api/mock/one-roadmap.ts, invented data): Trust plan, replaced by User Safety and
 * Scale, is on no Simple list, picker or filter, and Home's one-pagers card does not count it;
 * its document page in Detailed still names the PRDs that replaced it.
 */

const AREAS = AREA_PRDS.map(([, title]) => title);
const OLD = OLD_PRD[1];

async function open(page: Page, email?: string) {
  await page.context().addInitScript(([key, value]) => localStorage.setItem(key, value), [MOCK_SCENARIO_KEY, "one-roadmap"] as const);
  await login(page, email);
}

/** The mode switch: the rail's on a desktop, Detailed's More sheet on a phone. */
async function toSimple(page: Page, phone: boolean) {
  if (phone) {
    await page.getByTestId("tab-more").click();
    await page.getByTestId("mode-simple-sheet").click();
  } else {
    await page.getByRole("radiogroup", { name: "Mode" }).filter({ visible: true }).getByRole("radio", { name: "Simple" }).click();
  }
}

/** simple-plan's items of Usage alerts and Guided setup (the mock's invented data). */
const GONE = ["Alert rules engine", "Weekly alert digest", "Mobile alert push", "Setup checklist", "Sample data import"];

const optionTexts = async (select: Locator) => (await select.locator("option").allTextContents()).map((t) => t.trim());

for (const [name, viewport] of [["desktop", { width: 1440, height: 900 }], ["phone", { width: 390, height: 844 }]] as const) {
  test.describe(`replaced PRDs in Simple (${name})`, () => {
    test.use({ viewport });

    /**
     * protects = One-pagers lists the two area PRDs and not the replaced one, and Home's
     * "One-pagers to read" shows and counts the same PRDs; fails_when = Trust plan is listed
     * or counted; no_claim = the order of the rows.
     */
    test("One-pagers and Home leave out the replaced PRD", async ({ page }) => {
      await open(page, "viewer@example.com");
      await page.goto("/simple/one-pagers");
      const list = page.getByTestId("simple-one-pagers");
      for (const title of AREAS) await expect(list.getByRole("link", { name: title, exact: true })).toBeVisible();
      await expect(list.getByRole("link", { name: OLD, exact: true })).toHaveCount(0);
      const total = await list.getByTestId("one-pager-row").count();

      await page.goto("/simple");
      const card = page.getByTestId("home-read");
      await expect(card.locator("li").first()).toBeVisible();
      await expect(card.getByRole("link", { name: OLD, exact: true })).toHaveCount(0);
      // The card shows the first few and counts the rest: together, the list's rows.
      const more = card.getByTestId("home-more");
      const counted = async () => (await card.locator("li").count()) + ((await more.count()) ? Number((await more.innerText()).match(/\d+/)![0]) : 0);
      await expect.poll(counted).toBe(total);
    });

    /**
     * protects = the review start sheet's PRD picker and the Decisions page's PRD filter offer
     * the two area PRDs and never the replaced one, while Detailed still reads it with
     * "Replaced by"; fails_when = Trust plan is an option; no_claim = who may start a review.
     */
    test("the start sheet and the Decisions filter offer only the area PRDs", async ({ page }) => {
      await open(page);
      await page.goto("/simple/meetings");
      const start = page.getByRole("button", { name: "Start review" }).first();
      await start.scrollIntoViewIfNeeded();
      await start.click();
      const sheet = page.getByRole("dialog", { name: "Start a review" });
      const picker = sheet.getByLabel("PRD");
      await expect(picker.locator("option", { hasText: AREAS[0] })).toHaveCount(1);
      const offered = await optionTexts(picker);
      for (const title of AREAS) expect(offered).toContain(title);
      expect(offered).not.toContain(OLD);
      await page.keyboard.press("Escape");

      await page.goto("/simple/decisions");
      const filter = page.getByRole("group", { name: "Filters" }).locator("label", { hasText: /^PRD/ }).locator("select");
      await expect(filter.locator("option", { hasText: AREAS[0] })).toHaveCount(1);
      const filters = await optionTexts(filter);
      for (const title of AREAS) expect(filters).toContain(title);
      expect(filters).not.toContain(OLD);

      // Detailed keeps it as history.
      await page.goto(`/documents/${OLD_PRD[0]}`);
      await expect(page.getByText(/Replaced by/).first()).toBeVisible();
    });

    /**
     * protects = the Mode switch on the replaced PRD's page opens One-pagers, never its
     * one-pager, and its one-pager's address names only the PRDs that replaced it, each linking
     * its own one-pager; fails_when = the replaced PRD's one-pager (Start a review meeting,
     * Export PDF) is shown; no_claim = Detailed's page of it.
     */
    test("switching to Simple from the replaced PRD shows no one-pager of it", async ({ page }) => {
      await open(page);
      await page.goto(`/documents/${OLD_PRD[0]}`);
      await expect(page.getByText(/Replaced by/).first()).toBeVisible();
      await toSimple(page, name === "phone");
      await expect(page).toHaveURL(/\/simple\/one-pagers$/);
      const list = page.getByTestId("simple-one-pagers");
      await expect(list.getByRole("link", { name: AREAS[0], exact: true })).toBeVisible();
      await expect(list.getByRole("link", { name: OLD, exact: true })).toHaveCount(0);

      // Its old address (a saved link) names the PRDs that replaced it, and nothing else.
      await page.goto(`/simple/one-pagers/${OLD_PRD[0]}`);
      const replaced = page.getByTestId("one-pager-replaced");
      await expect(replaced).toHaveText(`Replaced by ${AREAS.join(", ")}`);
      await expect(page.getByRole("button", { name: /Start a review meeting/ })).toHaveCount(0);
      await expect(page.getByRole("button", { name: /Export PDF/ })).toHaveCount(0);
      await expect(page.getByRole("link", { name: /Export PDF/ })).toHaveCount(0);
      await replaced.getByRole("link", { name: AREAS[1], exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`/simple/one-pagers/${AREA_PRDS[1][0]}$`));
      await expect(page.getByRole("heading", { name: AREAS[1], level: 1 })).toBeVisible();
      // (The page left may stay mounted, hidden, in the router's cache.)
      await expect(page.getByTestId("one-pager-replaced")).toBeHidden();
    });
  });
}

/** simple-plan: Usage alerts and Guided setup marked replaced by Team workspaces PRD, in Detailed. */
async function replaceInDetailed(page: Page) {
  for (const [slug, title] of [["usage-alerts", "Usage alerts"], ["guided-setup", "Guided setup"]]) {
    await page.goto(`/documents/${slug}`);
    await expect(page.getByRole("heading", { level: 1 }).filter({ visible: true })).toContainText(title);
    await page.getByRole("button", { name: "Replaced by" }).click();
    const dialog = page.getByTestId("replaced-by-dialog");
    await dialog.getByLabel("Team workspaces PRD").check();
    await dialog.getByRole("button", { name: "Save" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByTestId("replaced-by").filter({ visible: true })).toContainText("Replaced by Team workspaces PRD");
  }
}

/**
 * Re-review round 3 (the mock's "simple-plan" invented data): once Usage alerts and Guided setup are
 * marked replaced by Team workspaces, their history stays on Decisions. The Meetings page's
 * "Its decisions" link of the past "Review: Usage alerts" opens that meeting with its decision,
 * and Guided setup's decided question stays outside meetings; only the PRD filter leaves them
 * out. protects = a replaced PRD's past meetings, their decisions and its decided questions on
 * Decisions, reached from the Meetings page, the meeting page's own links and the minutes' Inbox
 * row; and (round 4) Roadmap, its PRD filter and Priorities' Goal buckets leave out the replaced
 * PRDs' items, as the API's service.load does. fails_when = a link lands on an empty page, the
 * decided question is gone, or a replaced PRD's item or filter option shows; no_claim = the
 * replaced PRD's open questions (the API's tests).
 */
test("a replaced PRD's past meeting keeps its decisions", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  // The "simple-plan" scenario: the default data with Guided setup's own PRD document.
  await page.context().addInitScript(([key, value]) => localStorage.setItem(key, value), [MOCK_SCENARIO_KEY, "simple-plan"] as const);
  await login(page);
  await replaceInDetailed(page);

  // Round 4: Roadmap and Priorities' Goal buckets leave out the replaced PRDs' items (service.load).
  await page.goto("/simple/roadmap");
  const prdFilter = page.getByRole("combobox", { name: "PRD", exact: true });
  await expect(page.getByText("New plan tiers").filter({ visible: true }).first()).toBeVisible();
  await expect(prdFilter.locator("option", { hasText: "Plan changes" })).toHaveCount(1);
  expect((await optionTexts(prdFilter)).filter((t) => /Usage alerts|Guided setup/.test(t))).toEqual([]);
  for (const title of GONE) await expect(page.getByText(title, { exact: true }).filter({ visible: true })).toHaveCount(0);
  // Round 8: Key dates names no replaced PRD's milestone (key_dates.key_date_prds reads service.load's entries).
  await page.getByTestId("key-dates-open").filter({ visible: true }).click();
  const keyDates = page.getByTestId("key-dates-editor");
  await expect(keyDates).toBeVisible();
  await expect(keyDates.getByTestId("key-date-from-prd")).toHaveCount(0);
  await expect(keyDates.getByText(/Guided setup|Usage alerts/)).toHaveCount(0);

  await page.goto("/simple/priorities?tab=buckets");
  const buckets = page.getByRole("region", { name: "Goal buckets" });
  // Guided setup's plan goes with its items (priorities.plan_in_play): the buckets read without a plan.
  await expect(buckets.getByText(/^Grouped by goal for this quarter/)).toBeVisible();
  for (const title of GONE) await expect(buckets.getByText(title, { exact: true })).toHaveCount(0);
  // Round 6: with no work this quarter the tab says so in words, never "0 wk in all" over an empty chart.
  await expect(buckets.getByText("Nothing planned this quarter.")).toBeVisible();
  await expect(buckets.getByText(/0 wk in all/)).toHaveCount(0);
  await expect(buckets.getByText("Share of engineer-weeks by goal")).toHaveCount(0);
  // Round 7: "this quarter" is the calendar quarter, never the replaced plan's span
  // (service.build's span is over the shown PRDs' plans only; priorities.plan_quarter).
  await expect(page.getByTestId("prio-subtitle")).toContainText("Q4 2026.");
  await expect(page.getByTestId("prio-subtitle")).not.toContainText("Feb 12");

  // Round 5: Priorities' Ranked list leaves them out too.
  await page.goto("/simple/priorities?tab=ranked");
  const ranked = page.getByRole("list", { name: "Ranked list" }).first();
  await expect(ranked.getByText("New plan tiers").first()).toBeVisible();
  for (const title of GONE) await expect(ranked.getByText(title)).toHaveCount(0);
  await expect(page.getByTestId("prio-subtitle")).toContainText("Q4 2026.");
  // Round 8: the Line picker offers no replaced PRD's milestone "From the PRD"; the track's M1-M3 stay.
  const line = page.getByTestId("line-picker").getByLabel("Line", { exact: true });
  await expect(line).toBeVisible();
  await expect(line.locator("option", { hasText: "This quarter (Now)" })).toHaveCount(1);
  await expect(line.locator("option", { hasText: "Milestone: M1 · Prove it" })).toHaveCount(1);
  await expect(line.locator("option", { hasText: "From the PRD" })).toHaveCount(0);
  await expect(line.locator('option[title*="Guided setup"], option[title*="Usage alerts"]')).toHaveCount(0);

  // Round 5: Needs a decision names none of them: no suggested feature "Looks like" one
  // (additions.reconcile reads service.load), and a proposal on one (Team invite nudges, of
  // Guided setup) leaves with its item, never a nameless "An item" row.
  await page.goto("/simple/roadmap");
  await page.getByTestId("needs-decision").filter({ visible: true }).click();
  const tray = page.getByTestId("decision-tray");
  const suggested = tray.getByTestId("tray-suggested");
  await expect(suggested.getByText("Quiet hours for alerts").first()).toBeVisible();
  for (const title of GONE) await expect(suggested.getByText(title)).toHaveCount(0);
  const pulled = tray.locator("section").filter({ has: page.getByRole("heading", { name: "Pulled in, pending a decision" }) });
  await expect(pulled.getByText(/^None\.$/)).toBeVisible();
  await expect(tray.getByText(/An item/)).toHaveCount(0);
  await expect(tray.getByText(/Team invite nudges/)).toHaveCount(0);

  await page.goto("/simple/meetings");
  const row = page.getByTestId("meetings-past").locator("li").filter({ has: page.getByRole("link", { name: "Review: Usage alerts" }) });
  await row.getByTestId("meetings-its-decisions").click();
  await expect(page).toHaveURL(/\/simple\/decisions\?meeting=/);
  const past = page.getByRole("region", { name: "Review: Usage alerts" });
  await expect(past.getByTestId("decision-row")).toHaveCount(1);
  await expect(past.getByTestId("decision-row").first()).toContainText("D-4 Moved Weekly alert digest");

  // The meeting page's own links: its decision's code, and "Open the Decisions page".
  await page.goto("/simple/meetings");
  await page.getByTestId("meetings-past").getByRole("link", { name: "Review: Usage alerts" }).click();
  await expect(page).toHaveURL(/\/simple\/meetings\/[^/?]+$/);
  await page.getByRole("list", { name: "Decisions taken" }).getByRole("link", { name: "D-4 Moved Weekly alert digest" }).click();
  await expect(page).toHaveURL(/\/simple\/decisions#d-4$/);
  await expect(page.getByTestId("decision-row").filter({ hasText: "D-4 Moved Weekly alert digest" }).filter({ visible: true }).first()).toBeVisible();
  await page.goBack();
  await page.getByRole("status", { name: "Sent" }).getByRole("link", { name: "Open the Decisions page" }).click();
  await expect(page).toHaveURL(/\/simple\/decisions\?meeting=/);
  await expect(past.getByTestId("decision-row").first()).toContainText("D-4 Moved Weekly alert digest");

  // The minutes in the Inbox: Open reads them beside their decision.
  await page.goto("/inbox");
  const minutes = page.getByRole("row").filter({ hasText: "Review: Usage alerts" });
  await expect(minutes).toContainText("Meeting minutes");
  await minutes.getByRole("link", { name: "Open" }).click();
  await expect(page).toHaveURL(/\/simple\/decisions\?meeting=/);
  await expect(past.getByTestId("decision-row")).toHaveCount(1);
  await expect(past.getByTestId("decision-row").first()).toContainText("D-4 Moved Weekly alert digest");

  await page.goto("/simple/decisions");
  await expect(page.getByRole("region", { name: "Outside meetings" })).toContainText("Q1 Data retention period");
  const filter = page.getByRole("combobox", { name: "PRD", exact: true });
  await expect(filter.locator("option", { hasText: "Team workspaces" })).toHaveCount(1);
  const filters = await optionTexts(filter);
  expect(filters.filter((t) => /Usage alerts|Guided setup/.test(t))).toEqual([]);
});

/**
 * Re-review round 6 (simple-plan): a feature added in Simple after the replace is filed under a
 * current PRD (the one that replaced its roadmap's), so it stays in Simple. protects = an
 * accepted suggested feature shows on the Roadmap and on Priorities' Ranked tab (Not ranked yet); fails_when =
 * it is filed under a replaced PRD and left out of both, or its name there opens no feature panel;
 * no_claim = where on the Roadmap it sits.
 */
test("a feature added after a replace stays on the Roadmap and the Ranked tab", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.context().addInitScript(([key, value]) => localStorage.setItem(key, value), [MOCK_SCENARIO_KEY, "simple-plan"] as const);
  await login(page);
  await replaceInDetailed(page);

  await page.goto("/simple/roadmap");
  await expect(page.getByText("New plan tiers").filter({ visible: true }).first()).toBeVisible();
  await page.getByTestId("needs-decision").filter({ visible: true }).click();
  const tray = page.getByTestId("decision-tray");
  const quiet = tray.getByTestId("tray-suggested").getByTestId("goal-suggestion").filter({ hasText: "Quiet hours for alerts" }).first();
  await quiet.getByRole("button", { name: "Accept", exact: true }).click();
  await expect(page.getByText("Added Quiet hours for alerts as a draft")).toBeVisible();
  await tray.getByRole("button", { name: "Close" }).click();
  await expect(tray).toHaveCount(0);
  await expect(page.getByText("Quiet hours for alerts", { exact: true }).filter({ visible: true }).first()).toBeVisible();

  await page.goto("/simple/priorities?tab=ranked");
  const ranked = page.getByRole("list", { name: "Ranked list" }).first();
  await expect(ranked.getByText("New plan tiers").first()).toBeVisible();
  // A draft is not ranked yet (priorities.py _items): it sits under the Ranked list, by its name.
  await expect(page.getByRole("region", { name: "Not ranked yet" }).getByText("Quiet hours for alerts").first()).toBeVisible();
  // Round 7: its name opens the one feature panel, as every other row's does.
  await page.getByRole("region", { name: "Not ranked yet" }).getByRole("button", { name: "Quiet hours for alerts", exact: true }).click();
  const panel = page.getByTestId("item-panel");
  await expect(panel).toHaveAttribute("aria-label", "Quiet hours for alerts");
  await expect(panel.getByText("This feature is not on a roadmap you can see yet.")).toHaveCount(0);
});

/**
 * Re-review round 6: a phone's Roadmap counts a quarter's items in plain words (the default mock
 * data: the onboarding roadmap has one item starting in Q1 2027). protects = "1 item", never
 * "1 items"; fails_when = the count reads "1 items"; no_claim = which quarters show.
 */
test("a phone's Roadmap quarter with one item says 1 item", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  await page.goto("/simple/roadmap?roadmap=onboarding-roadmap");
  const quarters = page.getByTestId("timeline-list").getByTestId("timeline-quarter");
  await expect(quarters.filter({ hasText: "Q1 2027" }).locator("h3")).toHaveText(/· 1 item$/);
  await expect(quarters.filter({ hasText: "Q3 2027" }).locator("h3")).toHaveText(/· 2 items$/);
});
