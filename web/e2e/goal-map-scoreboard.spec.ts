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

const goal = (page: Page, name: string) => page.getByTestId("gm-goal").filter({ hasText: name });
const gate = (page: Page, name: string) => page.getByTestId("gm-ladder").getByTestId("gm-gate").filter({ hasText: name });

for (const scheme of ["light", "dark"] as const) {
  test.describe(`desktop ${scheme}`, () => {
    test.use(DESKTOP);

    test("each goal says where its reading comes from; the owner picks revenue's metric", async ({ page }) => {
      // protects=a measured goal names its metric; a metric with no value says so with Add a value;
      // no metric reads Not measured yet with Pick its metric, whose picker measures the goal at once
      // (goal card and its gates); fails_when=a not-measured gate is a dead end or the pick changes
      // nothing; no_claim=the metric's values (Company › Metrics).
      await open(page, ADMIN.email, scheme);
      await expect(goal(page, "Sign-ups per rep per day").getByTestId("gm-goal-source")).toHaveText(`From ${SCOREBOARD.measured}`);
      const conv = goal(page, "Paid conversions per rep per day");
      await expect(conv).toContainText("Not measured yet");
      await expect(conv.getByTestId("gm-goal-missing")).toHaveText(`No values yet from ${SCOREBOARD.empty}`);
      await expect(conv.getByTestId("gm-add-value")).toHaveAttribute("href", /^\/company\/metrics\?metric=/);
      const rev = goal(page, "Revenue per day");
      await expect(rev.getByTestId("gm-goal-missing")).toHaveText("No metric picked");
      const revGate = gate(page, "$12k revenue per day");
      await expect(revGate).toContainText("Not measured yet");
      await expect(revGate).toContainText("No metric picked");
      await revGate.getByTestId("gm-pick-metric").click();
      const picker = page.getByTestId("gm-editor");
      await expect(picker).toContainText("Pick the metric for Revenue per day");
      await expect(picker.getByTestId("gm-add-metric")).toHaveAttribute("href", "/company/metrics");
      await picker.getByRole("button", { name: new RegExp(SCOREBOARD.pick) }).click();
      await picker.getByTestId("gm-save").click();
      await expect(page.getByTestId("gm-flash")).toHaveText(`Revenue per day now reads ${SCOREBOARD.pick}.`);
      await expect(rev).toContainText("$11.2k");
      await expect(rev.getByTestId("gm-goal-source")).toHaveText(`From ${SCOREBOARD.pick}`);
      await expect(rev.getByTestId("gm-pick-metric")).toHaveCount(0);
      await expect(revGate).toContainText("On track");
      await expect(revGate.getByTestId("gm-gate-source")).toHaveText(`From ${SCOREBOARD.pick}`);
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
      await unplaced.click();
      const first = page.getByTestId("gm-flag-list").getByTestId("gm-unplaced").first();
      const name = (await first.locator("button").first().textContent())!;
      await first.getByTestId("gm-place").click();
      await expect(drawer.getByRole("button", { name: new RegExp(name) })).toHaveClass(/border-accent/);
      await drawer.getByRole("combobox").first().selectOption({ label: SCOREBOARD.gap });
      await drawer.getByRole("combobox").nth(1).selectOption({ label: "Customer safety" });
      await drawer.getByTestId("gm-save").click();
      await expect(gaps).toHaveCount(0);
      await expect(unplaced).toContainText(`${before - 1} `);
      await expect(page.getByTestId("gm-ladder").getByTestId("gm-feature").filter({ hasText: name })).toHaveCount(1);
    });

    test("Helping and Not helping say why behind an (i)", async ({ page }) => {
      // protects=a shipped feature's lift shows its goal's reading before it shipped and since; a
      // feature whose goal has no reading says Not measured yet; fails_when=Helping has no reason
      // or an unmeasured goal shows Helping; no_claim=how the API picks the ship date (pytest).
      await open(page, ADMIN.email, scheme);
      const helping = page.getByTestId("gm-ladder").getByTestId("gm-feature").filter({ hasText: "One-tap sign-up link" });
      await expect(helping.getByTestId("gm-lift")).toContainText("Helping");
      await helping.getByRole("button", { name: /^About Helping/ }).hover();
      await expect(helping.getByTestId("gm-lift-why")).toHaveText("Before it shipped on Oct 20: 24.8 · since: 31");
      const notHelping = page.getByTestId("gm-ladder").getByTestId("gm-feature").filter({ hasText: "Rep call script hints" });
      await expect(notHelping.getByTestId("gm-lift-why")).toHaveText("Before it shipped on Oct 20: 31 · since: 31", { useInnerText: false });
      const unmeasured = page.getByTestId("gm-ladder").getByTestId("gm-feature").filter({ hasText: "Trial reminder texts" });
      await expect(unmeasured.getByTestId("gm-lift")).toContainText("Not measured yet");
      await expect(unmeasured.getByTestId("gm-lift-why")).toHaveText("Not measured yet", { useInnerText: false });
      // The (i) does not open the feature: the card does.
      await expect(page.getByTestId("gm-feature-panel")).toHaveCount(0);
    });
  });

  test.describe(`phone ${scheme}`, () => {
    test.use(PHONE);

    test("on a phone the gates say what is missing and the flags open", async ({ page }) => {
      // protects=at 390 the gates read Not measured yet with their action and the counts open their
      // items; fails_when=either is cut off or missing on a phone.
      await open(page, ADMIN.email, scheme);
      const phone = page.getByTestId("gm-ladder-phone");
      const rev = phone.locator(".simple-card").filter({ hasText: /^\$12k revenue per day/ });
      await expect(rev).toContainText("No metric picked");
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
    await expect(rev.getByTestId("gm-goal-missing")).toHaveText("No metric picked");
    await expect(rev.getByTestId("gm-pick-metric")).toHaveCount(0);
    await expect(rev.getByTestId("gm-see-metrics")).toHaveAttribute("href", "/company/metrics");
    await expect(goal(page, "Paid conversions per rep per day").getByTestId("gm-add-value")).toBeVisible();
    await page.getByTestId("gm-flag-gaps").click();
    const list = page.getByTestId("gm-flag-list");
    await expect(list.getByTestId("gm-gap")).toHaveCount(2);
    await expect(list.getByTestId("gm-place")).toHaveCount(0);
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
});
