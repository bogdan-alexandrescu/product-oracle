import { login } from "./helpers";
import { expect, test, type Page } from "./test";

/**
 * C-13: a PRD other than the seeded "guided-setup" read its own published sections for its
 * one-pager (./lib/api/mock/server.ts onePagerOf, seedOnePagerFromSections in
 * ./lib/api/mock/simple-one-pager.ts), never a copy of Guided setup's body and roadmap
 * span under a different title.
 *
 * Card one-pager-own-body: protects = two different PRDs opened from /simple/one-pagers
 * each show lines built from their own Problem and scope sections, and neither shows
 * Guided setup's "New workspace admins stall during setup and never invite a teammate in
 * the first week."; fails_when = every PRD's one-pager reads the same seeded body; no_claim
 * = the real job's wording (api/tests/test_simple_one_pager_api.py) and the PRD's own
 * roadmap linkage (not wired into this mock yet: its span reads "No roadmap items yet").
 */

const GUIDED_SETUP_PROBLEM = "New workspace admins stall during setup and never invite a teammate in the first week.";

async function openFromList(page: Page, title: string) {
  await login(page);
  await page.goto("/simple/one-pagers");
  await page.getByTestId("simple-one-pagers").getByRole("link", { name: title, exact: true }).click();
  await expect(page.getByRole("article", { name: "One-pager" })).toBeVisible();
}

test("Team workspaces PRD's one-pager shows its own Problem and scope, not Guided setup's", async ({ page }) => {
  await openFromList(page, "Team workspaces PRD");
  await expect(page.getByRole("heading", { level: 1, name: "Team workspaces PRD" })).toBeVisible();

  const problem = page.getByRole("region", { name: "Problem and who has it" });
  await expect(problem).toContainText("People share work by exporting files and sending them around");
  await expect(problem).not.toContainText(GUIDED_SETUP_PROBLEM);

  const bets = page.getByRole("region", { name: "What we will build" });
  await expect(bets).toContainText("Create a workspace and invite members");
  await expect(bets).not.toContainText("A setup checklist that shows the next step");

  // C-13: no roadmap item of this mock names Team workspaces, so its span is its own: none.
  await expect(page.getByText("No roadmap items yet")).toBeVisible();
});

test("Online deposits at booking's one-pager shows its own Problem and scope, not Guided setup's", async ({ page }) => {
  await openFromList(page, "Online deposits at booking");
  await expect(page.getByRole("heading", { level: 1, name: "Online deposits at booking" })).toBeVisible();

  const problem = page.getByRole("region", { name: "Problem and who has it" });
  await expect(problem).toContainText("One booking in nine ends as a no-show");
  await expect(problem).not.toContainText(GUIDED_SETUP_PROBLEM);

  const bets = page.getByRole("region", { name: "What we will build" });
  await expect(bets).toContainText("Take a deposit through the booking calendar");
  await expect(bets).not.toContainText("A setup checklist that shows the next step");

  // Its own Risks section builds the Risks block, never Guided setup's F-26 risk.
  const risks = page.getByRole("region", { name: "Risks and open decisions" });
  await expect(risks).toContainText("Same-day cancellations need a same-day refund");
  await expect(risks).not.toContainText("F-26");
});
