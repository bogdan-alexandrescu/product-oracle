import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { ADMIN, login } from "./helpers";
import { expect, test, type Page } from "./test";

/*
 * A feature moved onto a default goal on Priorities, read on the Roadmap (train BM review), on the
 * mock's "simple-plan" scenario (invented: Guided setup's plan; goals Reliability, Growth,
 * Activation and Revenue; Launch email, PM-owned, serves Growth and has no goal of its own).
 *
 * - moved-goal-reads: protects = once a person moves a feature onto a goal on Priorities' Goal
 *   buckets, the Roadmap's feature panel reads that goal for an item with no goal of its own, and
 *   a goal change's before is that goal (Undo puts it back); fails_when = the panel reads "No goal
 *   yet", or Undo leaves no goal; no_claim = the goals the plan seeded and no person touched (the
 *   Roadmap reads them the same before and after Priorities opens: roadmap-nov10-findings).
 * - written-links-read: protects = once a person writes a feature's goal links (a move, an Archive
 *   that leaves it another goal), the Roadmap reads every link it keeps, as the API's one goal order
 *   does: Team invites (Growth and Activation) moved Growth to Revenue reads Activation (3 before
 *   4), and with Growth archived reads Activation; a goal buckets Undo puts the links back as no
 *   person wrote them, so the panel reads what it read before; fails_when = the panel reads the
 *   goal it was moved to, "No goal yet" after the Archive, or a link Undo put back.
 */

const panel = (page: Page) => page.getByTestId("floating-card");
const bucket = (page: Page, goal: string) => page.locator(`[data-testid="plan-goal"][data-goal="${goal}"]`);

async function openOnRoadmap(page: Page, name: RegExp) {
  await page.goto("/simple/roadmap");
  await expect(page.getByTestId("simple-roadmap")).toBeVisible();
  await page.getByTestId("format-gantt").click();
  await page.getByRole("button", { name }).first().click();
  await expect(panel(page).getByTestId("card-goal")).toBeVisible();
}
// docs/ground-truth.md: a roadmap row reads its feature's code before its name (a slice keeps its letter).
const launchEmail = (page: Page) => openOnRoadmap(page, /^F-10[a-z]? Launch email:/);
const teamInvites = (page: Page) => openOnRoadmap(page, /^F-05[a-z]? Team invites/);

async function openBuckets(page: Page) {
  await page.context().addInitScript(([k, v]) => localStorage.setItem(k, v), [MOCK_SCENARIO_KEY, "simple-plan"] as const);
  await login(page, ADMIN.email);
  await page.goto("/simple/priorities?tab=buckets");
  await expect(page.getByTestId("buckets-head")).toBeVisible();
}

/** Team invites, in Growth, moved with the keyboard to the goal `over` names. */
async function moveTeamInvites(page: Page, presses: number, over: string, goal: string) {
  const grip = bucket(page, "Growth").locator('[data-code="F-05"]').getByTestId("feature-grip");
  await expect(grip).toHaveAccessibleName("Move Team invites to another goal");
  await grip.focus();
  await page.keyboard.press("Enter");
  for (let i = 0; i < presses; i++) await page.keyboard.press("ArrowUp");
  await expect(page.getByTestId("bucket-live")).toHaveText(`Over ${over}. Enter drops it there.`);
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("bucket-live")).toHaveText(`Moved Team invites to ${goal}.`);
}

test.describe("A feature moved onto a goal on Priorities", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("reads that goal in its Roadmap panel, and a goal change's Undo puts it back", async ({ page }) => {
    await page.context().addInitScript(([k, v]) => localStorage.setItem(k, v), [MOCK_SCENARIO_KEY, "simple-plan"] as const);
    await login(page, ADMIN.email);
    await page.goto("/simple/priorities?tab=buckets");
    await expect(page.getByTestId("buckets-head")).toBeVisible();
    const grip = bucket(page, "Growth").locator('[data-code="F-10"]').getByTestId("feature-grip");
    await expect(grip).toHaveAccessibleName("Move Launch email to another goal");
    await grip.focus();
    await page.keyboard.press("Enter");
    await page.keyboard.press("ArrowUp");
    await expect(page.getByTestId("bucket-live")).toHaveText("Over goal 4, Revenue. Enter drops it there.");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("bucket-live")).toHaveText("Moved Launch email to Revenue.");
    await expect(bucket(page, "Revenue").locator('[data-code="F-10"]')).toBeVisible();

    await launchEmail(page);
    await expect(panel(page).getByTestId("card-goal")).toHaveText("Revenue");
    await panel(page).getByRole("button", { name: "Change the goal" }).click();
    await panel(page).getByRole("combobox", { name: "Goal" }).selectOption({ label: "Grow retention (measured by Teams active after 90 days)" });
    await panel(page).getByRole("button", { name: "Save" }).click();
    await expect(panel(page).getByTestId("card-goal")).toHaveText("Grow retention");
    await expect(page.getByTestId("toasts")).not.toContainText("Changed since you saw it");
    // The change's before is the goal the panel read: Undo puts Revenue back.
    await page.getByTestId("toasts").getByRole("button", { name: "Undo" }).click();
    await expect(panel(page).getByTestId("card-goal")).toHaveText("Revenue");
  });

  test("a moved feature reads the other goal it keeps when that comes first in the goal order", async ({ page }) => {
    await openBuckets(page);
    await moveTeamInvites(page, 1, "goal 4, Revenue", "Revenue");
    await expect(bucket(page, "Revenue").locator('[data-code="F-05"]')).toBeVisible();
    await teamInvites(page);
    await expect(panel(page).getByTestId("card-goal")).toHaveText("Activation");
  });

  test("a goal archived from under a feature leaves it reading the other goal it serves", async ({ page }) => {
    await openBuckets(page);
    await bucket(page, "Growth").getByRole("button", { name: "More for Growth" }).click();
    await page.getByRole("menuitem", { name: "Archive goal" }).click();
    const dialog = page.getByRole("dialog", { name: "Archive Growth" });
    await expect(dialog).toContainText("Team invites → Activation");
    await dialog.getByLabel("Goal", { exact: true }).selectOption({ label: "1 · Reliability" });
    await dialog.getByRole("button", { name: "Archive goal" }).click();
    await expect(dialog).toHaveCount(0);
    await teamInvites(page);
    await expect(panel(page).getByTestId("card-goal")).toHaveText("Activation");
  });

  test("a goal buckets Undo leaves the panel reading what it read before the move", async ({ page }) => {
    await openBuckets(page);
    await teamInvites(page);
    await expect(panel(page).getByTestId("card-goal")).toHaveText("No goal yet");
    await page.goto("/simple/priorities?tab=buckets");
    await expect(page.getByTestId("buckets-head")).toBeVisible();
    await moveTeamInvites(page, 2, "goal 3, Activation", "Activation");
    await page.getByTestId("bucket-note").getByRole("button", { name: "Undo" }).click();
    await expect(bucket(page, "Growth").locator('[data-code="F-05"]')).toBeVisible();
    await teamInvites(page);
    await expect(panel(page).getByTestId("card-goal")).toHaveText("No goal yet");
  });
});
