import { THEME_KEY } from "../lib/theme";
import { login } from "./helpers";
import { expect, test, type Locator, type Page } from "./test";

/**
 * Fix pass 4 on the simple roadmap's parts (the board, quick add, key dates, the legends),
 * driven through the UI against the mock (web/lib/api/mock/simple-roadmap.ts). The mock's day
 * is Oct 22, 2026; Team invite nudges is a draft with no owner, Weekly alert digest has a
 * broken link, the Later column holds Welcome video and the cut In-app tour.
 *
 * - qa-simple-roadmap-7: the board's legend names the marks its cards draw; a draft with no
 *   owner keeps its dashed draft outline (not the broken link's red).
 * - qa-simple-roadmap-14: quick add tried with nothing typed (or no roadmap) says what is missing.
 * - qa-simple-roadmap-28/29: days month-first ("Oct 22"), never "22 Oct" or an arrow; the
 *   working draft's time has no zone name.
 * - qa-simple-roadmap-32: the Later column counts the card below the line.
 * - qa-simple-roadmap-34/35: "Scale" on desktop and phone; the Gantt's column header as the
 *   Group by says it; the Gantt's legend in short words; a draft key date's hollow diamond has
 *   its own key.
 * - qa-simple-roadmap-36: a key date's row on one line; Cancel and Save the same height; the
 *   edit fields labelled.
 */

const ROADMAP = "/simple/roadmap";
const DESKTOP = { viewport: { width: 1440, height: 900 } };
const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true };

const boardCard = (page: Page, key: string): Locator => page.locator(`[data-testid="board-card"][data-item="${key}"]`);
const column = (page: Page, key: string): Locator => page.locator(`[data-testid="board-column"][data-horizon-column="${key}"]`);
const editor = (page: Page): Locator => page.getByTestId("key-dates-editor");
const legendItem = (page: Page, words: string | RegExp): Locator => page.getByTestId("legend").getByTestId("legend-item").filter({ hasText: words });

async function open(page: Page, scheme: "light" | "dark" = "light") {
  await page.context().addInitScript(([themeKey, theme]) => localStorage.setItem(themeKey, theme), [THEME_KEY, scheme] as const);
  await page.emulateMedia({ colorScheme: scheme });
  await login(page);
  await page.goto(ROADMAP);
  await expect(page.getByTestId("simple-roadmap")).toBeVisible();
}

async function format(page: Page, f: "timeline" | "gantt" | "board" | "waterfall") {
  await page.getByTestId(`format-${f}`).click();
  if (f === "board") await expect(page.getByTestId("board")).toBeVisible();
  else await expect(page.getByTestId("simple-chart")).toHaveAttribute("data-format", f);
}

for (const [where, use] of [
  ["desktop", DESKTOP],
  ["phone", PHONE],
] as const) {
  for (const scheme of ["light", "dark"] as const) {
    test.describe(`${where}, ${scheme}`, () => {
      test.use({ ...use, colorScheme: scheme });

      test(`the board's legend names what its cards draw; Later counts below the line (${where}, ${scheme})`, async ({ page }) => {
        await open(page, scheme);
        await format(page, "board");
        // qa-simple-roadmap-7: the draft with no owner is dashed, not a broken link.
        const nudges = boardCard(page, "setup-ideas");
        await expect(nudges).toHaveAttribute("data-kind", "draft");
        await expect(nudges).toHaveAttribute("data-broken", "false");
        await expect(nudges).toHaveClass(/border-dashed/);
        await expect(nudges).not.toHaveClass(/border-crit/);
        await expect(nudges.getByTestId("board-broken")).toHaveCount(0);
        await expect(nudges.getByTestId("board-flag")).toHaveText("Draft with no owner to confirm it");
        await expect(boardCard(page, "alert-digest")).toHaveAttribute("data-broken", "true");
        const legend = page.getByTestId("legend");
        await expect(legend).not.toContainText("hatched");
        await expect(legend).not.toContainText("red:");
        await expect(legendItem(page, /^Estimated dates$/)).toHaveCount(1);
        await expect(legendItem(page, /^Draft$/)).toHaveCount(1);
        await expect(legendItem(page, /^A broken link$/)).toHaveCount(1);
        // qa-simple-roadmap-32: the Later column's count includes the cut In-app tour.
        await expect(column(page, "later").getByTestId("board-below")).toContainText("In-app tour");
        await expect(column(page, "later").getByTestId("column-count")).toHaveText("1 item, 1 cut");
      });
    });
  }

  test.describe(where, () => {
    test.use(use);

    test(`quick add says what is missing (${where})`, async ({ page }) => {
      await open(page);
      await format(page, "board");
      if (where === "phone") {
        await page.getByTestId("quick-add-open").click();
        const sheet = page.getByTestId("quick-add-sheet");
        await sheet.getByRole("button", { name: /^(Add|Propose)$/ }).click();
        await expect(sheet.getByRole("alert").filter({ hasText: "Type a title" })).toBeVisible();
        await sheet.getByLabel("Title").fill("Usage export");
        await expect(sheet.getByText("Type a title")).toHaveCount(0);
        if ((await sheet.getByLabel("Roadmap").count()) > 0) {
          await sheet.getByRole("button", { name: /^(Add|Propose)$/ }).click();
          await expect(sheet.getByRole("alert").filter({ hasText: "Pick the roadmap it goes on" })).toBeVisible();
        }
        return;
      }
      const field = page.getByLabel("Add an item");
      await field.click();
      await field.press("Enter");
      // Nothing typed and no roadmap chosen: both are said.
      await expect(page.getByTestId("quick-add-error")).toHaveText("Type a title · Pick the roadmap it goes on");
      await expect(field).toHaveAttribute("aria-invalid", "true");
      // All roadmaps: the roadmap is asked, and an add without one says so.
      await expect(page.getByTestId("quick-add-roadmap")).toBeVisible();
      await field.fill("Usage export");
      await field.press("Enter");
      await expect(page.getByTestId("quick-add-error")).toHaveText("Pick the roadmap it goes on");
      await page.getByTestId("quick-add-roadmap").selectOption({ index: 1 });
      await expect(page.getByTestId("quick-add-error")).toHaveCount(0);
    });

    test(`Scale, the Gantt's header and legend in short words (${where})`, async ({ page }) => {
      await open(page);
      await format(page, "gantt");
      await expect(page.locator("body")).not.toContainText("Gantt scale");
      await expect(page.getByRole("group", { name: "Scale" })).toBeVisible();
      const header = page.getByTestId("chart-labels").locator("> div").first();
      await expect(header).toHaveText("Goal");
      await expect(header).toHaveCSS("text-transform", "none");
      const legend = page.getByTestId("legend");
      await expect(legendItem(page, /^Today$/)).toHaveCount(1);
      await expect(legend).not.toContainText("red line:");
      await expect(legend).not.toContainText("the horizon’s window");
      await format(page, "waterfall");
      await expect(page.getByTestId("legend")).not.toContainText("bunch up");
      await expect(page.getByTestId("legend")).toContainText("a dated gate stays on its day");
    });

    test(`key dates: one-line rows, a key for the draft's hollow diamond, labelled fields, a time with no zone (${where})`, async ({ page }) => {
      await open(page);
      await format(page, "gantt");
      await expect(legendItem(page, "Key date in the draft")).toHaveCount(0);
      await page.getByTestId("key-dates-open").click();
      await editor(page).getByLabel("Roadmap", { exact: true }).selectOption({ label: "Alerts roadmap" });
      await editor(page).getByLabel("New key date's name").fill("Partner summit with the whole partner team");
      await editor(page).getByLabel("New key date's day").fill("2026-12-02");
      await editor(page).getByRole("button", { name: "Add" }).click();
      const row = editor(page).locator('[data-testid="key-date-row"][data-name="Partner summit with the whole partner team"]');
      const badge = row.getByTestId("key-date-in-draft");
      await expect(badge).toBeVisible();
      // One line: the day and the badge sit on the name's line, the badge in one piece.
      const day = (await row.getByTestId("key-date-day").boundingBox())!;
      const b = (await badge.boundingBox())!;
      // On the same line: the badge (smaller type) sits inside the day's line box.
      expect(b.y).toBeGreaterThanOrEqual(day.y - 1);
      expect(b.y + b.height).toBeLessThanOrEqual(day.y + day.height + 1);
      expect(b.height).toBeLessThan(24);
      // The day is one line, on the name's line (the name is cut, never wrapped).
      const name = (await row.getByTitle("Partner summit with the whole partner team").boundingBox())!;
      expect(Math.abs(day.y - name.y)).toBeLessThanOrEqual(1);
      expect(day.height).toBeLessThanOrEqual(name.height + 1);

      // Edit: labelled fields, Cancel and Save the same height.
      await editor(page).getByRole("button", { name: "Edit Customer conference" }).click();
      const edit = editor(page).getByTestId("key-date-edit");
      for (const label of ["Name", "Date", "Note"]) await expect(edit.getByText(label, { exact: true })).toBeVisible();
      await expect(edit.getByLabel("Date", { exact: true })).toHaveValue("2026-11-14");
      const cancel = (await edit.getByRole("button", { name: "Cancel" }).boundingBox())!;
      const save = (await edit.getByRole("button", { name: /^(Save|Propose)$/ }).boundingBox())!;
      expect(Math.abs(cancel.height - save.height)).toBeLessThan(1);
      await edit.getByRole("button", { name: "Cancel" }).click();
      await editor(page).getByRole("button", { name: "Close" }).click();

      // qa-simple-roadmap-35: the hollow diamond has its key.
      await expect(legendItem(page, "Key date in the draft")).toHaveCount(1);
      // qa-simple-roadmap-29: the working draft's time carries no zone name.
      const words = page.getByTestId("draft-words");
      await expect(words).toContainText(/since \d{1,2}:\d{2} [AP]M/);
      await expect(words).not.toContainText(/[AP]M [A-Z]{2,5}\b/);
    });

    test(`days are written month-first (${where})`, async ({ page }) => {
      await open(page);
      await format(page, "timeline");
      if (where === "phone") {
        await page.getByTestId("phone-lane").first().click();
        const row = page.getByTestId("lane-row").first();
        await expect(row).toContainText(/[A-Z][a-z]{2} \d{1,2}(, 20\d\d)? – [A-Z][a-z]{2} \d{1,2}/);
        await expect(row).not.toContainText("→");
      } else {
        await expect(page.getByTestId("simple-chart").getByTestId("legend-item").filter({ hasText: /^Today / })).toHaveText("Today Oct 22");
      }
    });
  });
}
