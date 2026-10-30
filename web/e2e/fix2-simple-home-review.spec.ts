import { expect, test, type Locator, type Page } from "./test";

import { MOCK_FAIL_KEY, MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { ADMIN } from "./helpers";

/*
 * The review's minors on Simple's Home, its walk and the Ask panel (desktop, mock-backed,
 * through the UI only):
 * - the Set up card sits on a new company's Home only; an established company's Simple Home
 *   keeps its picked design (Detailed Home keeps the checklist).
 * - a new company with nothing waiting has no "Walk me through it" under "Nothing waits on you today."
 * - at 1440 px with Ask open, a goal card's code and its share of the score each stay on one line.
 * - the walk's decisions open on Simple's Decisions page, and the walk still loads when the
 *   waiting decisions cannot be read.
 * - the Roadmap's goal cards count the items Home's goal tiles count (a cut item is not one).
 * no_claim: phones (the goal band is one column there; the walk's layout is the same).
 */

test.use({ viewport: { width: 1440, height: 900 } });

const APPROVER = "approver@example.com";

async function signIn(page: Page, email: string, scenario: string | null, to = "/simple") {
  if (scenario) await page.context().addInitScript(([key, value]) => localStorage.setItem(key, value), [MOCK_SCENARIO_KEY, scenario] as const);
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(ADMIN.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).not.toHaveURL(/\/login/);
  await page.goto(to);
}

const simple = (page: Page) => page.getByTestId("simple-page");

async function openAsk(page: Page): Promise<Locator> {
  await page.getByTestId("simple-ask").filter({ visible: true }).first().click();
  const panel = page.getByTestId("hop-panel").filter({ visible: true });
  await expect(panel.getByTestId("ask-chat")).toBeVisible();
  return panel;
}

/** How many lines an element's text takes (its height over its line height). */
const lines = (l: Locator) =>
  l.evaluate((el) => {
    const s = getComputedStyle(el);
    const line = parseFloat(s.lineHeight) || parseFloat(s.fontSize) * 1.2;
    return Math.round(el.getBoundingClientRect().height / line);
  });

test("an established company's Simple Home has no Set up card; a new company's leads with it", async ({ page }) => {
  // fails_when: the 8-row Set up card closes every established owner's Simple Home while a step is open
  await signIn(page, ADMIN.email, null);
  await expect(simple(page).getByTestId("home-goal").first()).toBeVisible();
  await expect(simple(page).getByTestId("home-setup")).toHaveCount(0);
});

test("a new company with nothing waiting has no 'Walk me through it'", async ({ page }) => {
  // fails_when: "Walk me through it" shows under "Nothing waits on you today." and walks nothing
  await signIn(page, ADMIN.email, "empty");
  await expect(simple(page).getByTestId("home-sentence")).toHaveText("Nothing waits on you today.");
  await expect(simple(page).getByTestId("home-setup")).toBeVisible();
  await expect(simple(page).getByRole("button", { name: "Walk me through it" })).toHaveCount(0);
  await expect(simple(page).getByTestId("home-walk-slot")).toHaveCount(0);
});

test("at 1440 px with Ask open, a goal card's code and its share of the score stay on one line", async ({ page }) => {
  // fails_when: the narrower goal cards wrap the code 'G-Q' or '17% of the score' over two lines
  await signIn(page, APPROVER, "simple-home");
  await expect(page.getByTestId("home-goal").first()).toBeVisible();
  await openAsk(page);
  const goals = page.getByTestId("home-goal");
  await expect(goals.getByTestId("home-goal-weight").first()).toBeVisible();
  for (const g of await goals.all()) {
    // fix4 (qa-simple-home-13, -26): no code on the card; the share in words wraps inside the card, never past it.
    await expect(g.locator(".simple-code")).toHaveCount(0);
    const weight = g.getByTestId("home-goal-weight");
    if (await weight.count()) expect(await weight.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  }
});

test("the walk opens each decision where it can be decided, as Home's card does", async ({ page }) => {
  // fails_when: a judgement call (not a PRD's question) opens Simple's Decisions page, which only lists it (no Decide),
  // or a PRD's question leaves Simple
  // The approver: "Ship usage caps before anomaly detection" (a judgement call, not a PRD's question) waits on them.
  await signIn(page, APPROVER, null);
  await page.getByRole("button", { name: "Walk me through it" }).click();
  const progress = page.getByTestId("walk-progress");
  await expect(progress).toHaveText(/^1 of \d+$/);
  const total = Number((await progress.textContent())!.split(" of ")[1]);
  const hrefs: string[] = [];
  for (let n = 1; n <= total; n++) {
    await expect(progress).toHaveText(`${n} of ${total}`);
    const open = page.getByTestId("walk-step").getByRole("link", { name: "Open the decision" });
    if (await open.count()) hrefs.push((await open.getAttribute("href"))!);
    await page.getByRole("button", { name: "Skip" }).click();
  }
  expect(hrefs.length).toBeGreaterThan(0);
  for (const h of hrefs) expect(h).toMatch(/^\/simple\/decisions$|^\/company\/decisions\?d=\d+$/);
  const judgement = hrefs.find((h) => /^\/company\/decisions\?d=\d+$/.test(h));
  expect(judgement).toBeTruthy();
  // The same place Home's card for it opens, where an approver can decide it.
  await page.goto(judgement!);
  await expect(page.getByRole("button", { name: /Decide/ }).first()).toBeVisible();
});

test("the walk still loads when the waiting decisions cannot be read", async ({ page }) => {
  // fails_when: one failed read (the waiting decisions) fails the whole walk
  await signIn(page, ADMIN.email, "simple-home");
  await expect(page.getByTestId("home-greeting")).toBeVisible();
  await page.evaluate((key) => localStorage.setItem(key, "/v1/simple/decisions/waiting"), MOCK_FAIL_KEY);
  await page.getByRole("button", { name: "Walk me through it" }).click();
  await expect(page.getByTestId("walk-progress")).toHaveText(/^1 of \d+$/);
  await expect(page.getByTestId("walk-step")).toHaveAttribute("data-kind", "broken_link");
});

test("the Roadmap's goal cards count what Home's goal tiles count: a cut item is not one", async ({ page }) => {
  // fails_when: the goal card counts the cut 'In-app tour' Home's tile leaves out
  await signIn(page, ADMIN.email, null, "/simple/roadmap");
  const card = page.getByTestId("goal-counter").filter({ hasText: "Faster activation" });
  await expect(card).toContainText("3 items");
});
