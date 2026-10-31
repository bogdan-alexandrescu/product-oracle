import { expect, test, type Locator, type Page } from "./test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { ADMIN } from "./helpers";

/*
 * QA pass 4 fixes on Simple Home (mock-backed, desktop 1512 and phone 390), as the owner, a
 * commenter and a viewer:
 * - qa4-simple-home-4: each goal card has Suggestions, and it opens the drawer.
 * - qa4-simple-home-5, -28: a broken link names its item once; one Move the dependents per move.
 * - qa4-simple-home-6: the goal cards read the same way; a proposed goal is said to be hidden.
 * - qa4-simple-home-7: the plan's row label keeps one line.
 * - qa4-simple-home-11: the toast after a fix sits clear of the rail and names the item once.
 * - qa4-simple-home-12: every working draft is listed with its own count.
 * - qa4-simple-home-16: others are never told unsent changes are "in review".
 * - qa4-simple-home-17: a commenter reads one message about the broken links; a lone tile keeps its size.
 * - qa4-simple-home-18: a commenter cannot propose the same move twice.
 * - qa4-simple-home-20: a viewer's email stays on one line in the rail.
 * - qa4-simple-home-21: a viewer is told who fixes the broken links.
 * - qa4-simple-home-22: the phone's More badge is grey when nothing in it waits on you, as the rail.
 * - qa4-simple-home-25: a tile says one in the singular.
 */

const COMMENTER = "commenter@example.com";
const VIEWER = "viewer@example.com";
const DESKTOP = { width: 1512, height: 900 };
const PHONE = { width: 390, height: 844 };

/** Signs in on the Simple Home scenario, or with `seed` false on the mock's default data (QA's goals). */
async function signIn(page: Page, email: string, size = DESKTOP, seed = true) {
  if (seed) await page.context().addInitScript((key) => localStorage.setItem(key, "simple-home"), MOCK_SCENARIO_KEY);
  await page.setViewportSize(size);
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(ADMIN.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).not.toHaveURL(/\/login/);
  await page.goto("/simple");
  await expect(home(page).getByTestId("home-sentence")).toBeVisible();
}

// Detailed Home stays mounted behind Simple (ModeRoot): read Simple's page only.
const home = (page: Page) => page.getByTestId("simple-page");
const brokenItem = (page: Page, title: string) => home(page).getByTestId("home-broken-item").filter({ has: page.locator(".text-crit", { hasText: title }) });

/** Clicks `l` once it is scrolled to the middle (on a phone the tab bar covers the bottom of the screen). */
async function tap(l: Locator) {
  await l.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await l.click();
}

/** How many lines an element's text is drawn on. */
const linesOf = (l: Locator) => l.evaluate((el) => Math.round(el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight)));

for (const [device, size] of [
  ["desktop", DESKTOP],
  ["phone", PHONE],
] as const) {
  test.describe(device, () => {
    test(`qa4-simple-home-4, -6 (${device}): goal cards read the same way, each opens its suggestions, a proposed goal is said`, async ({ page }) => {
      // fails_when: no goal card shows Suggestions, the second card has no "From", or the proposed goal is missing with no word
      await signIn(page, ADMIN.email, size, false);
      const goals = home(page).getByTestId("home-goal");
      await expect(goals).toHaveCount(2);
      for (const g of await goals.all()) await expect(g.getByTestId("home-goal-path")).toHaveText(/^From .+ · now .+ · target .+$/);
      await expect(home(page).getByTestId("home-goals-proposed")).toHaveText("1 proposed goal is not shown here until it is confirmed.");
      for (const g of await goals.all()) await expect(g.getByTestId("goal-suggestions-open")).toBeVisible();
      const name = (await goals.nth(1).getByTestId("home-goal-link").textContent())!.trim();
      await tap(goals.nth(1).getByTestId("goal-suggestions-open"));
      await expect(page.getByTestId("goal-panel")).toBeVisible();
      await expect(page.getByTestId("goal-panel")).toContainText(name);
    });

    test(`qa4-simple-home-5, -28 (${device}): a broken link names its item once, and a shared move has one control`, async ({ page }) => {
      // fails_when: a sentence starts with its heading's item name, or two rows repeat the same move sentence and button
      await signIn(page, ADMIN.email, size);
      const items = home(page).getByTestId("home-broken-item");
      await expect(items.first()).toBeVisible();
      for (const item of await items.all()) {
        const title = (await item.locator(".text-crit").first().textContent())!.trim();
        for (const row of await item.getByTestId("home-broken").all()) {
          // The sentence as seen: its screen-reader prefix (the item's name) is not drawn.
          const said = (await row.evaluate((el) => [...el.firstElementChild!.childNodes].filter((n) => !(n instanceof HTMLElement && n.classList.contains("sr-only"))).map((n) => n.textContent).join(""))).trim();
          expect(said.startsWith(title), `"${said}" names ${title} again`).toBe(false);
          expect(said).not.toContain(`‘${title}’`);
        }
      }
      const moves = await home(page).getByTestId("home-broken-moves").allTextContents();
      expect(new Set(moves).size).toBe(moves.length);
      const buttons = home(page).getByTestId("home-broken").getByRole("button", { name: /^Move the dependents$/ });
      expect(await buttons.count()).toBe(moves.length);
    });
  });
}

test("qa4-simple-home-25: one proposal on the owner's items reads in the singular, desktop and phone", async ({ page }) => {
  // fails_when: the tile reads "1 proposals on your items" (desktop) or "1 proposals" (phone)
  await signIn(page, ADMIN.email);
  const tile = home(page).getByTestId("home-summary-proposals");
  await expect(tile.locator(".simple-number")).toHaveText(/^\d+$/);
  // Decline proposals until one is left.
  for (let n = Number(await tile.locator(".simple-number").textContent()); n > 1; n--) {
    await tap(home(page).getByTestId("home-proposal").first().getByRole("button", { name: "Decline" }));
    await expect(tile.locator(".simple-number")).toHaveText(String(n - 1));
  }
  await expect(tile).toContainText("1proposal on your items");
  await page.setViewportSize(PHONE);
  await expect(tile).toContainText("1proposal");
  await expect(tile).not.toContainText("proposals");
});

test("qa4-simple-home-12, -11: every working draft has its own line; the fix's toast sits clear of the rail and names the item once", async ({ page }) => {
  // fails_when: Home lists only the Alerts roadmap's draft after a risk is accepted on the Onboarding roadmap, or the toast covers the rail's account
  await signIn(page, ADMIN.email);
  const before = await home(page).getByTestId("home-draft").count();
  const row = brokenItem(page, "In-app tour").getByTestId("home-broken").first();
  await tap(row.getByRole("button", { name: "Accept as risk" }));
  await row.getByLabel("Why the risk is acceptable").fill("The tour can wait a week");
  await row.getByRole("button", { name: "Accept as risk" }).click();
  await expect(page.getByText("Risk accepted in your working draft", { exact: true })).toBeVisible();
  const drafts = home(page).getByTestId("home-draft");
  await expect(drafts.filter({ hasText: "Onboarding roadmap" })).toHaveText(/Your working draft of Onboarding roadmap has 1 change\./);
  await expect(drafts).toHaveCount(before + 1);

  // A move's toast: right of the rail, its item named once.
  const move = home(page).getByTestId("home-broken").getByRole("button", { name: "Move the dependents" }).first();
  await tap(move);
  const toast = page.getByText(/^Dependents moved in your working draft/);
  await expect(toast).toBeVisible();
  const rail = (await page.getByTestId("simple-person").boundingBox())!;
  const box = (await toast.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(rail.x + rail.width);
  const words = (await toast.textContent())!;
  for (const name of words.match(/‘[^’]+’/g) ?? []) expect(words).not.toContain(`${name.slice(1, -1)} ${name}`);
});

test("qa4-simple-home-7: the plan's row label keeps one line with Ask Oracle open at 1440", async ({ page }) => {
  // fails_when: "Guided setup · no milestone · 4 items" wraps onto two lines
  await signIn(page, ADMIN.email, { width: 1440, height: 900 });
  await page.getByTestId("simple-ask").filter({ visible: true }).first().click();
  await expect(page.getByTestId("hop-panel").filter({ visible: true })).toBeVisible();
  const labels = home(page).getByTestId("home-strip-label");
  await expect(labels.first()).toBeVisible();
  for (const l of await labels.all()) {
    expect(await linesOf(l)).toBe(1);
    await expect(l).toHaveAttribute("title", /.+ · .+/);
  }
});

test("qa4-simple-home-7: under a plan of one PRD, each broken link names the roadmap it is on", async ({ page }) => {
  // fails_when: the plan draws Guided setup only and its broken links on the Alerts and Onboarding roadmaps say nothing of where they are
  await signIn(page, ADMIN.email);
  await expect(home(page).getByTestId("home-strip-label").first()).toContainText("Guided setup");
  await expect(home(page).getByTestId("home-broken-links").locator("h3")).toHaveText("Broken links · Alerts roadmap, Onboarding roadmap");
  await expect(brokenItem(page, "Weekly alert digest").getByTestId("home-broken-roadmap")).toHaveText("· Alerts roadmap");
  await expect(brokenItem(page, "In-app tour").getByTestId("home-broken-roadmap")).toHaveText("· Onboarding roadmap");
  const items = home(page).getByTestId("home-broken-item");
  await expect(items.first()).toBeVisible();
  await expect(items.getByTestId("home-broken-roadmap")).toHaveCount(await items.count());
});

test.describe("a commenter", () => {
  test("qa4-simple-home-17: with nothing waiting, the card says what the greeting says about the broken links, and its lone tile keeps a tile's width", async ({ page }) => {
    // fails_when: the card says only "Nothing waits on you … comment on a one-pager" while the greeting says "You can propose fixes", or the one tile spans the card
    // The mock's default data: no decisions or proposals wait on the commenter, so the broken links tile is alone.
    await signIn(page, COMMENTER, DESKTOP, false);
    await expect(home(page).getByTestId("home-sentence")).toContainText("You can propose fixes for broken links.");
    const quiet = home(page).getByTestId("home-nothing-waits");
    await expect(quiet).toHaveText("Nothing waits on you. You can propose fixes for broken links in the plan below. Go to the broken links");
    await quiet.getByRole("link", { name: "Go to the broken links" }).click();
    await expect(page).toHaveURL(/#broken-links$/);
    await expect(home(page).getByTestId("home-broken-links")).toBeInViewport();
    const tiles = home(page).getByTestId("home-summary").locator("li");
    await expect(tiles).toHaveCount(1);
    await expect(tiles.first()).toContainText("broken links");
    const card = (await home(page).getByTestId("home-summary").boundingBox())!;
    const tile = (await tiles.first().boundingBox())!;
    expect(tile.width).toBeLessThan(card.width / 2);
  });

  test("qa4-simple-home-17: two tiles still share the whole card", async ({ page }) => {
    // fails_when: two tiles are drawn in three columns, leaving the card's last third blank
    await signIn(page, COMMENTER);
    const list = home(page).getByTestId("home-summary").locator("ul").first();
    const tiles = list.locator("li");
    await expect(tiles).toHaveCount(2);
    const row = (await list.boundingBox())!;
    const last = (await tiles.last().boundingBox())!;
    expect(Math.abs(last.x + last.width - (row.x + row.width))).toBeLessThan(2);
  });

  test("qa4-simple-home-18: a move proposed on one item is not offered again on the item it also moves", async ({ page }) => {
    // fails_when: Mobile alert push still offers "Propose: move the dependents" after it was proposed on Weekly alert digest
    await signIn(page, COMMENTER);
    const propose = (title: string) => brokenItem(page, title).getByRole("button", { name: "Propose: move the dependents" });
    await tap(propose("Weekly alert digest"));
    await expect(page.getByText(/^Proposed: /)).toBeVisible();
    await expect(home(page).getByTestId("home-broken-proposed")).toHaveCount(1);
    // Mobile alert push, which the proposal moves too, says so and offers no second one.
    await expect(brokenItem(page, "Mobile alert push").getByTestId("home-broken-covered")).toContainText("Your proposal to move the dependents of Weekly alert digest moves this one too");
    await expect(propose("Mobile alert push")).toHaveCount(0);
  });
});

test.describe("a viewer", () => {
  test("qa4-simple-home-21, -16, -20: who fixes the broken links, no unsent change called in review, the email on one line", async ({ page }) => {
    // fails_when: no line says who fixes the broken links, the notice says "2 changes are in review" for an unsent draft, or the email breaks at its "@"
    await signIn(page, VIEWER);
    await expect(home(page).getByTestId("home-broken-readers")).toHaveText(/^.+ (fix|fixes) these; you can't change the roadmap\.$/);
    const notice = home(page).getByTestId("home-in-review");
    if (await notice.count()) await expect(notice).not.toContainText("in review");
    const name = page.getByTestId("simple-person-name");
    await expect(name).toHaveText(VIEWER);
    expect(await linesOf(name)).toBe(1);
  });
});

test("qa4-simple-home-22: on a phone the More badge for meetings coming up is grey, as the rail's count", async ({ page }) => {
  // fails_when: More's count is yellow (the "needs you" colour) while the rail draws the same count grey
  await signIn(page, ADMIN.email);
  const railCount = page.getByTestId("simple-nav-meetings-count");
  await expect(railCount).toBeVisible();
  const quiet = ((await railCount.getAttribute("class")) ?? "").includes("simple-count-quiet");
  await page.setViewportSize(PHONE);
  const more = page.getByTestId("simple-tab-more-count");
  await expect(more).toBeVisible();
  if (quiet) await expect(more).toHaveClass(/simple-count-quiet/);
  const bg = (l: Locator) => l.evaluate((el) => getComputedStyle(el).backgroundColor);
  await page.setViewportSize(DESKTOP);
  const railBg = await bg(railCount);
  await page.setViewportSize(PHONE);
  expect(await bg(more)).toBe(railBg);
});
