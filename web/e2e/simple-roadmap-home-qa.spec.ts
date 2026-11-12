import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login, openRoadmapItem } from "./helpers";
import { expect, test, type Locator, type Page } from "./test";

/*
 * Pre-demo QA on Simple's Roadmap and Home, against the mock's default scenario (Weekly alert
 * digest starts before Alert rules engine ends and ends after its milestone Beta; In-app tour is
 * cut with Welcome video depending on it; Team invite nudges is a draft with no owner).
 * S-1 a viewer opens the feature panel from a row; S-5 one broken-link count everywhere; S-6 the
 * Needs a decision panel's titles, its unowned draft and its count; S-14 an item's breaks under
 * it; S-11 the plan's row label whole; S-12 the Waterfall's labels apart; G-8 a viewer's
 * suggestions; Demo 6 the sent state; Demo 8 the draft's time; S-10 Home's prose behind an (i).
 */

const DESKTOP = { viewport: { width: 1440, height: 900 } };
const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true };
const VIEWER = "viewer@example.com";

async function roadmap(page: Page, email?: string, scenario?: string) {
  if (scenario) await page.addInitScript(([key, value]) => localStorage.setItem(key, value), [MOCK_SCENARIO_KEY, scenario] as const);
  await login(page, email);
  await page.goto("/simple/roadmap");
  await expect(page.getByTestId("simple-roadmap")).toBeVisible();
}

async function home(page: Page, email?: string) {
  await login(page, email);
  await page.goto("/simple");
  await expect(page.getByTestId("home-plan")).toBeVisible();
}

const card = (page: Page) => page.getByTestId("floating-card");
const tray = (page: Page) => page.getByTestId("decision-tray");
const strip = (page: Page) => page.getByTestId("conflicts");

async function stripCount(page: Page): Promise<number> {
  const words = (await strip(page).innerText()).split("\n")[0];
  return Number(/(\d+) broken link/.exec(words)?.[1] ?? NaN);
}

const overlap = (a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

test.describe("desktop", () => {
  test.use(DESKTOP);

  test("S-1: a viewer opens the read-only feature panel from a row's title and its bar", async ({ page }) => {
    // protects: a viewer on desktop opens the Weekly alert digest panel by clicking its Roadmap row title, its row bar and its Gantt bar, and it says "You can read this feature"
    // fails_when: a click opens no panel, the panel lacks the feature's name or the read-only line, or Escape leaves it open
    // no_claim: that the viewer is blocked from every edit in the panel; the phone is the S-1 phone test
    await roadmap(page, VIEWER);
    const row = page.locator('[data-testid="timeline-row"][data-item="alert-digest"]');
    await row.getByText("Weekly alert digest", { exact: true }).click();
    await expect(card(page)).toBeVisible();
    await expect(card(page)).toContainText("Weekly alert digest");
    await expect(card(page)).toContainText("You can read this feature");
    await page.keyboard.press("Escape");
    await expect(card(page)).toHaveCount(0);
    await row.getByTestId("timeline-bar").first().click();
    await expect(card(page)).toContainText("Weekly alert digest");
    await page.keyboard.press("Escape");
    await page.getByTestId("format-gantt").click();
    const bar = page.locator('g[data-testid="bar"][data-item="alert-digest"] rect[data-body]');
    await bar.scrollIntoViewIfNeeded();
    const b = (await bar.boundingBox())!;
    await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
    await expect(card(page)).toContainText("You can read this feature");
  });

  test("S-5: Home, the side menu and the Roadmap count the same broken links, each leading to them", async ({ page }) => {
    // protects: in the default scenario Home's broken-links tile reads 3 and the Home list, the Roadmap's broken-links strip, and the Needs a decision counter and its list all show the same 3; the Home tile scrolls to the list
    // fails_when: any of these counts differs from the tile or from 3, or the tile does not bring the list into view
    // no_claim: that the three links are the right ones or that a fix works; the phone is a separate test
    await home(page);
    const tile = page.getByTestId("home-summary-broken-links");
    const n = Number((await tile.locator(".simple-number").innerText()).trim());
    // Weekly alert digest's two breaks and In-app tour's cut.
    expect(n).toBe(3);
    await expect(page.getByTestId("home-broken")).toHaveCount(n);
    await tile.click();
    await expect(page.getByTestId("home-broken-links")).toBeInViewport();
    await page.goto("/simple/roadmap");
    await expect(page.getByTestId("simple-roadmap")).toBeVisible();
    expect(await stripCount(page)).toBe(n);
    await expect(strip(page).getByTestId("conflict")).toHaveCount(n);
    await page.getByTestId("needs-decision").click();
    const links = tray(page).getByTestId("tray-counter").filter({ hasText: "Broken links" });
    await expect(links.locator("b")).toHaveText(String(n));
    await expect(tray(page).getByTestId("tray-broken").getByTestId("fixes")).toHaveCount(n);
  });

  test("S-6: Needs a decision opens each item's panel, gives the unowned draft its action, and counts what it lists", async ({ page }) => {
    // protects: the Needs a decision tiles add up to the button's number and its "to decide" line; the Suggested features tile matches its list and scrolls to it; the ownerless draft Team invite nudges offers "Pick an owner", which opens its panel; a broken link's title opens its panel
    // fails_when: a count differs from what the tray lists, the tile does not lead to its list, the draft has no owner action, or a title opens no panel
    // no_claim: that an owner is actually saved (only the panel opening is checked); the phone is a separate test
    await roadmap(page);
    const button = page.getByTestId("needs-decision");
    await button.click();
    const suggestion = tray(page).getByTestId("tray-suggested").getByTestId("goal-suggestion");
    await expect(suggestion.first()).toBeVisible();
    // Review: the suggested features have a tile of their own, so the tiles add up to the button.
    const suggestedTile = tray(page).getByTestId("tray-counter").filter({ hasText: "Suggested features" });
    await expect(suggestedTile.locator("b")).toHaveText(String(await suggestion.count()));
    let total = 0;
    for (const t of await tray(page).getByTestId("tray-counter").locator("b").all()) total += Number(await t.innerText());
    await expect(button).toContainText(`· ${total}`);
    await expect(tray(page).getByTestId("tray-scope")).toContainText(`${total} to decide`);
    // Its tile leads to them.
    await suggestedTile.getByRole("button").click();
    await expect(tray(page).getByRole("heading", { name: "Suggested features" })).toBeInViewport();
    // The unowned draft: its owner is picked in its panel.
    const flag = tray(page).getByTestId("tray-flag").filter({ hasText: "Team invite nudges" });
    await expect(flag).toContainText("Draft with no owner");
    await flag.getByRole("button", { name: "Pick an owner" }).click();
    await expect(tray(page)).toHaveCount(0);
    await expect(card(page)).toContainText("Team invite nudges");
    await page.keyboard.press("Escape");
    // A broken link's title opens its panel.
    await button.click();
    await tray(page).getByTestId("tray-broken").getByRole("button", { name: "Weekly alert digest" }).click();
    await expect(card(page)).toContainText("Weekly alert digest");
  });

  test("S-14: the Roadmap's broken links show an item's second break under its first, as Home does", async ({ page }) => {
    // protects: the Roadmap's broken-links strip shows Weekly alert digest as one group with two breaks, the second below the first with its reason showing, inside a 2 px left rule
    // fails_when: the item is split into two groups or has another number of breaks, the second sits beside or above the first, its reason is hidden, or the rule is missing
    // no_claim: the full wording of each break's reason (only that the first mentions "starts"); Home's grouping is the next test
    await roadmap(page);
    const group = strip(page).getByTestId("conflict-group").filter({ hasText: "Weekly alert digest" });
    await expect(group).toHaveCount(1);
    const breaks = group.getByTestId("conflict");
    await expect(breaks).toHaveCount(2);
    await expect(breaks.first()).toContainText("starts");
    await expect(breaks.nth(1).getByTestId("conflict-why")).toBeVisible();
    expect(await group.locator("ul").first().evaluate((el) => getComputedStyle(el).borderLeftWidth)).toBe("2px");
    const [a, b] = [(await breaks.first().boundingBox())!, (await breaks.nth(1).boundingBox())!];
    expect(b.y).toBeGreaterThanOrEqual(a.y + a.height - 1);
  });

  test("S-14, S-11, S-10: Home groups an item's breaks, shows the plan's labels whole, and keeps its explanations behind an (i)", async ({ page }) => {
    // protects: Home groups Weekly alert digest's two breaks in one item (the second reads "Ends Dec 10, after its milestone Beta") with a 2 px rule; plan labels are whole, not cut; goal weight reads "N% of the score" with an info button; the long explanations stay hidden
    // fails_when: the breaks are split, the Dec 10 line or the rule is missing, a label is cut or shows dots, the explanation text shows in the open, or the proposed goals do not read "1 proposed goal"
    // no_claim: that the info button opens the right text (it is only seen, never opened); the phone's wrapping is a separate test
    await home(page);
    const digest = page.getByTestId("home-broken-item").filter({ hasText: "Weekly alert digest" });
    await expect(digest).toHaveCount(1);
    await expect(digest.getByTestId("home-broken")).toHaveCount(2);
    await expect(digest.getByTestId("home-broken").nth(1)).toContainText("Ends Dec 10, after its milestone Beta");
    const rule = await digest.getByTestId("home-broken-breaks").evaluate((el) => getComputedStyle(el).borderLeftWidth);
    expect(rule).toBe("2px");
    for (const label of await page.getByTestId("home-strip-label").all()) {
      expect(await label.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
      expect(await label.evaluate((el) => getComputedStyle(el).textOverflow)).not.toBe("ellipsis");
    }
    await expect(page.getByTestId("home-goal-weight").first()).toHaveText(/^\d+% of the score$/);
    await expect(page.getByRole("button", { name: "About the goal's share of the score" }).first()).toBeVisible();
    await expect(page.getByText("Counts for", { exact: false }).filter({ visible: true })).toHaveCount(0);
    await expect(page.getByTestId("home-goals-proposed")).toHaveText("1 proposed goal");
    await expect(page.getByText("is not shown here until", { exact: false }).filter({ visible: true })).toHaveCount(0);
  });

  test("S-12: on the Waterfall, + Milestone keeps off the key dates' names and the label rows stand apart", async ({ page }) => {
    // protects: on the Waterfall the "+ Milestone" hint box overlaps no key-date or milestone name, and names that share horizontal space sit at least 2 px apart vertically
    // fails_when: the hint is drawn over a name, or two names that line up sideways are closer than 2 px or touch
    // no_claim: exact positions or looks; other chart formats and the phone are not checked
    await roadmap(page);
    await page.getByTestId("format-waterfall").click();
    await expect(page.getByTestId("simple-chart")).toHaveAttribute("data-format", "waterfall");
    const hint = (await page.getByTestId("ms-add-hint").boundingBox())!;
    const labels = page.locator('[data-testid="key-date-label"], [data-testid="track-milestone"] text');
    const boxes = [];
    for (const l of await labels.all()) boxes.push((await l.boundingBox())!);
    expect(boxes.length).toBeGreaterThan(1);
    for (const b of boxes) expect(overlap(hint, b), "+ Milestone over a name").toBe(false);
    // Each name clears the others by at least 2 px.
    for (let i = 0; i < boxes.length; i++)
      for (let j = i + 1; j < boxes.length; j++) {
        const [a, b] = [boxes[i], boxes[j]];
        if (a.x < b.x + b.width && b.x < a.x + a.width) expect(Math.max(b.y - (a.y + a.height), a.y - (b.y + b.height))).toBeGreaterThanOrEqual(2);
      }
  });

  test("G-8: a viewer reads the suggested features but is not offered to ask for one; the owner is", async ({ page }) => {
    // protects: a viewer sees "N suggested feature" counters on the Roadmap's goals, none reads "Suggest a feature", and clicking a suggestion counter opens a dialog that mentions Oracle
    // fails_when: the viewer is offered "Suggest a feature", no suggestion counter shows, or the click opens no dialog
    // no_claim: what the dialog lists beyond the word Oracle; despite the title the owner's side is checked in the next test, not here
    await roadmap(page, VIEWER);
    const counters = page.getByTestId("goal-counter-suggestions");
    await expect(counters.filter({ hasText: /\d+ suggested feature/ }).first()).toBeVisible();
    await expect(counters.filter({ hasText: "Suggest a feature" })).toHaveCount(0);
    await counters.filter({ hasText: /\d+ suggested feature/ }).first().click();
    await expect(page.getByRole("dialog").filter({ hasText: "Oracle" }).first()).toBeVisible();
  });

  test("G-8: the owner is offered to suggest a feature for a goal with none", async ({ page }) => {
    // protects: the default owner sees a "Suggest a feature" counter on at least one goal on the Roadmap
    // fails_when: no goal counter offers "Suggest a feature" to the owner
    // no_claim: that the offer works when clicked, or that it shows only on goals with none
    await roadmap(page);
    await expect(page.getByTestId("goal-counter-suggestions").filter({ hasText: "Suggest a feature" }).first()).toBeVisible();
  });

  test("Demo 6, Demo 8: the banner's time reads month first in the company zone; once sent it says whom it waits on", async ({ page }) => {
    // protects: in the two-drafts scenario, after "Bring it back" the draft banner says "since" a month-first time with a zone like "Nov 5, 2026, 2:49 PM PST"; "Send for review" turns it into "Sent for review: it waits for Priya Raman to approve", the button goes, and this survives a reload
    // fails_when: the time is ISO, has no zone or reads day first, the sent line or the named person is missing, the button stays, or a reload loses the state
    // no_claim: the exact date or zone (only their shape); that anyone is told of the request
    await roadmap(page, undefined, "roadmap-two-drafts");
    await strip(page).locator('[data-testid="conflict"][data-item="setup-tour"]').getByRole("button", { name: "Bring it back" }).click();
    const banner = page.getByTestId("draft-banner");
    await expect(banner.getByTestId("draft-words")).toContainText(/since [A-Z][a-z]{2} \d{1,2}, \d{4}, \d{1,2}:\d{2} [AP]M [A-Z]{2,5}/);
    await banner.getByRole("button", { name: "Send for review" }).click();
    await expect(banner.getByTestId("draft-next")).toContainText("Sent for review: it waits for Priya Raman to approve");
    await expect(banner.getByRole("button", { name: "Send for review" })).toHaveCount(0);
    await page.reload();
    await expect(banner.getByTestId("draft-next")).toContainText("Sent for review: it waits for Priya Raman to approve");
    await expect(banner.getByRole("button", { name: "Send for review" })).toHaveCount(0);
  });
});

test.describe("phone", () => {
  test.use(PHONE);

  async function tap(l: Locator) {
    await l.evaluate((el) => el.scrollIntoView({ block: "center" }));
    await l.click();
  }

  test("S-1: a viewer opens the read-only feature panel from a row on a phone", async ({ page }) => {
    // protects: at 390 px wide a viewer opens the Weekly alert digest row and its panel names it and says "You can read this feature"
    // fails_when: the row opens no panel, or the panel lacks the name or the read-only line
    // no_claim: other items or the bar and Gantt routes; desktop is the other S-1 test
    await roadmap(page, VIEWER);
    await openRoadmapItem(page, "alert-digest");
    await expect(card(page)).toContainText("Weekly alert digest");
    await expect(card(page)).toContainText("You can read this feature");
  });

  test("S-5, S-11: Home's count matches the Roadmap's, and the plan's labels wrap whole", async ({ page }) => {
    // protects: at 390 px wide Home's broken-links tile reads 3, no plan row label is wider than its box, and the Roadmap's broken-links strip counts the same 3
    // fails_when: the tile is not 3, a label runs past its box, or the Roadmap's count differs from Home's
    // no_claim: which links are listed; this does not check for dots, only that the text fits
    await home(page);
    const n = Number((await page.getByTestId("home-summary-broken-links").locator(".simple-number").innerText()).trim());
    expect(n).toBe(3);
    for (const label of await page.getByTestId("home-strip-label").all()) expect(await label.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    await page.goto("/simple/roadmap");
    await expect(page.getByTestId("simple-roadmap")).toBeVisible();
    expect(await stripCount(page)).toBe(n);
  });

  test("S-6: the phone's Needs a decision opens an item's panel", async ({ page }) => {
    // protects: at 390 px wide a tap on Needs a decision and then on Weekly alert digest in its broken links opens that feature's panel
    // fails_when: the tray cannot be tapped open, or the title opens no panel or the wrong one
    // no_claim: the tray's counts, the draft's owner action or other items; desktop is the other S-6 test
    await roadmap(page);
    await tap(page.getByTestId("needs-decision"));
    await tap(tray(page).getByTestId("tray-broken").getByRole("button", { name: "Weekly alert digest" }));
    await expect(card(page)).toContainText("Weekly alert digest");
  });

  test("G-8: a viewer on a phone is not offered to ask for a suggestion", async ({ page }) => {
    // protects: at 390 px wide a viewer's Roadmap shows no "Suggest a feature" counter on any goal
    // fails_when: any goal counter offers a viewer "Suggest a feature"
    // no_claim: that suggestion counters show at all (a page with none would pass); the owner on a phone
    await roadmap(page, VIEWER);
    await expect(page.getByTestId("goal-counter-suggestions").filter({ hasText: "Suggest a feature" })).toHaveCount(0);
  });
});
