import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { THEME_KEY } from "../lib/theme";
import { login, openRoadmapItem } from "./helpers";
import { expect, test, type Page } from "./test";

/*
 * build-feature-panel review 7 (the owner's Nov 4 ask): in the one feature panel a person
 * renames the feature and sets its effort, every change shows at once on the page behind, a
 * person who may only propose sees Propose and their proposal, a one-pager's bet opens the
 * item it came from, and the names Priorities' drafts, Home's broken links and Decisions show
 * open the panel. Mock data only (Weekly alert digest, Alert rules engine: invented features).
 */

const DESKTOP = { viewport: { width: 1440, height: 900 } };

async function go(page: Page, path: string, opts: { email?: string; scenario?: string } = {}) {
  await page.context().addInitScript(
    ([key, themeKey, sc]) => {
      localStorage.setItem(key, sc);
      localStorage.setItem(themeKey, "light");
    },
    [MOCK_SCENARIO_KEY, THEME_KEY, opts.scenario ?? ""] as const,
  );
  await login(page, opts.email);
  await page.goto(path);
}

const rankedName = (page: Page, title: string) => page.getByTestId("prio-title").locator("button[data-feature]").filter({ hasText: title }).first();

test.describe("feature panel review 7", () => {
  test.use(DESKTOP);

  test("the title is renamed in place, the page behind shows the new name at once, and Undo puts it back", async ({ page }) => {
    await go(page, "/simple/priorities");
    await rankedName(page, "Weekly alert digest").click();
    const panel = page.getByRole("dialog", { name: "Weekly alert digest" });
    await expect(panel.getByTestId("fp-details")).toBeVisible();
    await panel.getByRole("button", { name: "Change Name" }).click();
    const box = panel.getByRole("textbox", { name: "Name" });
    await box.fill("");
    await panel.getByRole("button", { name: "Save" }).click();
    await expect(panel.getByRole("alert")).toHaveText("Type a name");
    await box.fill("Weekly alert summary");
    await panel.getByRole("button", { name: "Save" }).click();
    await expect(page.getByRole("dialog", { name: "Weekly alert summary" }).getByRole("heading", { level: 2 })).toHaveText("Weekly alert summary");
    // The ranked row behind the panel reads the new name without leaving the page.
    await expect(rankedName(page, "Weekly alert summary")).toBeAttached();
    const toastUndo = page.getByRole("button", { name: "Undo" });
    await expect(page.getByText("Renamed Weekly alert digest to Weekly alert summary").first()).toBeVisible();
    await toastUndo.first().click();
    await expect(page.getByRole("dialog", { name: "Weekly alert digest" })).toBeVisible();
    await expect(rankedName(page, "Weekly alert digest")).toBeAttached();
  });

  test("a name over 200 characters is refused, as the API refuses it", async ({ page }) => {
    await go(page, "/simple/roadmap");
    await openRoadmapItem(page, "alert-digest");
    const panel = page.getByTestId("floating-card");
    await panel.getByRole("button", { name: "Change Name" }).click();
    await panel.getByRole("textbox", { name: "Name" }).fill("x".repeat(201));
    await panel.getByRole("button", { name: "Save" }).click();
    await expect(panel.getByRole("alert")).toHaveText("Keep the name to 200 characters");
  });

  test("the effort is set in engineer-weeks and the panel shows its score and the line", async ({ page }) => {
    await go(page, "/simple/priorities");
    await rankedName(page, "Weekly alert digest").click();
    const panel = page.getByRole("dialog", { name: "Weekly alert digest" });
    const effort = panel.getByTestId("fp-effort");
    await expect(effort).toHaveText(/engineer-weeks?$/);
    await expect(panel.getByTestId("fp-effort-score")).toHaveText(/^Score [\d.]+ · ranked \d+, (above|below) the line$/);
    await effort.click();
    await panel.getByRole("spinbutton", { name: "Effort in engineer-weeks" }).fill("40");
    await panel.getByRole("button", { name: "Save" }).click();
    await expect(effort).toHaveText("40 engineer-weeks");
    await expect(page.getByText(/^Weekly alert digest: effort 40 engineer-weeks, score [\d.]+, ranked \d+ (above|below) the line$/).first()).toBeVisible();
  });

  test("someone who may only propose sees Propose, a toast naming who decides, and the proposal listed in plain words", async ({ page }) => {
    await go(page, "/simple/priorities", { email: "commenter@example.com" });
    await rankedName(page, "Weekly alert digest").click();
    const panel = page.getByRole("dialog", { name: "Weekly alert digest" });
    await panel.getByRole("button", { name: "Change Outcome" }).click();
    await panel.getByRole("textbox", { name: "Outcome" }).fill("Admins read one email a week about their alerts.");
    await expect(panel.getByRole("button", { name: "Save", exact: true })).toHaveCount(0);
    await panel.getByRole("button", { name: "Propose", exact: true }).click();
    await expect(page.getByText(/^Proposed: change the outcome of Weekly alert digest · waiting for .+/).first()).toBeVisible();
    const list = panel.getByTestId("card-proposals");
    await expect(list).toContainText("Change the outcome · proposed by");
    await expect(panel).not.toContainText("No proposals waiting");
  });

  test("Esc gives the focus back to the name that opened the panel", async ({ page }) => {
    await go(page, "/simple/priorities");
    const name = rankedName(page, "Weekly alert digest");
    await name.click();
    await expect(page.getByRole("dialog", { name: "Weekly alert digest" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(name).toBeFocused();
  });

  test("removing a link says so with Undo, and Undo puts it back", async ({ page }) => {
    await go(page, "/simple/roadmap");
    await openRoadmapItem(page, "alert-digest");
    const panel = page.getByTestId("floating-card");
    const deps = panel.getByTestId("fp-list-depends");
    await deps.getByRole("button", { name: "Remove Alert rules engine" }).click();
    await expect(page.getByText("Removed the link: Weekly alert digest no longer depends on Alert rules engine").first()).toBeVisible();
    await expect(deps.getByRole("heading")).toHaveText("Depends on (0)");
    await page.getByRole("button", { name: "Undo" }).first().click();
    await expect(deps.getByRole("heading")).toHaveText("Depends on (1)");
  });

  test("an outcome over 1000 characters is refused, as the API refuses it", async ({ page }) => {
    await go(page, "/simple/roadmap");
    await openRoadmapItem(page, "alert-digest");
    const panel = page.getByTestId("floating-card");
    await panel.getByRole("button", { name: "Change Outcome" }).click();
    await panel.getByRole("textbox", { name: "Outcome" }).fill("y".repeat(1001));
    await panel.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText(/1000 characters/).first()).toBeVisible();
  });

  test("every Open the feature on a one-pager opens the roadmap item its bet came from", async ({ page }) => {
    await go(page, "/simple/one-pagers/guided-setup");
    const opens = page.getByRole("button", { name: /^Open the feature/ });
    await expect(opens.first()).toBeVisible();
    const n = await opens.count();
    for (let i = 0; i < n; i++) {
      const b = opens.nth(i);
      // Keyed by the item's id, never by the bet's words.
      await expect(b).toHaveAttribute("data-feature", /^[0-9a-f-]{36}$/);
      await b.click();
      const panel = page.getByRole("dialog");
      await expect(panel.getByTestId("fp-details")).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog")).toHaveCount(0);
    }
    await expect(page.getByText("This feature is not on a roadmap yet")).toHaveCount(0);
  });

  test("a draft under Not ranked yet opens the panel from its name", async ({ page }) => {
    await go(page, "/simple/priorities");
    const draft = page.getByTestId("prio-draft").first();
    await draft.scrollIntoViewIfNeeded();
    const name = draft.locator("button[data-feature]").first();
    const title = ((await name.textContent()) ?? "").trim();
    await name.click();
    await expect(page.getByRole("dialog", { name: title, exact: true }).getByTestId("fp-details")).toBeVisible();
  });

  test("Home's broken link: the names in Moving the dependents open the panel", async ({ page }) => {
    await go(page, "/simple");
    const moves = page.getByTestId("home-broken-moves").first();
    await expect(moves).toBeVisible();
    await moves.getByRole("button", { name: "Weekly alert digest", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Weekly alert digest", exact: true }).getByTestId("fp-details")).toBeVisible();
  });

  test("Decisions: a meeting's Moved decision opens the panel for the item it moved", async ({ page }) => {
    await go(page, "/simple/decisions");
    const moved = page.getByTestId("decision-row").locator("button[data-feature]").filter({ hasText: /^Moved Weekly alert digest/ }).first();
    await moved.scrollIntoViewIfNeeded();
    await moved.click();
    await expect(page.getByRole("dialog", { name: "Weekly alert digest", exact: true }).getByTestId("fp-details")).toBeVisible();
  });
});
