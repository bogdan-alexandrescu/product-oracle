import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { THEME_KEY } from "../lib/theme";
import { ADMIN, login } from "./helpers";
import { expect, test, type Page } from "./test";

/*
 * Goal buckets you can change (the owner's picks of mk-goalbuckets: GB1 a "Pencil, form in
 * place", GB2 a "Pick where they go", GB3 a "Drag to a goal"), driven through the UI on the mock's
 * "simple-plan" scenario (invented: Guided setup's plan; goals Reliability, Growth, Activation and
 * Revenue; Plan limits serves Revenue, then Growth). Desktop 1440x900 and phone 390x844.
 *
 * Card gb-add-edit: protects = the dashed "+ Add goal" bucket opens the form in place as the next
 * goal; Save goal stays off until the measure, the target and the date are all set; a saved goal
 * reads "<measure>: <target> by <date>"; the pencil turns a header into the same form, filled in;
 * every save offers Undo, which puts it back; fails_when = Save is on with a field missing, the
 * goal does not show, or Undo leaves the change; no_claim = Baseline's own goal checks (pytest).
 * Card gb-archive: protects = Archive goal asks first and says what the goal holds (its features
 * and the milestones their work is in); one that serves another goal goes there; Archive goal is
 * off until a goal is picked for the rest; archiving moves them and drops the bucket; Undo
 * brings every link back; fails_when = a feature is lost or Undo leaves it half done.
 * Card gb-move: protects = a feature dragged by its grip (pointer, or keys: Enter, arrows, Enter)
 * onto another bucket lights it and says what dropping does; dropping moves it, with Undo;
 * Escape cancels; fails_when = the feature stays put or Undo does not bring it back.
 * Card gb-viewer: protects = a viewer sees no pencil, menu, add bucket or grip; fails_when = any
 * control shows. Milestone chips and the effort bars name their milestone.
 * Card gb-panel: protects = a feature's name in a bucket opens the Simple item panel (the one the
 * roadmap opens) with that feature's card; Close shuts it; the grip still only moves it;
 * fails_when = clicking a bucket feature opens nothing; no_claim = the card's own edits.
 */

const SIZES = [
  { name: "desktop", viewport: { width: 1440, height: 900 } },
  { name: "phone", viewport: { width: 390, height: 844 } },
] as const;

async function open(page: Page, viewport: { width: number; height: number }, who = ADMIN.email) {
  await page.setViewportSize(viewport);
  await page.context().addInitScript(
    ([key, value, themeKey]) => {
      localStorage.setItem(key, value);
      localStorage.setItem(themeKey, "light");
    },
    [MOCK_SCENARIO_KEY, "simple-plan", THEME_KEY] as const,
  );
  await login(page, who);
  await page.goto("/simple/priorities?tab=buckets");
  await expect(page.getByTestId("buckets-head")).toBeVisible();
  await expect(page.locator('[data-testid="plan-goal"][data-goal="Reliability"]').getByTestId("goal-measure")).toBeVisible();
}

const bucket = (page: Page, goal: string) => page.locator(`[data-testid="plan-goal"][data-goal="${goal}"]`);
const note = (page: Page) => page.getByTestId("bucket-note");

for (const size of SIZES) {
  test.describe(size.name, () => {
    test("add a goal: Save stays off until measure, target and date are set; Undo removes it", async ({ page }) => {
      await open(page, size.viewport);
      await page.getByTestId("add-goal").getByRole("button", { name: "+ Add goal" }).click();
      const form = page.getByTestId("add-goal").getByTestId("goal-form");
      await expect(form.getByRole("heading", { name: "New goal" })).toBeVisible();
      await expect(form).toContainText("Goal 5 in the order; change it in the Ground Truth");
      const save = form.getByRole("button", { name: "Save goal" });
      await expect(save).toBeDisabled();
      await form.getByLabel("Goal").fill("Quieter support inbox");
      await form.getByLabel("Measure: the number that shows it").fill("Support chats a week");
      await form.getByLabel("Target").fill("Under 40");
      await expect(save).toBeDisabled();
      await expect(form).toContainText("Pick a date.");
      await form.getByLabel("By").fill("Mar 31, 2027");
      await expect(save).toBeEnabled();
      await save.click();
      const made = bucket(page, "Quieter support inbox");
      await expect(made.getByTestId("goal-measure")).toHaveText("Support chats a week: Under 40 by Mar 31, 2027");
      await expect(made.getByTestId("goal-order")).toHaveText("5");
      await expect(note(page)).toContainText("Added Quieter support inbox as goal 5.");
      await note(page).getByRole("button", { name: "Undo" }).click();
      await expect(made).toHaveCount(0);
    });

    test("the intro and the chips read as the frames do", async ({ page }) => {
      await open(page, size.viewport);
      // mk-goalbuckets: the intro, then the plan's quarter.
      await expect(page.getByTestId("prio-subtitle")).toHaveText("Where the engineer-weeks go, goal by goal. Q4 2026.");
      // gb1-a-result, gb3: a feature that serves several goals shows "+1 goal" beside its name.
      await expect(bucket(page, "Reliability").locator('[data-code="F-06"]').getByTestId("also-goals")).toHaveText("+1 goal");
      await expect(bucket(page, "Growth").locator('[data-code="F-05"]').getByTestId("also-goals")).toHaveText("+1 goal");
    });

    test("edit a goal in place, then Undo", async ({ page }) => {
      await open(page, size.viewport);
      const card = bucket(page, "Reliability");
      await expect(card.getByTestId("goal-measure")).toHaveText("Setups that finish without an error: 99.9% by Feb 12, 2027");
      await card.getByRole("button", { name: "Edit Reliability" }).click();
      const form = card.getByTestId("goal-form");
      await expect(form.getByRole("heading", { name: "Edit goal" })).toBeVisible();
      await expect(form.getByLabel("By")).toHaveValue("Feb 12, 2027");
      await form.getByLabel("Target").fill("99.95%");
      await form.getByLabel("By").fill("");
      await expect(form.getByRole("button", { name: "Save goal" })).toBeDisabled();
      await expect(form).toContainText("A goal needs a measure, a target and a date.");
      await form.getByLabel("By").fill("Mar 31, 2027");
      await form.getByRole("button", { name: "Save goal" }).click();
      await expect(card.getByTestId("goal-measure")).toHaveText("Setups that finish without an error: 99.95% by Mar 31, 2027");
      await expect(note(page)).toContainText("Saved Reliability: 99.95% by Mar 31, 2027.");
      await note(page).getByRole("button", { name: "Undo" }).click();
      await expect(card.getByTestId("goal-measure")).toHaveText("Setups that finish without an error: 99.9% by Feb 12, 2027");
    });

    test("archive a goal, picking where its features go, then Undo", async ({ page }) => {
      await open(page, size.viewport);
      await expect(bucket(page, "Revenue").getByTestId("plan-feature")).toHaveCount(5);
      await expect(bucket(page, "Revenue").locator('[data-code="F-14"]').getByTestId("also-goals")).toHaveText("+1 goal");
      await bucket(page, "Revenue").getByRole("button", { name: "More for Revenue" }).click();
      await page.getByRole("menuitem", { name: "Archive goal" }).click();
      const dialog = page.getByRole("dialog", { name: "Archive Revenue" });
      await expect(dialog).toContainText("It holds 5 features with work in M1 Prove it, M2 Scale volume and M3 Open to all.");
      await expect(dialog).toContainText("1 serves another goal too and goes there: Plan limits → Growth");
      await expect(dialog.getByRole("button", { name: "Archive goal" })).toBeDisabled();
      await dialog.getByLabel("Goal", { exact: true }).selectOption({ label: "1 · Reliability" });
      await expect(dialog).toContainText("Reliability will hold 9 features. Undo puts every link back.");
      await dialog.getByRole("button", { name: "Archive goal" }).click();
      await expect(dialog).toHaveCount(0);
      await expect(bucket(page, "Revenue")).toHaveCount(0);
      await expect(note(page)).toContainText("Archived Revenue. 4 features moved to Reliability, 1 to the other goal it serves.");
      // gb2-a-result: the page is not left scrolled with the note over the bucket titles.
      const noteBox = (await note(page).boundingBox())!;
      for (const title of await page.locator('[data-testid="plan-goal"] h3').all()) {
        const t = await title.boundingBox();
        if (t) expect(t.y >= noteBox.y + noteBox.height || t.y + t.height <= noteBox.y, `a goal title under the note at y=${t.y}`).toBe(true);
      }
      if (size.name === "desktop") await expect(bucket(page, "Reliability").locator("h3")).toBeInViewport();
      await expect(bucket(page, "Reliability").locator('[data-code="F-11"]')).toBeVisible();
      await expect(bucket(page, "Growth").locator('[data-code="F-14"]')).toBeVisible();
      await note(page).getByRole("button", { name: "Undo" }).click();
      await expect(bucket(page, "Revenue").getByTestId("plan-feature")).toHaveCount(5);
      await expect(bucket(page, "Reliability").locator('[data-code="F-11"]')).toHaveCount(0);
    });

    test("drag a feature to another goal by pointer, then Undo", async ({ page }) => {
      await open(page, size.viewport);
      const row = bucket(page, "Reliability").locator('[data-code="F-03"]');
      const grip = row.getByTestId("feature-grip");
      await grip.scrollIntoViewIfNeeded();
      const from = (await grip.boundingBox())!;
      await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
      await page.mouse.down();
      const target = bucket(page, "Growth").getByRole("heading", { name: "Growth" });
      if (size.name === "phone") {
        // Growth is below the screen: holding at the bottom edge scrolls the page under the finger.
        await page.mouse.move(from.x + 4, size.viewport.height - 30, { steps: 6 });
        await expect(page.getByTestId("drag-edge")).toContainText("Scrolling down");
        await expect.poll(async () => (await target.boundingBox())!.y, { intervals: [30] }).toBeLessThan(size.viewport.height - 160);
        await page.mouse.move(from.x + 4, size.viewport.height / 2, { steps: 2 });
        await expect(page.getByTestId("drag-edge")).toHaveCount(0);
      }
      const to = (await target.boundingBox())!;
      await page.mouse.move(to.x + 10, to.y + to.height / 2, { steps: 8 });
      await expect(bucket(page, "Growth")).toHaveAttribute("data-drop", "");
      await expect(bucket(page, "Growth").getByTestId("drop-note")).toHaveText("Drop here: Growth becomes the goal it moves most");
      await expect(page.getByTestId("drag-ghost")).toContainText("Setup failure alerts");
      await page.mouse.up();
      await expect(bucket(page, "Growth").locator('[data-code="F-03"]')).toBeVisible();
      await expect(bucket(page, "Reliability").locator('[data-code="F-03"]')).toHaveCount(0);
      await expect(note(page)).toContainText("Moved Setup failure alerts to Growth.");
      await note(page).getByRole("button", { name: "Undo" }).click();
      await expect(bucket(page, "Reliability").locator('[data-code="F-03"]')).toBeVisible();
    });

    test("move a feature by keyboard, announced; Escape cancels; Undo", async ({ page }) => {
      await open(page, size.viewport);
      const grip = bucket(page, "Reliability").locator('[data-code="F-03"]').getByTestId("feature-grip");
      await expect(grip).toHaveAccessibleName("Move Setup failure alerts to another goal");
      await grip.focus();
      await page.keyboard.press("Enter");
      await expect(page.getByTestId("bucket-live")).toContainText("Picked up Setup failure alerts.");
      await page.keyboard.press("ArrowDown");
      await expect(page.getByTestId("bucket-live")).toHaveText("Over goal 2, Growth. Enter drops it there.");
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("bucket-live")).toContainText("Move cancelled.");
      await expect(bucket(page, "Reliability").locator('[data-code="F-03"]')).toBeVisible();
      await grip.focus();
      await page.keyboard.press(" ");
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("ArrowDown");
      await expect(bucket(page, "Activation")).toHaveAttribute("data-drop", "");
      await page.keyboard.press("Enter");
      await expect(bucket(page, "Activation").locator('[data-code="F-03"]')).toBeVisible();
      await expect(page.getByTestId("bucket-live")).toHaveText("Moved Setup failure alerts to Activation.");
      await note(page).getByRole("button", { name: "Undo" }).click();
      await expect(bucket(page, "Reliability").locator('[data-code="F-03"]')).toBeVisible();
    });

    test("a feature's name opens its item panel, as the roadmap's does", async ({ page }) => {
      await open(page, size.viewport);
      await expect(page.getByTestId("item-panel")).toHaveCount(0);
      await bucket(page, "Revenue").locator('[data-code="F-14"]').getByRole("button", { name: "Plan limits", exact: true }).click();
      const panel = page.getByTestId("item-panel");
      await expect(panel).toHaveCount(1);
      const card = panel.getByTestId("floating-card");
      await expect(card).toBeVisible();
      await expect(card).toContainText("Plan limits");
      await card.getByRole("button", { name: /Close/ }).first().click();
      await expect(page.getByTestId("item-panel")).toHaveCount(0);
    });

    test("a viewer reads the goals with no controls; chips and bars name the milestone", async ({ page }) => {
      await open(page, size.viewport, "viewer@example.com");
      await expect(bucket(page, "Reliability").getByTestId("goal-measure")).toHaveText("Setups that finish without an error: 99.9% by Feb 12, 2027");
      await expect(page.getByRole("button", { name: /^Edit / })).toHaveCount(0);
      await expect(page.getByRole("button", { name: /^More for / })).toHaveCount(0);
      await expect(page.getByTestId("add-goal")).toHaveCount(0);
      await expect(page.getByTestId("feature-grip")).toHaveCount(0);
      // A viewer opens a feature's item panel too, to read it.
      await bucket(page, "Revenue").locator('[data-code="F-14"]').getByRole("button", { name: "Plan limits", exact: true }).click();
      await expect(page.getByTestId("item-panel").getByTestId("floating-card")).toContainText("Plan limits");
      for (const t of await page.getByTestId("plan-chip").allInnerTexts()) expect(t.replace(/\s+/g, " ")).toMatch(/^M\d (Prove it|Scale volume|Open to all)$/);
      for (const t of await page.getByTestId("goal-bar-label").allInnerTexts()) expect(t).toMatch(/^M\d (Prove it|Scale volume|Open to all) · [\d.]+ wk$/);
    });
  });
}
