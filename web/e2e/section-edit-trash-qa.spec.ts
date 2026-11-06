import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login, section } from "./helpers";
import { expect, test, type Locator, type Page } from "./test";

/**
 * Pre-demo QA, as the owner, at 1440 and 390, light and dark.
 *
 * Card D-13: protects = a PRD section's Edit shows its text once: the editor, its preview behind an
 * Edit / Preview switch, and no visible "markdown" label (the word sits in the (i));
 * fails_when = the editor and a Preview box both show the text, or "markdown" shows;
 * no_claim = Save (section-edit.spec).
 *
 * Card G-4: protects = a Trash entry says what Restore brings back: a goal deleted on Priorities
 * reads "with <n> features" (the features that served it), a removed agenda item "from <its
 * meeting>", and Restore's (i) names it all; fails_when = a bare "Goal <name>" or "Agenda item
 * <name>"; no_claim = the API's counts (pytest test_trash_holds).
 */

const SIZES = [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
];
const THEMES = ["light", "dark"] as const;
const CARTS = "/documents/saved-carts/v/2";

async function tap(l: Locator) {
  await l.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await l.click();
}

async function noWiderThanTheScreen(page: Page) {
  const { sw, iw } = await page.evaluate(() => ({ sw: document.scrollingElement!.scrollWidth, iw: window.innerWidth }));
  expect(sw, "page scroll width").toBe(iw);
}

/** Reads the mock API (never changes it): the goal buckets' goals and each feature's goals. */
async function buckets(page: Page) {
  return page.evaluate(async () => {
    const w = globalThis as unknown as { __poMockFetch?: (r: Request) => Promise<Response> };
    const res = await w.__poMockFetch!(new Request(new URL("/v1/simple/goal-buckets", location.origin)));
    return (await res.json()) as { goals: { id: string; title: string }[]; features: { id: string; goal_ids: string[] }[] };
  });
}

for (const theme of THEMES)
  for (const size of SIZES) {
    const at = `${size.width}, ${theme}`;

    test(`D-13: a section's Edit shows its text once, its preview behind Edit / Preview (${at})`, async ({ page }) => {
      await page.setViewportSize(size);
      await page.emulateMedia({ colorScheme: theme });
      await login(page);
      await page.goto(CARTS);
      await page.getByRole("group", { name: "Document view" }).getByRole("button", { name: "Full" }).click();
      const reminder = section(page, "feature-reminder");
      await tap(reminder.getByRole("button", { name: "Actions for Reminder email" }));
      await page.getByRole("menuitem", { name: "Edit the text yourself" }).click();
      const editor = reminder.getByTestId("section-editor");
      await expect(editor).toBeVisible();

      const text = editor.getByRole("textbox", { name: "Section text" });
      await expect(text).toBeVisible();
      await expect(editor.getByTestId("section-edit-preview")).toHaveCount(0);
      await expect(editor.getByText(/markdown/i).filter({ visible: true })).toHaveCount(0);
      await expect(editor.getByText("Preview", { exact: true }).filter({ visible: true })).toHaveCount(0);
      await noWiderThanTheScreen(page);

      await text.fill("One reminder email per cart, a day after it was left.");
      const toggle = editor.getByRole("group", { name: "Edit or preview" });
      await tap(toggle.getByRole("button", { name: "Preview" }));
      const preview = editor.getByTestId("section-edit-preview");
      await expect(preview).toContainText("One reminder email per cart, a day after it was left.");
      await expect(text).toHaveCount(0);
      await tap(toggle.getByRole("button", { name: "Edit" }));
      await expect(editor.getByRole("textbox", { name: "Section text" })).toHaveValue("One reminder email per cart, a day after it was left.");
      await expect(preview).toHaveCount(0);
    });

    test(`G-4: a deleted goal in Trash says it comes back with its features (${at})`, async ({ page }) => {
      await page.addInitScript((key) => localStorage.setItem(key, "simple-plan"), MOCK_SCENARIO_KEY);
      await page.emulateMedia({ colorScheme: theme });
      await page.setViewportSize({ width: 1440, height: 900 });
      await login(page);
      await page.goto("/simple/priorities?tab=buckets");
      const shown = page.locator("[data-goal-id]");
      await expect(shown.first()).toBeVisible();
      const ids = await shown.evaluateAll((els) => els.map((e) => e.getAttribute("data-goal-id")));
      const before = await buckets(page);
      const goal = before.goals.find((g) => ids.includes(g.id) && before.features.some((f) => f.goal_ids.includes(g.id)))!;
      const n = before.features.filter((f) => f.goal_ids.includes(goal.id)).length;
      const features = `with ${n} ${n === 1 ? "feature" : "features"}`;

      const bucket = page.locator(`[data-goal-id="${goal.id}"]`);
      await bucket.getByRole("button", { name: `More for ${goal.title}` }).click();
      await page.getByRole("menuitem", { name: "Delete goal" }).click();
      await page.getByRole("dialog", { name: `Delete ${goal.title}` }).getByRole("button", { name: "Delete goal" }).click();
      await expect(bucket).toHaveCount(0);

      await page.setViewportSize(size);
      await page.goto("/settings/trash");
      const row = page.getByTestId("trash-entry").filter({ hasText: goal.title });
      await expect(row.getByTestId("trash-kind")).toHaveText("Goal");
      await expect(row.getByTestId("trash-holds")).toHaveText(features);
      await noWiderThanTheScreen(page);
      const tip = row.getByRole("button", { name: `About restoring ${goal.title}` });
      await tap(tip);
      await expect(row.getByRole("tooltip")).toContainText(`Restore brings back Goal ${goal.title} ${features}`);
      await page.keyboard.press("Escape");

      await tap(row.getByRole("button", { name: `Restore ${goal.title}` }));
      await expect(row).toHaveCount(0);
      expect((await buckets(page)).goals.map((g) => g.id)).toContain(goal.id);
    });

    test(`G-4: a removed agenda item in Trash names its meeting (${at})`, async ({ page }) => {
      test.setTimeout(90_000);
      await page.addInitScript((key) => localStorage.setItem(key, "meeting-agenda-sheet"), MOCK_SCENARIO_KEY);
      await page.emulateMedia({ colorScheme: theme });
      await page.setViewportSize({ width: 1440, height: 900 });
      await login(page);
      await page.goto("/simple/meetings");
      await tap(page.getByRole("button", { name: /^Start review/ }).first());
      const start = page.getByRole("dialog", { name: "Start a review" });
      await start.getByLabel("PRD").selectOption({ label: "Usage alerts PRD" });
      await start.getByRole("checkbox", { name: "Theo Brandt" }).check();
      await tap(start.getByRole("button", { name: "Start", exact: true }));
      await expect(page.getByRole("heading", { name: "Review: Usage alerts PRD" })).toBeVisible();
      await tap(page.getByTestId("agenda-strip").getByTestId("agenda-open"));
      const sheet = page.getByRole("dialog", { name: "Agenda" });
      await tap(sheet.getByRole("button", { name: "Remove Alert history export" }));
      await expect(sheet.getByTestId("agenda-row").filter({ hasText: "Alert history export" })).toHaveCount(0);
      await page.keyboard.press("Escape");

      await page.setViewportSize(size);
      await page.goto("/settings/trash");
      const row = page.getByTestId("trash-entry").filter({ hasText: "Alert history export" });
      await expect(row.getByTestId("trash-kind")).toHaveText("Agenda item");
      await expect(row.getByTestId("trash-holds")).toHaveText(/^from .*Usage alerts PRD/);
      await noWiderThanTheScreen(page);
      await tap(row.getByRole("button", { name: "About restoring Alert history export" }));
      await expect(row.getByRole("tooltip")).toContainText(/Restore brings back Agenda item Alert history export to .*Usage alerts PRD/);
    });
  }
