import { SCOREBOARD, SCOREBOARD_SCENARIO } from "../lib/api/mock/goal-map";
import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { ADMIN, login } from "./helpers";
import { expect, test, type Page } from "./test";

/*
 * The Goal map as the scoreboard (owner, Nov 5), driven through the UI against the mock
 * ("goal-map-scoreboard", invented data): sign-ups measured by its metric, conversions tied to a
 * metric with no value yet, revenue with no metric, and one gate ("6 paid conversions per rep")
 * with no feature. Owner, approver and viewer; 1440 and 390; light and dark.
 *
 * Test cards (protects / fails_when / no_claim) are each test's comment.
 */

const DESKTOP = { viewport: { width: 1440, height: 900 } };
const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true };
const APPROVER = "approver@example.com";
const VIEWER = "viewer@example.com";
/** The mock's confirmed goal with no number to aim at (on Home, off the map). */
const OFF_MAP = "Cut early churn";

async function open(page: Page, email: string = ADMIN.email, scheme: "light" | "dark" = "light") {
  await page.context().addInitScript(([k, v]) => localStorage.setItem(k, v), [MOCK_SCENARIO_KEY, SCOREBOARD_SCENARIO] as const);
  await page.emulateMedia({ colorScheme: scheme });
  await login(page, email);
  await page.goto("/simple");
  if (page.viewportSize()!.width <= 600) {
    await page.getByTestId("simple-tab-more").click();
    await page.getByTestId("simple-more-sheet").getByRole("link", { name: "Goal map" }).click();
  } else await page.getByTestId("simple-nav-goals").first().click();
  await expect(page).toHaveURL(/\/simple\/goals$/);
  await expect(page.getByTestId("gm-page")).toBeVisible();
}

const goal = (page: Page, name: string) => page.getByTestId("ld-goal").filter({ hasText: name });
const gate = (page: Page, name: string) => page.getByTestId("ld-milestone").filter({ hasText: name });

for (const scheme of ["light", "dark"] as const) {
  test.describe(`desktop ${scheme}`, () => {
    test.use(DESKTOP);

    test("each goal says where its reading comes from; the owner picks revenue's metric", async ({ page }) => {
      // protects=a measured goal names its metric and when; a metric with no value yet offers Add a
      // value; no metric offers Pick its metric, whose picker measures the goal (and its gates) at
      // once; fails_when=a not-measured goal is a dead end or the pick changes nothing; no_claim=the
      // metric's values (Company › Metrics).
      await open(page, ADMIN.email, scheme);
      await expect(goal(page, "Sign-ups per rep per day").getByTestId("gm-goal-source")).toHaveText(`From ${SCOREBOARD.measured} · Nov 1`);
      const conv = goal(page, "Paid conversions per rep per day");
      // Not measured: the status word stands in for the number, and the metric offers Add a value.
      await expect(conv).toContainText("Too early");
      await expect(conv.getByTestId("gm-add-value")).toHaveAttribute("href", /^\/company\/metrics\?metric=/);
      const rev = goal(page, "Revenue per day");
      await expect(rev.getByTestId("gm-pick-metric")).toBeVisible();
      await expect(rev.getByTestId("gm-goal-source")).toHaveCount(0);
      const revGate = gate(page, "$12k revenue per day");
      await rev.getByTestId("gm-pick-metric").click();
      const picker = page.getByTestId("gm-editor");
      await expect(picker).toContainText("Pick the metric for Revenue per day");
      await expect(picker.getByTestId("gm-add-metric")).toHaveAttribute("href", "/company/metrics");
      await picker.getByRole("button", { name: new RegExp(SCOREBOARD.pick) }).click();
      await picker.getByTestId("gm-save").click();
      await expect(page.getByTestId("gm-flash")).toHaveText(`Revenue per day now reads ${SCOREBOARD.pick}.`);
      await expect(rev.getByTestId("gm-goal-source")).toHaveText(`From ${SCOREBOARD.pick} · Nov 1`);
      await expect(rev.getByTestId("gm-pick-metric")).toHaveCount(0);
      await expect(revGate).toContainText("On track");
    });

    test("the flags count the empty gate and the features serving no gate, and placing clears them", async ({ page }) => {
      // protects=the gate with no feature and the roadmap features serving no gate are counted on the
      // page; each count opens its items with Place a feature / Place it / Add an item; placing a
      // feature updates the counts at once; fails_when=a count does not open its items or stays
      // after the fix; no_claim=the API's reading of the roadmap (pytest).
      await open(page, ADMIN.email, scheme);
      const gaps = page.getByTestId("gm-flag-gaps");
      await expect(gaps).toHaveText("2 gate areas with no feature");
      await gaps.click();
      const list = page.getByTestId("gm-flag-list");
      await expect(list.getByTestId("gm-gap")).toHaveCount(2);
      await expect(list.getByTestId("gm-gap").first()).toContainText(SCOREBOARD.gap);
      await expect(list.getByTestId("gm-add-item").first()).toHaveAttribute("href", "/simple/roadmap");
      await list.getByTestId("gm-gap").first().getByTestId("gm-place").click();
      const drawer = page.getByTestId("gm-editor");
      await expect(drawer).toContainText("Attach a feature to a milestone");
      await drawer.getByRole("button", { name: /Rep call script hints/ }).click();
      await drawer.getByTestId("gm-save").click();
      await expect(gaps).toHaveText("1 gate area with no feature");

      const unplaced = page.getByTestId("gm-flag-unplaced");
      const before = Number((await unplaced.textContent())?.split(" ")[0]);
      expect(before).toBeGreaterThan(0);
      // goal-map-editing: the badge opens the list of features on no milestone, each code then name.
      await unplaced.click();
      const first = page.getByTestId("gm-flag-list").getByTestId("gm-unplaced").first().getByRole("button").first();
      const code = (await first.locator(".simple-code").count()) ? ((await first.locator(".simple-code").first().textContent()) ?? "") : "";
      const name = ((await first.textContent()) ?? "").slice(code.length).trim();
      await page.getByTestId("gm-flag-list").getByRole("button", { name: "Close" }).click();
      // Placed from the gap's own drawer, found by its name.
      await page.getByTestId("gm-flag-gaps").click();
      await page.getByTestId("gm-flag-list").getByTestId("gm-place").first().click();
      await drawer.getByRole("textbox").first().fill(name);
      await drawer.getByRole("button", { name: new RegExp(name) }).click();
      await expect(drawer.getByRole("button", { name: new RegExp(name) })).toHaveClass(/border-accent/);
      await drawer.getByRole("combobox").first().selectOption({ label: SCOREBOARD.gap });
      await drawer.getByRole("combobox").nth(1).selectOption({ label: "Customer safety" });
      await drawer.getByTestId("gm-save").click();
      await expect(gaps).toHaveCount(0);
      await expect(unplaced).toContainText(`${before - 1} `);
      await expect(page.getByTestId("ld-feature").filter({ hasText: name })).toHaveCount(1);
    });
  });

  test.describe(`phone ${scheme}`, () => {
    test.use(PHONE);

    test("on a phone the revenue goal offers Pick its metric and the flags open", async ({ page }) => {
      // protects=at 390 a goal with no metric still offers Pick its metric and the counts open their
      // items; fails_when=either is cut off or missing on a phone.
      await open(page, ADMIN.email, scheme);
      const phone = page.getByTestId("ld-phone");
      await phone.getByRole("tab", { name: "Goal 3" }).click();
      const rev = phone.getByTestId("ld-goal");
      await expect(rev).toContainText("Revenue per day");
      await expect(rev.getByTestId("gm-pick-metric")).toBeVisible();
      await page.getByTestId("gm-flag-gaps").click();
      await expect(page.getByTestId("gm-flag-list").getByTestId("gm-gap")).toHaveCount(2);
    });
  });
}

test.describe("roles", () => {
  test.use(DESKTOP);

  test("an approver picks a metric; a viewer is sent to the metrics, never to a dead end", async ({ page }) => {
    // protects=approvers get Pick its metric and Place a feature; a viewer reads the same counts and
    // items with See metrics instead (no edit); fails_when=a viewer sees an edit or no way on;
    // no_claim=the API's 403 (pytest).
    await open(page, APPROVER);
    await expect(goal(page, "Revenue per day").getByTestId("gm-pick-metric")).toBeVisible();
    await page.getByTestId("gm-flag-gaps").click();
    await expect(page.getByTestId("gm-flag-list").getByTestId("gm-place").first()).toBeVisible();
  });

  test("a viewer", async ({ page }) => {
    await open(page, VIEWER);
    const rev = goal(page, "Revenue per day");
    await expect(rev.getByTestId("gm-pick-metric")).toHaveCount(0);
    await expect(rev.getByTestId("gm-see-metrics")).toHaveAttribute("href", "/company/metrics");
    await expect(goal(page, "Paid conversions per rep per day").getByTestId("gm-add-value")).toBeVisible();
    await page.getByTestId("gm-flag-gaps").click();
    const list = page.getByTestId("gm-flag-list");
    await expect(list.getByTestId("gm-gap")).toHaveCount(2);
    await expect(list.getByTestId("gm-place")).toHaveCount(0);
    // A viewer is told who can act.
    await expect(list.getByTestId("gm-gap-who")).toHaveText("Ask Dana Whitlock to place a feature.");
  });
});

test.describe("Home", () => {
  test.use(DESKTOP);

  test("a Home goal card opens its goal on the Goal map", async ({ page }) => {
    // protects=each Home goal card links to the Goal map on that goal; fails_when=the card has no
    // way to the map; no_claim=Home's other parts (another lane ports them).
    await page.context().addInitScript(([k, v]) => localStorage.setItem(k, v), [MOCK_SCENARIO_KEY, SCOREBOARD_SCENARIO] as const);
    await login(page, ADMIN.email);
    await page.goto("/simple");
    const card = page.getByTestId("home-goal").first();
    const link = card.getByTestId("home-goal-map");
    await expect(link).toHaveText("Goal map");
    await link.click();
    await expect(page).toHaveURL(/\/simple\/goals\?goal=/);
    await expect(page.getByTestId("gm-page")).toBeVisible();
  });

  test("Home's Goal map link rings its goal and scrolls to it", async ({ page }) => {
    // protects=Home's goals are the map's goals (one store, same ids): the link lands on the goal,
    // ringed and in view; fails_when=the map opens at the top with no goal picked.
    await page.setViewportSize({ width: 1440, height: 500 });
    await page.context().addInitScript(([k, v]) => localStorage.setItem(k, v), [MOCK_SCENARIO_KEY, SCOREBOARD_SCENARIO] as const);
    await login(page, VIEWER);
    await page.goto("/simple");
    await page.getByTestId("home-goal").filter({ hasText: "Revenue per day" }).getByTestId("home-goal-map").click();
    await expect(page).toHaveURL(/\/simple\/goals\?goal=/);
    const rev = goal(page, "Revenue per day");
    // Drawn with a ring (box-shadow), not only a class marker that could sit under its own shadow.
    await expect(rev).toHaveClass(/ring-accent/);
    await expect(rev).toBeInViewport();
    await expect(page.locator('[data-testid="ld-goal"][class*="ring-accent"]')).toHaveCount(1);
  });

  test("a Home goal with no number to aim at says it is not on the map yet", async ({ page }) => {
    // protects=a goal left off the map lands on a line naming it and why, with a way to it;
    // fails_when=the map opens at the top saying nothing.
    await page.context().addInitScript(([k, v]) => localStorage.setItem(k, v), [MOCK_SCENARIO_KEY, SCOREBOARD_SCENARIO] as const);
    await login(page, ADMIN.email);
    await page.goto("/simple");
    await page.getByTestId("home-goal").filter({ hasText: OFF_MAP }).getByTestId("home-goal-map").click();
    const off = page.getByTestId("gm-off-map");
    await expect(off).toContainText(`Not on the map yet: ${OFF_MAP} has no number to aim at`);
    await expect(off).toBeInViewport();
    await expect(off.getByRole("link", { name: "Open the goal" })).toHaveAttribute("href", /^\/simple\/priorities\?goal=/);
    await expect(page.locator('[data-testid="ld-goal"][class*="ring-accent"]')).toHaveCount(0);
  });
});
