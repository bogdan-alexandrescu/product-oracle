import { expect, test, type Page } from "./test";

import { MOCK_FAIL_KEY, MOCK_ROLE_KEY, MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { ADMIN, login, openSection, sectionAction } from "./helpers";

/*
 * Visual QA pass F, first-run setup, error and not-found pages, Oracle's work and the run
 * ticker (F-8, F-11, F-24, F-27, F-28, F-29, F-31, F-34, F-35, F-39, F-78), through the UI
 * on the mock build. F-26 is in qa4-simple-decide-meeting and simple-meeting-end.
 */

/** A new company (the "empty" scenario), the mock's store reset once (later loads keep what the test did). */
async function newCompany(page: Page) {
  await page.context().addInitScript(
    ([key, value]) => {
      if (!sessionStorage.getItem("pass-f-setup")) {
        localStorage.removeItem("po-mock-db-v2");
        sessionStorage.setItem("pass-f-setup", "1");
      }
      localStorage.setItem(key, value);
    },
    [MOCK_SCENARIO_KEY, "empty"] as const,
  );
}

const failSetup = (page: Page) => page.context().addInitScript(([key]) => localStorage.setItem(key, "/v1/setup"), [MOCK_FAIL_KEY] as const);
const unfail = (page: Page) => page.evaluate((key) => localStorage.removeItem(key), MOCK_FAIL_KEY);

/** The Detailed rail's Mode switch: Simple, landing on Simple's Home. */
async function toSimple(page: Page) {
  await page.getByRole("navigation", { name: "Oracle" }).getByRole("radiogroup", { name: "Mode" }).getByRole("radio", { name: "Simple" }).click();
  await expect(page).toHaveURL(/\/simple$/);
  await expect(page.getByTestId("simple-page").getByTestId("home-sentence")).toBeVisible();
}

const simpleSetup = (page: Page) => page.getByTestId("simple-page").getByTestId("home-setup");

for (const width of [1440, 390]) {
  for (const scheme of ["light", "dark"] as const) {
    test.describe(`${width} px · ${scheme}`, () => {
      test.use({ viewport: { width, height: width < 600 ? 844 : 900 }, colorScheme: scheme });

      test("F-8: a Set up that fails to load says so on Detailed Home, and Try again brings it", async ({ page }) => {
        await newCompany(page);
        await failSetup(page);
        await login(page, ADMIN.email);
        await page.goto("/home");
        const failed = page.getByTestId("load-error");
        await expect(failed).toContainText("Couldn't load Set up.");
        await unfail(page);
        await failed.getByRole("button", { name: "Try again" }).click();
        await expect(page.getByTestId("home-setup")).toBeVisible();
        await expect(page.getByTestId("load-error")).toHaveCount(0);
      });

      test("F-11: an unknown tech brief is the not-found page, with Back to PRDs and Go to Home", async ({ page }) => {
        await login(page);
        await page.goto("/briefs/00000000-0000-4000-8000-000000000000");
        await expect(page.getByRole("heading", { level: 1, name: "Tech brief not found" })).toBeVisible();
        const panel = page.getByTestId("brief-not-found");
        await expect(panel.getByRole("link", { name: "Go to Home" })).toBeVisible();
        await panel.getByRole("link", { name: "Back to PRDs" }).click();
        await expect(page).toHaveURL(/\/documents$/);
      });

      test("F-24: Slack pings explain behind the (i); on a phone each row is a 44 px tap target", async ({ page }) => {
        await login(page);
        await page.goto("/account");
        const panel = page.getByTestId("slack-pings");
        await expect(panel.getByTestId("ping-review_requested")).toBeVisible();
        await expect(panel.getByRole("button", { name: "About Slack pings" })).toBeVisible();
        await expect(panel.getByText("sends you a direct message")).toBeHidden();
        if (width < 600) {
          const row = (await panel.locator("label").filter({ has: page.getByTestId("ping-draft_ready") }).boundingBox())!;
          expect(row.height).toBeGreaterThanOrEqual(44);
          const box = (await panel.getByTestId("ping-draft_ready").boundingBox())!;
          expect(box.width).toBeGreaterThanOrEqual(24);
        }
      });

      test("F-29: Set up's step names and figures are never cut", async ({ page }) => {
        await newCompany(page);
        await login(page, ADMIN.email);
        await page.goto("/home");
        const row = page.getByTestId("setup-row-domains");
        await expect(row).toBeVisible();
        for (const part of [row.locator("span.font-semibold"), row.getByTestId("setup-status")]) {
          expect(await part.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
        }
      });

      test("F-31: the Goals (i) names no command or file format", async ({ page }) => {
        await newCompany(page);
        await login(page, ADMIN.email);
        await page.goto("/home");
        const empty = page.getByTestId("home-goals-empty");
        await empty.getByRole("button", { name: "About building the baseline" }).click();
        await expect(empty).toContainText("You can also send a baseline file from the command line.");
        await expect(empty).not.toContainText("oracle push");
        await expect(empty).not.toContainText("YAML");
      });

      test("F-39: a paused run's notice is one short line, and a commenter is not told to cancel", async ({ page }) => {
        await login(page, "commenter@example.com");
        await page.goto("/runs");
        await page.locator('[data-testid="run-row"][data-document="team-workspaces"]').getByRole("link").first().click();
        await expect(page).toHaveURL(/\/runs\/[0-9a-f-]+$/);
        await expect(page.getByTestId("run-overrun-held")).toHaveText("Paused: over budget. An owner can resume it.");
      });
    });
  }
}

test.describe("Simple Home", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("F-8: a Set up that fails to load says so on Simple Home, and Try again brings it", async ({ page }) => {
    await newCompany(page);
    await login(page, ADMIN.email);
    await toSimple(page);
    await expect(simpleSetup(page).getByRole("heading", { name: "Welcome: set up Oracle" })).toBeVisible();
    await page.evaluate((key) => localStorage.setItem(key, "/v1/setup"), MOCK_FAIL_KEY);
    await page.reload();
    // Round 1: Simple's failure is Detailed's error note, not a grey bar with a check icon.
    const failed = page.getByTestId("simple-page").getByTestId("load-error");
    await expect(failed).toContainText("Couldn't load Set up.");
    await expect(failed).toHaveAttribute("role", "alert");
    await unfail(page);
    await failed.getByRole("button", { name: "Try again" }).click();
    await expect(simpleSetup(page).getByRole("heading", { name: "Welcome: set up Oracle" })).toBeVisible();
  });

  test("F-27, F-28: a finished step opens too, and a hidden Set up comes back from Home's menu", async ({ page }) => {
    await newCompany(page);
    await login(page, ADMIN.email);
    await toSimple(page);
    const invite = simpleSetup(page).getByTestId("home-setup-step").filter({ hasText: "Invite team" });
    await expect(invite.getByRole("img", { name: "Done" })).toBeVisible();
    await expect(invite.getByRole("link", { name: "Invite team" })).toHaveAttribute("href", /\/settings\/members\?from=simple-setup/);

    await simpleSetup(page).getByRole("button", { name: "Hide" }).click();
    await expect(simpleSetup(page)).toHaveCount(0);
    // Round 2: the toast says what happened, with Show; no how-to sentence.
    const toastBox = page.getByTestId("toasts").getByRole("status");
    await expect(toastBox).toHaveText(/^Set up hiddenShow$/);
    await toastBox.getByRole("button", { name: "Show" }).click();
    await expect(simpleSetup(page).getByRole("heading", { name: "Welcome: set up Oracle" })).toBeVisible();
    await simpleSetup(page).getByRole("button", { name: "Hide" }).click();
    await expect(simpleSetup(page)).toHaveCount(0);
    // The owner's pick (Nov 5): no chip in the card's place; Show Set up is in Home's menu.
    await expect(page.getByTestId("simple-page").getByTestId("home-setup-chip")).toHaveCount(0);
    const menu = page.getByTestId("home-greeting").getByRole("button", { name: "Home menu" });
    // Round 2: drawn with the app's "more" icon, not a text glyph (a missing-glyph box in Chromium).
    await expect(menu.locator("svg")).toHaveCount(1);
    await expect(menu).toHaveText("");
    await menu.click();
    await page.getByRole("menu").getByRole("menuitem", { name: "Show Set up" }).click();
    await expect(simpleSetup(page).getByRole("heading", { name: "Welcome: set up Oracle" })).toBeVisible();
    await expect(page.getByRole("menu")).toHaveCount(0);
    await reload(page);
    await expect(simpleSetup(page).getByRole("heading", { name: "Welcome: set up Oracle" })).toBeVisible();
  });
});

const reload = async (page: Page) => {
  await page.reload();
  await expect(page.getByTestId("simple-page").getByTestId("home-sentence")).toBeVisible();
};

test.describe("Round 1: a viewer, who has no Set up steps, is not told Set up failed to load", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("on Detailed and Simple Home", async ({ page }) => {
    await newCompany(page);
    await page.context().addInitScript(([key]) => localStorage.setItem(key, "viewer"), [MOCK_ROLE_KEY] as const);
    await failSetup(page);
    await login(page, ADMIN.email);
    await page.goto("/home");
    await expect(page.getByRole("heading", { level: 1, name: "Home" })).toBeVisible();
    await page.waitForTimeout(1500);
    await expect(page.locator("main")).not.toContainText("Couldn't load Set up");
    await page.goto("/simple");
    await expect(page.getByTestId("simple-page").getByTestId("home-sentence")).toBeVisible();
    await page.waitForTimeout(1500);
    await expect(page.getByTestId("simple-page")).not.toContainText("Couldn't load Set up");
  });
});

test.describe("F-34: a new company has no seed decisions or features, whoever looks", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("an approver's Home waits on nothing", async ({ page }) => {
    await newCompany(page);
    await login(page, "approver@example.com");
    await page.goto("/home");
    await expect(page.getByRole("heading", { level: 1, name: "Home" })).toBeVisible();
    await expect(page.locator("main")).toContainText("Nothing waiting");
    await expect(page.locator("main")).not.toContainText("Ship usage caps before anomaly detection");
    await expect(page.locator("main")).not.toContainText("Price the team plan per seat");
  });

  test("a viewer's Simple Home has no decisions of its own", async ({ page }) => {
    await newCompany(page);
    await page.context().addInitScript(([key]) => localStorage.setItem(key, "viewer"), [MOCK_ROLE_KEY] as const);
    await login(page, ADMIN.email);
    await page.goto("/simple");
    await expect(page.getByTestId("simple-page").getByTestId("home-sentence")).toBeVisible();
    await expect(page.getByTestId("home-decided-row")).toHaveCount(0);
  });

  test("Desired state lists no seed feature", async ({ page }) => {
    await newCompany(page);
    await login(page, ADMIN.email);
    await page.goto("/baseline");
    await expect(page.getByRole("heading", { level: 1, name: "Desired state" })).toBeVisible();
    // Round 1: the count has loaded (the old mock listed the Plan's "Threshold alerts" here).
    await expect(page.getByTestId("cs-tabs").getByRole("tab", { name: /^Desired state/ })).toHaveText("Desired state 0");
    await expect(page.getByTestId("cs-desired")).toHaveCount(0);
    await expect(page.locator("main")).not.toContainText("Threshold alerts");
  });
});

test.describe("F-35: Oracle's work names a section by its name", () => {
  for (const width of [1440, 390]) {
    test(`a section rewrite reads "3. Users and jobs", never its key (${width} px)`, async ({ page }) => {
      await page.setViewportSize({ width, height: width < 600 ? 844 : 900 });
      await login(page, "approver@example.com");
      await page.goto("/documents/checkout-redesign/v/2");
      const users = await openSection(page, "users");
      await sectionAction(users, "3. Users and jobs", /^Ask Oracle to rewrite/);
      const refine = users.getByTestId("refine-panel");
      await refine.getByLabel("Instruction").fill("Name the first-time buyer segment explicitly.");
      await refine.getByRole("button", { name: "Refine", exact: true }).click();
      await expect(refine.getByRole("button", { name: "Edit first" })).toBeVisible();
      await refine.getByRole("button", { name: "Close" }).click();
      if (width < 600) await page.getByTestId("phone-review").click();
      await page.getByRole("tab", { name: /^History/ }).filter({ visible: true }).click();
      const job = page.getByTestId("jobs-panel").filter({ visible: true }).getByTestId("llm-job").filter({ hasText: "3. Users and jobs" }).first();
      await expect(job).toContainText("Revision of 3. Users and jobs is ready to review");
      await expect(page.getByTestId("jobs-panel").filter({ visible: true })).not.toContainText("#users");
    });
  }
});

/** A run on Usage alerts PRD, started from the Plan, on its run page; returns its Roadmap items step. */
async function startRun(page: Page) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page);
  await page.getByRole("navigation", { name: "Oracle" }).getByRole("link", { name: "Plan", exact: true }).click();
  await page.getByTestId("plan-tabs").filter({ visible: true }).getByRole("link", { name: "Roadmap documents" }).click();
  await page.getByTestId("approved-prd").filter({ hasText: "Usage alerts PRD" }).getByRole("button", { name: "Build roadmap" }).click();
  const dialog = page.getByRole("dialog", { name: "Build roadmap" });
  await dialog.getByRole("button", { name: "Estimate" }).click();
  await dialog.getByRole("button", { name: "Start run" }).click();
  await expect(page).toHaveURL(/\/runs\/[0-9a-f-]+$/);
  return page.getByTestId("segment-roadmap_items");
}

test("F-78: a long wait reads in days, says last update, and a step not heard from in six hours says since when", async ({ page }) => {
  await page.addInitScript((key) => localStorage.setItem(key, "slow-agents"), MOCK_SCENARIO_KEY);
  const items = await startRun(page);
  const progress = items.getByTestId("segment-progress");
  await page.getByRole("button", { name: "Refresh progress" }).click();
  const first = items.getByTestId("segment-agent").first();
  await expect(first.getByTestId("agent-heartbeat")).toContainText(/^last (update|proposal|activity) /);
  await expect(progress.getByTestId("segment-no-news")).toHaveCount(0);

  // The owner's pick (Nov 5): six hours without news, not a day.
  await page.clock.fastForward(5 * 3600_000);
  await expect(progress).toContainText(/checked 5h 0\dm ago/);
  await expect(progress.getByTestId("segment-no-news")).toHaveCount(0);
  await page.clock.fastForward(2 * 3600_000);
  await expect(progress.getByTestId("segment-no-news")).toHaveText(/^No news since [A-Z][a-z]{2} \d{1,2}/);

  await page.clock.fastForward(65 * 3600_000);
  await expect(progress).toContainText(/checked 3 days ago/);
  await expect(first.getByTestId("agent-elapsed")).toHaveText(/^3 days elapsed$/);
  await expect(progress.getByTestId("segment-no-news")).toHaveText(/^No news since [A-Z][a-z]{2} \d{1,2}/);
  await expect(progress).not.toContainText(/\d{2,}h \d{2}m/);
  // Round 1: the page's own Refresh progress and Cancel run are not repeated beside the warning;
  // its (i) says where they are.
  await expect(progress.getByRole("button", { name: "Refresh progress" })).toHaveCount(0);
  await expect(progress.getByRole("button", { name: "Cancel run" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Refresh progress" })).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Cancel run" })).toHaveCount(1);
  await progress.getByRole("button", { name: "About no news" }).click();
  await expect(progress.getByRole("tooltip")).toContainText("Refresh progress");
});

test("F-78, round 1: a step checked a minute ago whose agents last sent news 7 hours ago says since when", async ({ page }) => {
  // "stuck-agents": each check reads the agents again (checked_at now), but they send nothing new.
  await page.addInitScript((key) => localStorage.setItem(key, "stuck-agents"), MOCK_SCENARIO_KEY);
  const items = await startRun(page);
  const progress = items.getByTestId("segment-progress");
  await page.getByRole("button", { name: "Refresh progress" }).click();
  const first = items.getByTestId("segment-agent").first();
  await expect(first.getByTestId("agent-heartbeat")).toContainText(/^last update \d+s ago/);
  await expect(progress.getByTestId("segment-no-news")).toHaveCount(0);

  await page.clock.fastForward(7 * 3600_000);
  await page.getByRole("button", { name: "Refresh progress" }).click();
  await expect(progress).toContainText(/checked \d+s ago/);
  await expect(first.getByTestId("agent-heartbeat")).toContainText(/^last update 7h 0\dm ago/);
  await expect(progress.getByTestId("segment-no-news")).toHaveText(/^No news since [A-Z][a-z]{2} \d{1,2}/);
});
