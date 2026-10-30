import { login, openRoadmapItem } from "./helpers";
import { expect, test, type Locator, type Page } from "./test";

/**
 * Roadmap item card QA fixes, driven through the UI on the mock
 * (web/lib/api/mock/simple-roadmap.ts, simple-meetings.ts):
 *
 * qa-simple-roadmap-10: on a desktop, pressing Enter in the inline "Add an item" field
 * (title typed, roadmap chosen) adds the item straight away, as a draft, to the first
 * available place — no full-width sheet reopens to ask for the title and roadmap again.
 * A phone has no such field (its "Add" always opens the sheet, unchanged, so there is
 * nothing to add an Enter test for there).
 *
 * qa-simple-roadmap-39 / 50: the quick-add chip's accessible name is the drag action
 * ("Drag to place…"), never the title just typed, and its glyph is a real icon (an SVG),
 * not a character that renders as a broken box on some platforms.
 *
 * qa-simple-roadmap-14 / 48: the item card's Status, Confidence, dates-source, "Needed by"
 * and "Decided in" read in plain words, not the API's lowercase enum values or a missing
 * colon ("Decided in D-4 Moved Weekly alert digest").
 */

const ROADMAP = "/simple/roadmap";
const toastWith = (page: Page, text: string | RegExp): Locator => page.getByRole("status").filter({ hasText: text });
const addSheet = (page: Page): Locator => page.getByRole("dialog", { name: "Add an item" });

async function openRoadmap(page: Page) {
  await login(page);
  await page.goto(ROADMAP);
  await expect(page.getByTestId("simple-roadmap")).toBeVisible();
}

/** Types a title and, when quick add asks (all roadmaps, more than one), picks one — the
 * state qa-simple-roadmap-10 and -39/50 both start from. */
async function readyQuickAdd(page: Page, title: string) {
  await page.getByLabel("Add an item").fill(title);
  const roadmap = page.getByTestId("quick-add-roadmap");
  if (await roadmap.count()) await roadmap.selectOption({ label: "Alerts roadmap" });
  await expect(page.getByTestId("quick-add-chip")).toHaveAttribute("aria-disabled", "false");
}

test.describe("desktop 1440x900", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("qa-simple-roadmap-10: Enter in Add an item adds it straight away, with no sheet repeating the title and roadmap", async ({ page }) => {
    await openRoadmap(page);
    const title = "Push notifications for alerts";
    await readyQuickAdd(page, title);

    await page.getByLabel("Add an item").press("Enter");

    // No phone-style sheet reopens Title / Roadmap / Where.
    await expect(addSheet(page)).toHaveCount(0);
    // The item went in as a draft at once (a toast says so), not merely staged in the field.
    await expect(toastWith(page, `Added ${title} as a draft`)).toBeVisible();
    // The field is clear again, ready for the next title.
    await expect(page.getByLabel("Add an item")).toHaveValue("");
  });

  test("qa-simple-roadmap-39 / 50: the quick-add chip names the drag action, not the typed title, with a real icon", async ({ page }) => {
    await openRoadmap(page);
    const title = "A title that must not become a button's name";
    await readyQuickAdd(page, title);

    const chip = page.getByTestId("quick-add-chip");
    const name = (await chip.getAttribute("aria-label")) ?? "";
    expect(name).not.toContain(title);
    expect(name).toMatch(/drag/i);

    // A real icon (an SVG), not a character that some fonts render as a broken box.
    await expect(chip.locator("svg")).toBeVisible();
    await expect(chip).not.toContainText("▘");
    await expect(chip).not.toContainText("⠿");

    // fix4 qa-simple-roadmap-49: the chip keeps saying what it is ("New item"); the title is in the box (and its hover).
    await expect(chip).toHaveText("New item");
    await expect(chip.locator("span[title]")).toHaveAttribute("title", title);
  });

  test("qa-simple-roadmap-14 / 48: the item card reads in plain words, with a colon after Decided in D-4", async ({ page }) => {
    await login(page);
    // The mock seeds a meeting's decisions lazily, on a meetings/Decisions read, never on
    // the roadmap alone — a Decisions visit first is what makes D-4 show on the card.
    await page.goto("/simple/decisions");
    await expect(page.getByRole("region", { name: "Review: Usage alerts" })).toBeVisible();
    await page.goto(ROADMAP);
    await expect(page.getByTestId("simple-roadmap")).toBeVisible();
    await openRoadmapItem(page, "alert-digest");
    const card = page.getByTestId("floating-card");
    await expect(card).toBeVisible();

    // Status and confidence: title case, not the API's lowercase/underscored value.
    await expect(card.getByTestId("card-status")).toHaveText("Planned");
    await expect(card.getByTestId("card-status")).not.toHaveText(/^[a-z_]/);
    await expect(card.getByTestId("card-confidence")).toHaveText("Medium");
    await expect(card.getByTestId("card-confidence")).not.toHaveText(/^[a-z]/);

    // Its dates' source reads as a sentence, not a bare "accepted"/"typed"/"estimated".
    await expect(card.getByTestId("card-dates")).toContainText("Dates accepted from Oracle");

    // Nothing depends on it: plain words, not "Nothing" (an id-less, unexplained word).
    await expect(card.getByTestId("card-needed")).toHaveText("No other items");

    // The meeting decision that moved it, with the colon the sentence needs.
    // fix4 qa-simple-roadmap-3: the decision by its title, no "D-4".
    await expect(card.getByTestId("card-decided-in")).toContainText("Moved Weekly alert digest");
    await expect(card.getByTestId("card-decided-in")).not.toContainText("D-4");
  });
});
