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
    await roadmap(page);
    const button = page.getByTestId("needs-decision");
    const total = Number(/· (\d+)/.exec(await button.innerText())?.[1]);
    await button.click();
    let listed = 0;
    for (const t of await tray(page).getByTestId("tray-counter").locator("b").all()) listed += Number(await t.innerText());
    const suggested = await tray(page).getByTestId("tray-suggested").getByTestId("goal-suggestion").count();
    expect(suggested).toBeGreaterThan(0);
    expect(total).toBe(listed + suggested);
    await expect(tray(page).getByTestId("tray-scope")).toContainText(`${total} to decide`);
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

  test("S-14, S-11, S-10: Home groups an item's breaks, shows the plan's labels whole, and keeps its explanations behind an (i)", async ({ page }) => {
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
    await roadmap(page, VIEWER);
    const counters = page.getByTestId("goal-counter-suggestions");
    await expect(counters.filter({ hasText: /\d+ suggested feature/ }).first()).toBeVisible();
    await expect(counters.filter({ hasText: "Suggest a feature" })).toHaveCount(0);
    await counters.filter({ hasText: /\d+ suggested feature/ }).first().click();
    await expect(page.getByRole("dialog").filter({ hasText: "Oracle" }).first()).toBeVisible();
  });

  test("G-8: the owner is offered to suggest a feature for a goal with none", async ({ page }) => {
    await roadmap(page);
    await expect(page.getByTestId("goal-counter-suggestions").filter({ hasText: "Suggest a feature" }).first()).toBeVisible();
  });

  test("Demo 6, Demo 8: the banner's time reads month first in the company zone; once sent it says whom it waits on", async ({ page }) => {
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
    await roadmap(page, VIEWER);
    await openRoadmapItem(page, "alert-digest");
    await expect(card(page)).toContainText("Weekly alert digest");
    await expect(card(page)).toContainText("You can read this feature");
  });

  test("S-5, S-11: Home's count matches the Roadmap's, and the plan's labels wrap whole", async ({ page }) => {
    await home(page);
    const n = Number((await page.getByTestId("home-summary-broken-links").locator(".simple-number").innerText()).trim());
    expect(n).toBe(3);
    for (const label of await page.getByTestId("home-strip-label").all()) expect(await label.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    await page.goto("/simple/roadmap");
    await expect(page.getByTestId("simple-roadmap")).toBeVisible();
    expect(await stripCount(page)).toBe(n);
  });

  test("S-6: the phone's Needs a decision opens an item's panel", async ({ page }) => {
    await roadmap(page);
    await tap(page.getByTestId("needs-decision"));
    await tap(tray(page).getByTestId("tray-broken").getByRole("button", { name: "Weekly alert digest" }));
    await expect(card(page)).toContainText("Weekly alert digest");
  });

  test("G-8: a viewer on a phone is not offered to ask for a suggestion", async ({ page }) => {
    await roadmap(page, VIEWER);
    await expect(page.getByTestId("goal-counter-suggestions").filter({ hasText: "Suggest a feature" })).toHaveCount(0);
  });
});
