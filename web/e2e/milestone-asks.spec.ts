import { MOCK_NOW } from "../lib/api/mock/clock";
import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login, signOut } from "./helpers";
import { expect, test, type Page } from "./test";

/**
 * stuck-ask-minors: the changes asked of a PRD's milestone ("asks"), as the mock makes, sends and
 * shows them, driven through the UI. A PRD's owners are its tracks' owners only (drafts.who), in
 * person id order (scenarios "simple-prd-milestones": Usage alerts' track owned by Nora Vance;
 * "simple-prd-milestone-stuck": owned by Priya Raman (approver@example.com), Theo Brandt
 * (commenter@example.com) its required reviewer, asks on Nov 3, 4 and 5 waiting;
 * "simple-prd-milestones-gone": the same with every Usage alerts milestone gone;
 * "simple-prd-milestone-track-owner": the stuck one with Rowan Pike (rowan.pike@example.com) owning
 * its track instead, Jun Park a second of its tracks, and a second member also named Priya Raman).
 *
 * fails_when: a second ask of one date shares the first's id, so it cannot be declined; asking
 * again closes the older ask; an ask names no one it waits for; the PRD's required reviewer does
 * not see an ask decided; the PRD's owner may not decline an ask once all its milestones are gone;
 * an ask is sent to someone who owns none of the PRD's tracks, or not to its track owners in id
 * order; the milestone names an owner other than the PRD's first track owner by id; the scenario's
 * members take new ids on each seed, so which owner it names changes from one browser to the next;
 * the PRD's track owner may not decide a live milestone's ask;
 * no_claim: the API's own rules (api/tests/test_simple_goal_milestones_api.py).
 */

async function open(page: Page, scenario: string, path: string, email?: string) {
  await page.context().addInitScript(([key, value]) => localStorage.setItem(key, value), [MOCK_SCENARIO_KEY, scenario] as const);
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page, email);
  await page.goto(path);
}

/** Asks the PRD's owner, from M2 Digest for all teams' card on the roadmap, to move it to `date`. */
async function ask(page: Page, date: string) {
  await expect(page.getByTestId("simple-roadmap")).toBeVisible();
  await page.getByTestId("ms-prd-label").filter({ hasText: "M2 Digest for all teams" }).click();
  const prd = page.getByTestId("ms-prd-card");
  await prd.getByLabel("Date").fill(date);
  await prd.getByRole("button", { name: "Ask to change it" }).click();
  await expect(page.getByTestId("ms-toast")).toContainText("to move M2 Digest for all teams");
  await page.keyboard.press("Escape");
}

const homeAsks = (page: Page) => page.getByTestId("home-proposals").getByTestId("home-proposal");

test("two asks to move a PRD milestone to the same date are each declined on Home", async ({ page }) => {
  await open(page, "simple-prd-milestones", "/simple/roadmap");
  await ask(page, "2027-01-20");
  await page.reload();
  await ask(page, "2027-01-20");
  await page.goto("/simple");
  const asks = homeAsks(page);
  await expect(asks).toHaveCount(2);
  await asks.first().getByRole("button", { name: "Decline" }).click();
  await expect(page.getByText("Declined", { exact: true })).toBeVisible();
  await expect(asks).toHaveCount(1);
  await asks.first().getByRole("button", { name: "Decline" }).click();
  await expect(asks).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId("home-proposal")).toHaveCount(0);
});

test("asking again leaves the older ask waiting: it can only be declined, the newer one stays", async ({ page }) => {
  await open(page, "simple-prd-milestones", "/simple/roadmap");
  await ask(page, "2027-01-20");
  await page.reload();
  await ask(page, "2027-02-02");
  await page.goto("/simple");
  const asks = homeAsks(page);
  await expect(asks).toHaveCount(2);
  // Newest first: the older ask is the second. Accepting it is refused, in words, and both stay.
  const older = asks.nth(1);
  await older.getByRole("button", { name: "Accept" }).click();
  await expect(page.getByText("This proposal no longer waits on this milestone")).toBeVisible();
  await expect(asks).toHaveCount(2);
  await older.getByRole("button", { name: "Decline" }).click();
  await expect(page.getByText("Declined", { exact: true })).toBeVisible();
  await expect(asks).toHaveCount(1);
  // The one left is the one the milestone waits on: accepting it goes through.
  await asks.first().getByRole("button", { name: "Accept" }).click();
  await expect(asks).toHaveCount(0);
});

test("an ask waits for the PRD's owner by name", async ({ page }) => {
  await open(page, "simple-prd-milestone-stuck", "/simple/roadmap", "commenter@example.com");
  await ask(page, "2027-01-20");
  await page.goto("/simple");
  const proposals = page.getByTestId("home-proposals");
  await expect(proposals.getByRole("heading", { name: "Your proposals waiting" })).toBeVisible();
  await expect(proposals.getByTestId("home-proposal")).toHaveCount(1);
  await expect(proposals.getByTestId("home-proposal")).toContainText("Waiting for Priya Raman");
});

test("the PRD's required reviewer sees an ask once it is declined", async ({ page }) => {
  await open(page, "simple-prd-milestone-stuck", "/simple");
  const stuck = homeAsks(page).filter({ hasText: "Nov 4," });
  await stuck.getByRole("button", { name: "Decline" }).click();
  await expect(page.getByText("Declined", { exact: true })).toBeVisible();
  await expect(stuck).toHaveCount(0);
  await signOut(page);
  await login(page, "commenter@example.com");
  await page.goto("/simple");
  const since = page.getByTestId("home-since");
  await expect(since).toBeVisible();
  await expect(since).toContainText("Sam Lee");
});

test("the PRD's owner declines an ask on Home when all its milestones are gone", async ({ page }) => {
  await open(page, "simple-prd-milestones-gone", "/simple", "approver@example.com");
  const proposals = page.getByTestId("home-proposals");
  await expect(proposals.getByRole("heading", { name: "Proposals on your items" })).toBeVisible();
  const gone = homeAsks(page).filter({ hasText: "Nov 3," });
  await expect(gone).toHaveCount(1);
  await gone.getByRole("button", { name: "Accept" }).click();
  await expect(page.getByText("The milestone is gone")).toBeVisible();
  await gone.getByRole("button", { name: "Decline" }).click();
  await expect(page.getByText("Declined", { exact: true })).toBeVisible();
  await expect(gone).toHaveCount(0);
  await page.reload();
  await expect(proposals.getByRole("heading", { name: "Proposals on your items" })).toBeVisible();
  await expect(gone).toHaveCount(0);
});

test("an ask is sent to the PRD's track owners only, and the milestone names the first of them", async ({ page }) => {
  await open(page, "simple-prd-milestone-track-owner", "/simple/roadmap", "commenter@example.com");
  await expect(page.getByTestId("simple-roadmap")).toBeVisible();
  await page.getByTestId("ms-prd-label").filter({ hasText: "M2 Digest for all teams" }).click();
  const prd = page.getByTestId("ms-prd-card");
  await expect(prd).toContainText("From the PRD Usage alerts · owned by Rowan Pike");
  await expect(prd).toContainText("A change here goes to Rowan Pike as a change to the PRD");
  await prd.getByLabel("Date").fill("2027-01-20");
  await prd.getByRole("button", { name: "Ask to change it" }).click();
  await expect(page.getByTestId("ms-toast")).toContainText("Asked Rowan Pike to move M2 Digest for all teams to Jan 20 in the PRD");
  await page.keyboard.press("Escape");
  await page.goto("/simple");
  const proposals = page.getByTestId("home-proposals");
  await expect(proposals.getByRole("heading", { name: "Your proposals waiting" })).toBeVisible();
  await expect(proposals.getByTestId("home-proposal")).toHaveCount(1);
  // Its tracks' owners in id order; not Priya Raman (approver@example.com), who owns none of them.
  await expect(proposals.getByTestId("home-proposal")).toContainText("Waiting for Rowan Pike, Jun Park");
  await expect(proposals.getByTestId("home-proposal")).not.toContainText("Priya Raman");
});

test("each new browser seeds the same owners: the milestone names Rowan Pike every time", async ({ browser }) => {
  // The scenario's members keep their ids from one seed to the next, so the first owner by id does too.
  for (let n = 0; n < 5; n++) {
    const context = await browser.newContext();
    await context.clock.install({ time: MOCK_NOW });
    const page = await context.newPage();
    await open(page, "simple-prd-milestone-track-owner", "/simple/roadmap");
    await expect(page.getByTestId("simple-roadmap")).toBeVisible();
    await page.getByTestId("ms-prd-label").filter({ hasText: "M2 Digest for all teams" }).click();
    await expect(page.getByTestId("ms-prd-card")).toContainText("owned by Rowan Pike");
    await context.close();
  }
});

test("the PRD's track owner, not a company owner, declines a live milestone's ask on Home", async ({ page }) => {
  await open(page, "simple-prd-milestone-track-owner", "/simple", "rowan.pike@example.com");
  const proposals = page.getByTestId("home-proposals");
  await expect(proposals.getByRole("heading", { name: "Proposals on your items" })).toBeVisible();
  const stuck = homeAsks(page).filter({ hasText: "Nov 4," });
  await expect(stuck).toHaveCount(1);
  await stuck.getByRole("button", { name: "Decline" }).click();
  await expect(page.getByText("Declined", { exact: true })).toBeVisible();
  await expect(stuck).toHaveCount(0);
  await page.reload();
  await expect(proposals.getByRole("heading", { name: "Proposals on your items" })).toBeVisible();
  await expect(stuck).toHaveCount(0);
});
