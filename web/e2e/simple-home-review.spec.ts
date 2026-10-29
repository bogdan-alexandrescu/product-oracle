import { expect, test, type Page } from "./test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { ADMIN } from "./helpers";

/*
 * #723 S1 Home review: who decides a broken link's fixes on Simple's Home, and the rest of the
 * review's minors. In "simple-home-deciders" Dana Decider (an approver) decides the pricing
 * roadmap and Avery Lane (an approver) owns the alerts track, so decides its items; a
 * commenter's retitle of New plan tiers waits on Dana. In "simple-home" the owners decide.
 *
 * Card simple-home-review: protects = an approver who decides an item applies its fixes (no
 * "Propose:"), others' rows name who decides ("Avery Lane decides") and the proposal's toast
 * too; a decider with proposals on their items still sees their own proposals waiting; a
 * commenter's goal tiles count no broken link as needing them; people by display name;
 * Start meeting stays in Simple (the Meetings page, its start sheet open); fails_when = the fixes switch on the owner
 * role, the row says "The decider decides", the own proposals list hides behind the items'
 * list, or a link leaves /simple; no_claim = the real API (api/tests/test_simple_review_fixes.py
 * test_roadmap_items_say_who_decides), S8's meeting screen (a placeholder until then).
 */

async function signIn(page: Page, scenario: string, email: string) {
  await page.context().addInitScript(([key, value]) => localStorage.setItem(key, value), [MOCK_SCENARIO_KEY, scenario]);
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(ADMIN.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).not.toHaveURL(/\/login/);
  await page.goto("/simple");
  await expect(page.getByTestId("home-greeting")).toBeVisible();
}

const digest = (page: Page) => page.getByTestId("home-plan").getByTestId("home-broken").filter({ hasText: "Weekly alert digest" }).filter({ hasText: "which it depends on" });

test("an approver who decides the item applies its fixes", async ({ page }) => {
  await signIn(page, "simple-home-deciders", "avery.lane@example.com");
  await expect(digest(page).getByRole("button", { name: "Move dependents", exact: true })).toBeVisible();
  await expect(digest(page)).not.toContainText("decides");
  await expect(digest(page).getByRole("button", { name: /^Propose/ })).toHaveCount(0);
  await digest(page).getByRole("button", { name: "Move dependents", exact: true }).click();
  await expect(page.getByText("Dependents moved in your working draft")).toBeVisible();
});

test("a commenter's fix row and toast name who decides", async ({ page }) => {
  await signIn(page, "simple-home-deciders", "commenter@example.com");
  await expect(digest(page)).toContainText("Avery Lane decides");
  await digest(page).getByRole("button", { name: "Propose: Move dependents" }).click();
  await expect(page.getByText("Proposed: Avery Lane decides", { exact: true })).toBeVisible();
});

test("a decider with proposals on their items still sees their own proposals waiting", async ({ page }) => {
  await signIn(page, "simple-home-deciders", "dana.decider@example.com");
  const onMine = page.getByTestId("home-proposals");
  await expect(page.getByRole("heading", { name: "Proposals on your items" })).toBeVisible();
  await expect(onMine.getByTestId("home-proposal").filter({ hasText: "New plan tiers" }).getByRole("button", { name: "Accept" })).toBeVisible();
  await expect(digest(page)).toContainText("Avery Lane decides");
  await digest(page).getByRole("button", { name: "Propose: Move dependents" }).click();
  await expect(page.getByText("Proposed: Avery Lane decides", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Your proposals waiting" })).toBeVisible();
  await expect(page.getByTestId("home-my-proposals").getByTestId("home-proposal").filter({ hasText: "Weekly alert digest" })).toContainText("Waiting for Avery Lane");
});

test("a commenter's goal tiles count no broken link as needing them", async ({ page }) => {
  await signIn(page, "simple-home", "commenter@example.com");
  await expect(page.getByTestId("home-goal")).toHaveCount(3);
  await expect(digest(page)).toBeVisible();
  await expect(page.getByTestId("home-goal-need")).toHaveCount(0);
});

test("people by name; Start meeting stays in Simple and opens the start sheet", async ({ page }) => {
  await signIn(page, "simple-home", ADMIN.email);
  const next = page.getByTestId("home-meeting-next");
  await expect(next).toContainText("Admin");
  await expect(next).not.toContainText(/\badmin\b/);
  const start = next.getByRole("link", { name: "Start review" });
  await expect(start).toHaveAttribute("href", /^\/simple\/meetings\?start=[0-9a-f-]+$/);
  await start.click();
  await expect(page).toHaveURL(/\/simple\/meetings\?start=/);
  await expect(page.getByRole("dialog", { name: "Start a review" })).toBeVisible();
});
