import { LADDER_TRACK_OWNER_SCENARIO } from "../lib/api/mock/goal-ladder";
import { MOCK_ROLE_KEY, MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";
import { expect, test, type Page } from "./test";

/*
 * milestone-routes: a milestone proposal goes where the API sends it. A roadmap's own milestone
 * and a goal's own milestone (key_dates.route): the roadmap's decider, else the owners of its
 * tracks who are approvers or owners, else the company's owners. A PRD's milestone: the PRD's
 * owners, else the company's owners. A Goal map ask to put a feature on a milestone goes the same way
 * (goal_map_asks: key_dates.route). Mock scenarios "simple-milestones-track-owner" (Nora Vance,
 * an invented approver, owns the Usage alerts and Guided setup tracks; no decider) and
 * "simple-prd-milestones" (Nora Vance owns Usage alerts' track) and "goal-ladder-track-owner" (she
 * owns the onboarding track the Goal ladder's features are on); invented goals and people.
 */

const APPROVER = "approver@example.com";
const NORA = "nora.vance@example.com";

test.use({ viewport: { width: 1440, height: 900 } });

async function open(page: Page, scenario: string, email?: string) {
  await page.context().addInitScript(([key, value]) => localStorage.setItem(key, value), [MOCK_SCENARIO_KEY, scenario] as const);
  await login(page, email);
  await page.goto("/simple/roadmap");
  await expect(page.getByTestId("simple-roadmap")).toBeVisible();
}

const label = (page: Page, code: string) => page.getByTestId("ms-label").filter({ hasText: new RegExp(`^${code} `) });
const card = (page: Page) => page.getByTestId("ms-card");

/** Proposes a new name from the milestone's card on the roadmap. */
async function proposeName(page: Page, code: string, name: string) {
  await label(page, code).click();
  await expect(card(page)).toHaveAttribute("data-rights", "propose");
  await card(page).getByLabel("Name", { exact: true }).fill(name);
  await card(page).getByTestId("ms-propose").click();
  await expect(page.getByTestId("ms-toast")).toContainText(`Proposed a change to ${code}`);
}

/** The proposer's own proposal on Home, waiting for `who`. */
async function waitsFor(page: Page, who: string) {
  await page.goto("/simple");
  const mine = page.getByTestId("home-proposals").getByTestId("home-proposal");
  await expect(mine).toHaveCount(1);
  await expect(mine).toContainText(`Waiting for ${who}`);
}

async function signOut(page: Page) {
  await page.getByTestId("user-menu").click();
  await page.getByRole("dialog", { name: "Account" }).getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login/);
}

test("a roadmap's own milestone: the proposal goes to the roadmap's track owner, who decides it", async ({ page }) => {
  await open(page, "simple-milestones-track-owner", APPROVER);
  await proposeName(page, "M1", "Alerts live for 70 teams");
  await waitsFor(page, "Nora Vance");

  await signOut(page);
  await login(page, NORA);
  await page.goto("/simple/roadmap");
  await page.getByTestId("needs-decision").click();
  const row = page.getByTestId("decision-tray").getByTestId("tray-proposal").filter({ hasText: "Milestone 'M1 Alerts live for 50 teams': change it" });
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: "Accept" }).click();
  await expect(row).toHaveCount(0);
  await page.getByTestId("decision-tray").getByRole("button", { name: "Close" }).click();
  await expect(label(page, "M1")).toContainText("M1 Alerts live for 70 teams");
});

test("a goal's own milestone: the proposal goes to its roadmap's track owner", async ({ page }) => {
  await open(page, "simple-milestones-track-owner", APPROVER);
  await proposeName(page, "M5", "Ninety teams activated");
  await waitsFor(page, "Nora Vance");
});

test("with no track owner who decides, a roadmap's own milestone's proposal goes to the company's owner", async ({ page }) => {
  await open(page, "simple-milestones", APPROVER);
  await proposeName(page, "M1", "Alerts live for 70 teams");
  await waitsFor(page, "Avery Stone");
});

test("a PRD's milestone: the ask goes to the PRD's owner", async ({ page }) => {
  await open(page, "simple-prd-milestones", APPROVER);
  await page.getByTestId("ms-prd-label").filter({ hasText: /^M\d+ Digest for all teams$/ }).click();
  const prd = page.getByTestId("ms-prd-card");
  await prd.getByLabel("Date").fill("2027-01-20");
  await prd.getByRole("button", { name: "Ask to change it" }).click();
  await expect(page.getByTestId("ms-toast")).toContainText(/to move M\d+ Digest for all teams/);
  await waitsFor(page, "Nora Vance");
});

test("a Goal map ask to put a feature on a milestone goes to the roadmap's track owner", async ({ page }) => {
  // protects=a commenter's link_goal_map ask, with no decider, waits for the owner of the roadmap's
  // track who decides (Nora Vance); fails_when=it waits for the company's owners instead.
  await page.context().addInitScript(([k, v]) => localStorage.setItem(k, v), [MOCK_SCENARIO_KEY, LADDER_TRACK_OWNER_SCENARIO] as const);
  await page.context().addInitScript(([k, v]) => localStorage.setItem(k, v), [MOCK_ROLE_KEY, "commenter"] as const);
  await login(page);
  await page.goto("/simple/goals");
  await expect(page.getByTestId("ld-goal").first()).toBeVisible();
  await page.getByTestId("ld-edit").click();
  const feature = page.getByTestId("ld-feature").filter({ has: page.locator(".simple-code", { hasText: /^F-66$/ }) });
  await feature.getByTestId("ld-more").first().click();
  await page.getByRole("menuitem", { name: "Move to…", exact: true }).click();
  await page.getByTestId("ld-move-sheet").locator("label").filter({ hasText: "Mobile check-ins weekly for half of teams" }).first().click();
  await page.getByTestId("ld-move-go").click();
  await expect(page.getByRole("status").filter({ hasText: "Suggested: move" })).toContainText("Mobile check-ins weekly for half of teams");
  await waitsFor(page, "Nora Vance");
});
