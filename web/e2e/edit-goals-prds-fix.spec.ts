import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { THEME_KEY } from "../lib/theme";
import { ADMIN, login } from "./helpers";
import { expect, test, type Page } from "./test";

/*
 * edit-goals-prds EG1 a, fix round 1 (PR 1279 review), on the mock's "simple-plan" scenario (a
 * dated plan) and "goal-buckets-undated" (no dated plan). Invented data: goals Reliability, Growth,
 * Activation and Revenue; archived goals Cut support tickets in half, Launch in two new regions and
 * Faster first report; Avery Stone the owner, Theo Brandt a commenter. 1440x900 and 390x844, light
 * and dark.
 *
 * Card eg1-delete-undo: protects = Delete goal's note says the goal is in Settings > Trash and
 * has Undo, which brings the goal back with its features where they were; fails_when = no Undo,
 * or the goal or its links stay gone.
 * Card eg1-ask-restore: protects = a commenter's Archived goals fold offers Ask to restore and no
 * Ask to delete (eg1-a-propose), and the note says to whom it went; fails_when = Ask to delete
 * shows, or no ask is sent.
 * Card eg1-no-plan: protects = with no dated plan each goal names its owner, its ⋯ reads Edit
 * goal, Archive goal and Delete goal (Ask to archive and Ask to delete for a commenter), and the
 * Archived goals fold is there with Restore; Delete goal has Undo; fails_when = any is missing.
 *
 * Fix round 2 (PR 1279 review r2), Priya Raman an approver:
 * Card eg1-no-plan-delete: protects = with no dated plan a deleted goal's bucket is gone, also
 * after a reload (its roadmap items lose it as their own goal, as the API's trash_goal does), and
 * Undo brings it back with its features; fails_when = the bucket stays, owner line and menu gone.
 * Card eg1-approver: protects = an approver's ⋯ reads Edit goal, Archive goal and Delete goal and
 * the Archived goals fold offers Restore and Delete, with and without a dated plan; fails_when =
 * any is missing or asks instead.
 * Card eg1-accept-restore: protects = an owner accepts a commenter's Ask to restore in Decisions,
 * and the goal is back in the buckets; fails_when = no ask to accept, or the goal stays archived.
 */

const LOOKS = [
  { name: "desktop light", viewport: { width: 1440, height: 900 }, theme: "light" },
  { name: "phone dark", viewport: { width: 390, height: 844 }, theme: "dark" },
  { name: "desktop dark", viewport: { width: 1440, height: 900 }, theme: "dark" },
  { name: "phone light", viewport: { width: 390, height: 844 }, theme: "light" },
] as const;
type Look = (typeof LOOKS)[number];

const VIEWS = [
  { name: "dated plan", scenario: "simple-plan", card: "plan-goal" },
  { name: "no dated plan", scenario: "goal-buckets-undated", card: "goal-bucket" },
] as const;
type View = (typeof VIEWS)[number];

async function open(page: Page, look: Look, view: View, who = ADMIN.email) {
  await page.setViewportSize(look.viewport);
  await page.context().addInitScript(
    ([key, value, themeKey, theme]) => {
      localStorage.setItem(key, value);
      localStorage.setItem(themeKey, theme);
    },
    [MOCK_SCENARIO_KEY, view.scenario, THEME_KEY, look.theme] as const,
  );
  await login(page, who);
  await page.goto("/simple/priorities?tab=buckets");
  if (view.card === "goal-bucket") await expect(page.getByTestId("buckets-head")).toHaveCount(0);
  else await expect(page.getByTestId("buckets-head")).toBeVisible();
  await expect(bucket(page, view, "Reliability").locator('[data-code="F-03"]')).toBeVisible();
}

const bucket = (page: Page, view: View, goal: string) => page.locator(`[data-testid="${view.card}"]`).filter({ has: page.getByRole("heading", { name: goal, exact: true }) });
const note = (page: Page) => page.getByTestId("bucket-note");
const fold = (page: Page) => page.getByTestId("archived-goals");

/** A screenshot for the review, when SHOTS_DIR is set. */
async function shot(page: Page, name: string) {
  const dir = process.env.SHOTS_DIR;
  if (dir) await page.screenshot({ path: `${dir}/${name}.png` });
}
const slug = (s: string) => s.replace(/\W+/g, "-").toLowerCase();

async function deleteGoal(page: Page, view: View, goal: string) {
  await bucket(page, view, goal).getByRole("button", { name: `More for ${goal}` }).click();
  await page.getByRole("menuitem", { name: "Delete goal" }).click();
  const dialog = page.getByRole("dialog", { name: `Delete ${goal}` });
  const go = dialog.getByRole("button", { name: "Delete goal" });
  if (await go.isDisabled()) await dialog.getByLabel("Goal", { exact: true }).selectOption({ label: "1 · Reliability" });
  await go.click();
  await expect(dialog).toHaveCount(0);
}

for (const look of LOOKS) {
  test.describe(look.name, () => {
    for (const view of VIEWS) {
      test(`${view.name}: Delete goal names Settings > Trash, and Undo brings the goal and its links back`, async ({ page }) => {
        await open(page, look, view);
        await expect(bucket(page, view, "Activation").locator('[data-code="F-01"]')).toBeVisible();
        await deleteGoal(page, view, "Activation");
        await expect(note(page)).toContainText("Deleted Activation.");
        await expect(note(page)).toContainText("It is in Settings > Trash for 30 days.");
        await expect(bucket(page, view, "Reliability").locator('[data-code="F-01"]')).toBeVisible();
        if (view.card === "plan-goal") await expect(bucket(page, view, "Activation")).toHaveCount(0);
        await shot(page, `goal-undo-note-${slug(view.name)}-${slug(look.name)}`);
        await note(page).getByRole("button", { name: "Undo" }).click();
        await expect(note(page)).toContainText("Undone: Activation and its links are back.");
        await expect(bucket(page, view, "Activation").locator('[data-code="F-01"]')).toBeVisible();
        await expect(bucket(page, view, "Reliability").locator('[data-code="F-01"]')).toHaveCount(0);
        await expect(bucket(page, view, "Activation").getByRole("button", { name: "More for Activation" })).toBeVisible();
      });

      test(`${view.name}: a commenter's archived goals offer Ask to restore and no Ask to delete`, async ({ page }) => {
        await open(page, look, view, "commenter@example.com");
        await fold(page).locator("summary").click();
        const row = fold(page).getByTestId("archived-goal").filter({ hasText: "Cut support tickets in half" });
        await expect(row.getByRole("button")).toHaveText(["Ask to restore"]);
        await expect(fold(page).getByRole("button", { name: /delete/i })).toHaveCount(0);
        await row.scrollIntoViewIfNeeded();
        await shot(page, `commenter-archived-fold-${slug(view.name)}-${slug(look.name)}`);
        await row.getByRole("button", { name: "Ask to restore" }).click();
        await expect(note(page)).toContainText("Sent to Avery Stone: restore Cut support tickets in half.");
        await expect(row).toHaveCount(1);
      });
    }

    test("no dated plan: each goal names its owner; its ⋯ reads Edit, Archive and Delete goal; the Archived goals fold restores", async ({ page }) => {
      const view = VIEWS[1];
      await open(page, look, view);
      await expect(bucket(page, view, "Reliability").getByTestId("goal-owner")).toHaveText("Owner: Priya Raman");
      await expect(bucket(page, view, "Growth").getByTestId("goal-owner")).toHaveText("Owner: Avery Stone");
      await shot(page, `no-plan-buckets-${slug(look.name)}`);
      await bucket(page, view, "Growth").getByRole("button", { name: "More for Growth" }).click();
      await expect(page.getByRole("menuitem")).toHaveText(["Edit goal", "Archive goal", "Delete goal"]);
      await shot(page, `no-plan-menu-${slug(look.name)}`);
      await page.keyboard.press("Escape");
      await expect(fold(page)).toContainText("Archived goals · 3");
      await fold(page).locator("summary").click();
      const row = fold(page).getByTestId("archived-goal").filter({ hasText: "Faster first report" });
      await expect(row.getByRole("button")).toHaveText(["Restore", "Delete"]);
      await row.getByRole("button", { name: "Restore" }).click();
      await expect(note(page)).toContainText("Restored Faster first report.");
      await expect(fold(page)).toContainText("Archived goals · 2");
    });

    test("no dated plan: a commenter's ⋯ reads Ask to archive and Ask to delete", async ({ page }) => {
      const view = VIEWS[1];
      await open(page, look, view, "commenter@example.com");
      await bucket(page, view, "Growth").getByRole("button", { name: "More for Growth" }).click();
      await expect(page.getByRole("menuitem")).toHaveText(["Ask to archive", "Ask to delete"]);
      await page.getByRole("menuitem", { name: "Ask to delete" }).click();
      const dialog = page.getByRole("dialog", { name: "Ask to delete Growth" });
      const send = dialog.getByRole("button", { name: "Send to Avery Stone" });
      if (await send.isDisabled()) await dialog.getByLabel("Goal", { exact: true }).selectOption({ label: "1 · Reliability" });
      await send.click();
      await expect(note(page)).toContainText("Sent to Avery Stone: delete Growth.");
      await expect(bucket(page, view, "Growth")).toHaveCount(1);
    });
  });
}

const APPROVER = "approver@example.com";

test.describe("fix round 2", () => {
  const look = LOOKS[0];

  for (const phone of [LOOKS[0], LOOKS[1]]) {
    test(`no dated plan, ${phone.name}: a deleted goal's bucket is gone, also after a reload; Undo brings it back with its features`, async ({ page }) => {
      const view = VIEWS[1];
      await open(page, phone, view);
      await expect(bucket(page, view, "Activation").locator('[data-code="F-01"]')).toBeVisible();
      await deleteGoal(page, view, "Activation");
      await expect(note(page)).toContainText("Deleted Activation.");
      await expect(bucket(page, view, "Activation")).toHaveCount(0);
      await shot(page, `no-plan-deleted-${slug(phone.name)}`);
      await note(page).getByRole("button", { name: "Undo" }).click();
      await expect(note(page)).toContainText("Undone: Activation and its links are back.");
      await expect(bucket(page, view, "Activation").locator('[data-code="F-01"]')).toBeVisible();
      await expect(bucket(page, view, "Activation").getByRole("button", { name: "More for Activation" })).toBeVisible();
      await expect(bucket(page, view, "Activation").getByTestId("goal-owner")).toBeVisible();

      await deleteGoal(page, view, "Activation");
      await expect(bucket(page, view, "Activation")).toHaveCount(0);
      await page.reload();
      await expect(bucket(page, view, "Reliability").locator('[data-code="F-01"]')).toBeVisible();
      await expect(bucket(page, view, "Activation")).toHaveCount(0);
    });
  }

  for (const view of VIEWS) {
    test(`${view.name}: an approver's ⋯ reads Edit, Archive and Delete goal; the Archived goals fold has Restore and Delete`, async ({ page }) => {
      await open(page, look, view, APPROVER);
      await bucket(page, view, "Growth").getByRole("button", { name: "More for Growth" }).click();
      await expect(page.getByRole("menuitem")).toHaveText(["Edit goal", "Archive goal", "Delete goal"]);
      await shot(page, `approver-menu-${slug(view.name)}`);
      await page.keyboard.press("Escape");
      await fold(page).locator("summary").click();
      const row = (title: string) => fold(page).getByTestId("archived-goal").filter({ hasText: title });
      await expect(row("Faster first report").getByRole("button")).toHaveText(["Restore", "Delete"]);
      await row("Faster first report").getByRole("button", { name: "Restore" }).click();
      await expect(note(page)).toContainText("Restored Faster first report.");
      await expect(fold(page)).toContainText("Archived goals · 2");
      await row("Launch in two new regions").getByRole("button", { name: "Delete" }).click();
      const dialog = page.getByRole("dialog", { name: "Delete Launch in two new regions" });
      await dialog.getByRole("button", { name: "Delete goal" }).click();
      await expect(note(page)).toContainText("Deleted Launch in two new regions. It is in Settings > Trash for 30 days.");
      await expect(row("Launch in two new regions")).toHaveCount(0);
    });

    test(`${view.name}: the owner accepts a commenter's Ask to restore in Decisions, and the goal is back`, async ({ page }) => {
      await open(page, look, view, "commenter@example.com");
      await fold(page).locator("summary").click();
      await fold(page).getByTestId("archived-goal").filter({ hasText: "Cut support tickets in half" }).getByRole("button", { name: "Ask to restore" }).click();
      await expect(note(page)).toContainText("Sent to Avery Stone: restore Cut support tickets in half.");

      await login(page, ADMIN.email);
      await page.goto("/simple/decisions");
      const ask = page.getByTestId("questions-mine").getByTestId("waiting-item").filter({ hasText: 'proposed: restore the goal "Cut support tickets in half"' });
      await ask.getByRole("button", { name: "Accept" }).click();
      await expect(ask).toHaveCount(0);

      await page.goto("/simple/priorities?tab=buckets");
      await expect(bucket(page, view, "Cut support tickets in half")).toHaveCount(1);
      await expect(fold(page)).toContainText("Archived goals · 2");
    });
  }
});
