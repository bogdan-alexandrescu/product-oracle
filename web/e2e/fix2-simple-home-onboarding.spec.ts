import { expect, test, type Page } from "./test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { ADMIN, login } from "./helpers";

/*
 * qa-onboarding-4 and qa-onboarding-48 (desktop, mock-backed, through the UI only): a new
 * company's owner who switches to Simple gets the welcome and the Set up checklist on Simple's
 * Home, follows its steps from there and comes back to it through the rail's Mode switch; the
 * card counts each step done and goes away once every step is. Who has no step (a viewer) gets
 * no card.
 * no_claim: the API's /v1/setup (api/tests/test_setup.py; the mock stands in), Build the
 * baseline and Pick sources on a new company (a run and a provider pick: setup.spec and
 * baseline-build.spec cover them on Detailed's checklist).
 */

test.use({ viewport: { width: 1440, height: 900 } });

/** The scenario, with the mock's company store reset once at the start (later loads keep what the test did). */
async function scenario(page: Page, name: string) {
  await page.context().addInitScript(
    ([key, value]) => {
      if (!sessionStorage.getItem("fix2-onboarding")) {
        localStorage.removeItem("po-mock-db-v2");
        sessionStorage.setItem("fix2-onboarding", "1");
      }
      localStorage.setItem(key, value);
    },
    [MOCK_SCENARIO_KEY, name] as const,
  );
}

// Detailed Home stays mounted behind Simple (ModeRoot), with its own "home-setup": read Simple's page only.
const setupCard = (page: Page) => page.getByTestId("simple-page").getByTestId("home-setup");
const progress = (page: Page) => setupCard(page).getByTestId("home-setup-progress");
const step = (page: Page, label: string) => setupCard(page).getByTestId("home-setup-step").filter({ hasText: label });

/** The Detailed rail's Mode switch: Simple, landing on Simple's Home. */
async function toSimple(page: Page) {
  await page.getByRole("navigation", { name: "Oracle" }).getByRole("radiogroup", { name: "Mode" }).getByRole("radio", { name: "Simple" }).click();
  await expect(page).toHaveURL(/\/simple$/);
  await expect(page.getByTestId("simple-page").getByTestId("home-sentence")).toBeVisible();
}

/** Opens a step from Simple's Home by its name. */
async function openStep(page: Page, label: string, url: RegExp) {
  await setupCard(page).getByRole("link", { name: label, exact: true }).click();
  await expect(page).toHaveURL(url);
}

async function connectTools(page: Page) {
  await openStep(page, "Connect your tools", /\/settings\/connections\?from=setup$/);
  const slack = page.getByTestId("connection-card-slack");
  await slack.getByRole("button", { name: "Paste a token" }).click();
  await slack.getByLabel("Token", { exact: true }).fill("example-slack-1234");
  await slack.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(slack.getByText("Connected")).toBeVisible();
  await toSimple(page);
}

async function checkHorizons(page: Page) {
  await openStep(page, "Check the planning horizons", /\/settings\/company\?from=setup#horizons$/);
  // Settings' panels all say Save; unchanged defaults are confirmed by it (qa-settings-18).
  await page.locator("#horizons").getByRole("button", { name: "Save" }).click();
  await expect(page.locator("#horizons").getByRole("button", { name: "Reset" })).toBeVisible();
  await toSimple(page);
}

async function setZone(page: Page) {
  await openStep(page, "Set the company time zone", /\/settings\/company\?from=setup#timezone$/);
  // Save waits for a zone to be picked (fix2-settings: "Not set" never stores Los Angeles).
  await page.getByLabel("Company time zone").selectOption("America/Los_Angeles");
  await page.getByTestId("timezone-panel").getByRole("button", { name: "Save" }).click();
  await expect(page.getByTestId("timezone-panel").getByRole("status")).toHaveText("Saved");
  await toSimple(page);
}

async function nameLead(page: Page) {
  await openStep(page, "Name the engineering lead", /\/settings\/members\?from=setup#engineering-lead$/);
  const box = page.getByRole("checkbox", { name: "Engineering lead: approver@example.com" });
  await box.check();
  await expect(box).toBeChecked();
  await toSimple(page);
}

test("qa-onboarding-48: a new company's owner switches to Simple, sees the setup card and works through its steps", async ({ page }) => {
  // fails_when: Simple's Home has no welcome or Set up for a new owner, a step's link goes nowhere,
  // a step done stays open, or Home shows plan, meeting or broken links a new company has not got
  await scenario(page, "empty");
  await login(page, ADMIN.email);
  await toSimple(page);

  // The welcome and its steps, first on a new company's Home (above the empty goal band).
  await expect(setupCard(page).getByRole("heading", { name: "Welcome: set up Oracle" })).toBeVisible();
  await expect(setupCard(page)).toContainText("connect your tools, pick the sources it reads, then build the baseline");
  await expect(progress(page)).toHaveText("2 of 8 done");
  await expect(setupCard(page).getByTestId("home-setup-step")).toHaveText([
    "Connect your tools",
    "Pick your sources",
    /^Invite your team\s*Done$/,
    /^Add the company's email domains\s*Done$/,
    "Name the engineering lead",
    "Check the planning horizons",
    "Set the company time zone",
    "Build the baseline",
  ]);
  const card = (await setupCard(page).boundingBox())!;
  const goals = (await page.getByTestId("simple-page").getByTestId("home-goals").boundingBox())!;
  expect(card.y + card.height).toBeLessThanOrEqual(goals.y);

  // A new company has nothing planned yet: no goals, plan, meeting, decisions or broken links.
  await expect(page.getByTestId("simple-page").getByTestId("home-goals-empty")).toHaveText("No confirmed company goals yet.");
  await expect(page.getByTestId("simple-page").getByTestId("home-plan-empty")).toHaveText("Nothing planned this quarter yet.");
  await expect(page.getByTestId("simple-page").getByTestId("home-meeting-empty")).toHaveText("No review meeting scheduled.");
  await expect(page.getByTestId("simple-page").getByTestId("home-decisions-empty")).toBeVisible();
  await expect(page.getByTestId("simple-page").getByTestId("home-summary-broken-links").locator(".simple-number")).toHaveText("0");
  await expect(page.getByTestId("simple-page").getByTestId("home-broken")).toHaveCount(0);
  await expect(page.getByTestId("simple-page").getByTestId("home-sentence")).toHaveText("Nothing waits on you today.");

  // Each step from Simple's Home and back through the rail: the card counts it done.
  await connectTools(page);
  await expect(progress(page)).toHaveText("3 of 8 done");
  await expect(step(page, "Connect your tools")).toContainText("Done");
  await expect(step(page, "Connect your tools").getByRole("link")).toHaveCount(0);
  await checkHorizons(page);
  await expect(progress(page)).toHaveText("4 of 8 done");
  await setZone(page);
  await expect(progress(page)).toHaveText("5 of 8 done");
  await nameLead(page);
  await expect(progress(page)).toHaveText("6 of 8 done");
  // Sources and the baseline are still to do: the card stays, each still one click away.
  await expect(setupCard(page).getByRole("link", { name: "Pick your sources", exact: true })).toHaveAttribute("href", "/settings/sources?from=setup");
  await expect(setupCard(page).getByRole("link", { name: "Build the baseline", exact: true })).toHaveAttribute("href", "/baseline?build=1");
  await openStep(page, "Build the baseline", /\/baseline\?build=1$/);
});

test("qa-onboarding-4: an established company's Simple Home has no setup card", async ({ page }) => {
  // fails_when: the card closes an established company's Simple Home (its picked design) while a step is open
  // The default company: its goals are set, four setup steps still open.
  await login(page, ADMIN.email);
  await toSimple(page);
  await expect(page.getByTestId("simple-page").getByTestId("home-goal").first()).toBeVisible();
  await expect(setupCard(page)).toHaveCount(0);
});

test("qa-onboarding-4: a commenter sees their own two steps", async ({ page }) => {
  await scenario(page, "empty");
  await login(page, "commenter@example.com");
  await page.goto("/simple");
  await expect(progress(page)).toHaveText("0 of 2 done");
  await expect(setupCard(page).getByTestId("home-setup-step")).toHaveText(["Connect your tools", "Pick your sources"]);
});

test("qa-onboarding-4: a viewer gets no setup card", async ({ page }) => {
  await scenario(page, "empty");
  await login(page, "viewer@example.com");
  await page.goto("/simple");
  await expect(page.getByTestId("simple-page").getByTestId("home-sentence")).toBeVisible();
  await expect(page.getByTestId("simple-page").getByTestId("home-goals-empty")).toBeVisible();
  await expect(setupCard(page)).toHaveCount(0);
});
