import { expect, test, type Page } from "./test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { ADMIN } from "./helpers";

/*
 * QA pass 3 on Simple's Home (mock-backed, through the UI only; desktop 1440 x 900 unless a test
 * says phone 390 x 844). One test per finding or group, each failing without its fix:
 * qa-simple-home-1, -2, -9, -10, -11, -12, -13, -14, -15, -16, -17, -26, -27, -30 and
 * qa-onboarding-19, -20, -21 (a new company's Simple Home, the 'empty' scenario).
 * no_claim: the API's change engine (api/tests cover shift_dependents); the Roadmap's own tray.
 */

const COMMENTER = "commenter@example.com";
const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };

async function signIn(page: Page, email: string, scenario: string) {
  await page.context().addInitScript(
    ([key, value]) => {
      if (!sessionStorage.getItem("fix4-home")) {
        localStorage.removeItem("po-mock-db-v2");
        sessionStorage.setItem("fix4-home", "1");
      }
      localStorage.setItem(key, value);
    },
    [MOCK_SCENARIO_KEY, scenario] as const,
  );
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

test.describe("desktop", () => {
  test.use({ viewport: DESKTOP });

  test("qa-simple-home-11, -1, -12, -2: one heading per broken item; Move the dependents says what moves, and the toast what else changed", async ({ page }) => {
    // fails_when: an item's name is two red headings, a sentence repeats it in quotes, the button says only
    // "Move dependents", or the toast does not say the items' new dates
    await signIn(page, ADMIN.email, "simple-home");
    const items = home(page).getByTestId("home-broken-item");
    await expect(items.first()).toBeVisible();
    const titles = await items.locator(".text-crit").allTextContents();
    expect(new Set(titles).size).toBe(titles.length);
    const digest = brokenItem(page, "Weekly alert digest");
    await expect(digest).toHaveCount(1);
    // Sentences under the heading do not repeat it, nor quote names.
    for (const t of await digest.getByTestId("home-broken").locator(":scope > span:first-child").allInnerTexts()) {
      expect(t).not.toContain("'Weekly alert digest'");
      expect(t).toMatch(/^[A-Z]/);
    }
    const problem = digest.getByTestId("home-broken").filter({ hasText: "which it depends on" }).first();
    await expect(problem.getByTestId("home-broken-moves")).toHaveText(/^Move the dependents moves Weekly alert digest( and .+)? after \S.+\.$/);
    const move = problem.getByRole("button", { name: "Move the dependents", exact: true });
    await expect(move).toHaveAccessibleDescription(/moves Weekly alert digest/);
    await move.click();
    await expect(page.getByText(/^Dependents moved in your working draft: Weekly alert digest now \w{3} \d+ – \w{3} \d+/)).toBeVisible();
  });

  test("qa-simple-home-12: Home's fix buttons say what the Roadmap's do", async ({ page }) => {
    await signIn(page, ADMIN.email, "simple-home");
    const plan = home(page).getByTestId("home-broken-links");
    await expect(plan.getByRole("button", { name: "Move the dependents", exact: true }).first()).toBeVisible();
    await expect(plan.getByRole("button", { name: "Move dependents", exact: true })).toHaveCount(0);
    await expect(plan.getByRole("button", { name: "Move dependency", exact: true })).toHaveCount(0);
  });

  test("qa-simple-home-10: Accept as risk is one wording with one reason line, for the owner and the commenter", async ({ page }) => {
    // fails_when: the submit says "Save risk note" / "Propose risk note"
    await signIn(page, COMMENTER, "simple-home");
    const row = home(page).getByTestId("home-broken").filter({ hasText: "Mobile alert push" }).first();
    await row.getByRole("button", { name: "Propose: accept as risk" }).click();
    await expect(row.getByLabel("Why the risk is acceptable")).toBeVisible();
    await expect(row.getByRole("button", { name: "Propose: accept as risk" })).toHaveCount(1);
    await expect(row.getByRole("button", { name: "Propose: accept as risk" })).toHaveAttribute("type", "submit");
    await expect(row.getByRole("button", { name: /risk note/ })).toHaveCount(0);
    await row.getByRole("button", { name: "Cancel" }).click();
    await expect(row.getByLabel("Why the risk is acceptable")).toHaveCount(0);
  });

  test("qa-simple-home-9, -16: a commenter's fixes sit in one even row, who decides said once; nothing waiting is one line", async ({ page }) => {
    // fails_when: "<name> decides" repeats on every row, the buttons stack in a ragged column, or two empty cards and 0 tiles lead the page
    await signIn(page, COMMENTER, "simple-home");
    await expect(home(page).getByTestId("home-broken-deciders")).toHaveText(/^.+ (decide|decides) the fixes you propose here\.$/);
    await expect(home(page).getByTestId("home-broken").filter({ hasText: /\bdecides?\b/ })).toHaveCount(0);
    for (const row of await home(page).getByTestId("home-broken").getByTestId("home-row-actions").all()) {
      const boxes = await row.getByRole("button").evaluateAll((els) => els.map((e) => e.getBoundingClientRect()).map((r) => ({ y: Math.round(r.top), h: Math.round(r.height) })));
      expect(new Set(boxes.map((b) => b.y)).size).toBe(1);
      expect(new Set(boxes.map((b) => b.h)).size).toBe(1);
    }
    // No decision waits on the commenter: no empty card, no 0 tile, above what does.
    await expect(home(page).getByTestId("home-proposal").first()).toBeVisible();
    await expect(home(page).getByTestId("home-decisions-empty")).toHaveCount(0);
    await expect(home(page).getByTestId("home-summary-decisions")).toHaveCount(0);
    await expect(home(page).getByTestId("home-summary-proposals")).toBeVisible();
  });

  test("qa-simple-home-16: with nothing waiting, Home says so in one line", async ({ page }) => {
    await signIn(page, ADMIN.email, "empty");
    await expect(home(page).getByTestId("home-nothing-waits")).toHaveText(/^Nothing waits on you\. .+ Open the roadmap$/);
    await expect(home(page).getByTestId("home-decisions-empty")).toHaveCount(0);
    await expect(home(page).getByTestId("home-proposals-empty")).toHaveCount(0);
    await expect(home(page).getByTestId("home-summary-decisions")).toHaveCount(0);
    await expect(home(page).getByTestId("home-summary-proposals")).toHaveCount(0);
  });

  test("qa-simple-home-13, -15, -14: plain names, no doubled counts, and All proposals lands on the proposals", async ({ page }) => {
    // fails_when: 'G1', 'Q5' or 'F-06' show on Home, the section headers repeat the tiles' counts, or All opens at Broken links
    await signIn(page, ADMIN.email, "simple-home");
    await expect(home(page).getByTestId("home-goal").first()).toBeVisible();
    await expect(home(page).getByTestId("home-goal").locator(".simple-code")).toHaveCount(0);
    await expect(home(page).getByTestId("home-question").first()).toBeVisible();
    await expect(home(page).getByTestId("home-question").locator(".simple-code")).toHaveCount(0);
    await expect(home(page).getByTestId("home-decisions")).not.toContainText(/Blocks M\d|\b[A-Z]{1,3}-\d+\s/);
    await expect(home(page).getByTestId("home-since")).not.toContainText(/\b[A-Z]{1,3}-\d+\s/);
    await expect(home(page).getByTestId("home-decisions-count")).toHaveCount(0);
    await expect(home(page).getByTestId("home-proposals-count")).toHaveCount(0);
    await expect(home(page).getByTestId("home-summary-decisions").locator(".simple-number")).toHaveText(/^\d+$/);
    await home(page).getByTestId("home-proposals-all").click();
    await expect(page).toHaveURL(/\/simple\/roadmap\?review=proposals$/);
    await expect(page.locator("#review-proposals")).toBeInViewport();
  });

  test("qa-simple-home-26, -17, -27: a goal opens its features, the plan names its document and every month, an early review says Start now", async ({ page }) => {
    await signIn(page, ADMIN.email, "simple-home");
    const goal = home(page).getByTestId("home-goal").first();
    await expect(goal.getByTestId("home-goal-link")).toHaveAttribute("href", /^\/simple\/(roadmap\?goal=|priorities)/);
    await expect(home(page).getByTestId("home-goal-weight").first()).toHaveText(/^Counts for \d+% of each feature's score$/);
    const labels = home(page).getByTestId("home-strip-label");
    await expect(labels.filter({ hasText: /· no milestone ·/ }).first()).toHaveText(/^\S.* · no milestone · \d+ items?$/);
    await expect(labels.filter({ hasText: /^No milestone/ })).toHaveCount(0);
    const months = await home(page).getByTestId("home-strip-month").allTextContents();
    expect(months.length).toBeGreaterThanOrEqual(3);
    expect(months).toContain("Dec");
    const next = home(page).getByTestId("home-meeting-next");
    await expect(next.getByRole("link", { name: "Start now" })).toBeVisible();
    await expect(next.getByRole("link", { name: "Start review" })).toHaveCount(0);
    await goal.getByTestId("home-goal-link").click();
    await expect(page).toHaveURL(/\/simple\/(roadmap\?goal=|priorities)/);
  });

  test("qa-simple-home-30: Home's toast sits over the rail, clear of the decisions' buttons", async ({ page }) => {
    await signIn(page, ADMIN.email, "simple-home");
    const row = home(page).getByTestId("home-broken").filter({ hasText: "Mobile alert push" }).first();
    await row.getByRole("button", { name: "Accept as risk" }).click();
    await row.getByLabel("Why the risk is acceptable").fill("Push ships behind a flag");
    await row.getByRole("button", { name: "Accept as risk" }).click();
    const toast = page.getByText("Risk accepted in your working draft", { exact: true });
    await expect(toast).toBeVisible();
    const box = (await toast.boundingBox())!;
    const main = (await home(page).boundingBox())!;
    // Bottom-left: it starts left of the main column's middle, and never reaches its right-hand buttons.
    expect(box.x).toBeLessThan(main.x + 40);
    expect(box.x + box.width).toBeLessThan(main.x + main.width / 2 + 200);
  });
});

test.describe("a new company", () => {
  test("qa-onboarding-19, -21: the setup card shows Detailed's words and figures, a progress ring, and no tile that cannot apply yet", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await signIn(page, ADMIN.email, "empty");
    const card = home(page).getByTestId("home-setup");
    await expect(card.getByTestId("home-setup-ring")).toHaveAccessibleName(/^\d+ of \d+ done$/);
    await expect(card.getByTestId("home-setup-step").first()).toHaveText(/^Connect tools\s*None$/);
    await expect(card.getByTestId("home-setup-step").filter({ hasText: "Time zone" })).toContainText("Not set");
    await expect(home(page).getByTestId("home-summary-broken-links")).toHaveCount(0);
  });

  test("qa-onboarding-20: on a phone the title keeps its room, the count and Hide sit under it", async ({ page }) => {
    await page.setViewportSize(PHONE);
    await signIn(page, ADMIN.email, "empty");
    const card = home(page).getByTestId("home-setup");
    const title = card.getByRole("heading", { name: "Welcome: set up Oracle" });
    await expect(title).toBeVisible();
    const lines = await title.evaluate((el) => Math.round(el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight)));
    expect(lines).toBeLessThanOrEqual(2);
    const under = card.getByTestId("home-setup-count");
    await expect(under.getByTestId("home-setup-progress")).toBeVisible();
    await expect(under.getByRole("button", { name: "Hide" })).toBeVisible();
    expect((await under.boundingBox())!.y).toBeGreaterThan((await title.boundingBox())!.y);
  });
});
