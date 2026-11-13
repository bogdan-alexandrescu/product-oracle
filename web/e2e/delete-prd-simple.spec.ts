import { AREA_PRDS, COMPANY_TITLE } from "../lib/api/mock/one-roadmap";
import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { THEME_KEY } from "../lib/theme";
import { ADMIN, login, seedRoadmapReview } from "./helpers";
import { expect, test, type Page } from "./test";

/*
 * delete-prd-simple, EP2 a "Menus on both" (the owner's pick, Nov 5): a ⋯ menu on each One-pagers
 * row and on the one-pager's header deletes the PRD to Settings > Trash, on the mock's own PRDs
 * (invented). Desktop 1440x900 in light and a 390x844 phone in dark.
 *
 * - protects = an owner's row ⋯ offers the order moves and Delete PRD; the confirm asks first,
 *   says it goes to Settings > Trash for 30 days and names what goes with it (its roadmap, and the
 *   roadmap items and track that leave with that roadmap) and what it feeds that stays (a PRD's
 *   items on the company roadmap, still on Roadmap after the delete); Delete PRD takes the row off
 *   the list with a note and Undo, Trash lists it, Roadmap no longer shows what went, and Undo
 *   brings it all back; Delete PRD stays off until the published tick and while a run works on it;
 *   the one-pager's header has the same ⋯ and goes back to One-pagers without the PRD, its Undo
 *   opens it again there and only restores it elsewhere (with a link); a viewer sees no ⋯ anywhere.
 *   fails_when = no ⋯, no confirm, the confirm says an item stays that leaves with its roadmap or
 *   names nothing it feeds, the row stays, Trash lacks it, Undo fails, or a viewer gets a ⋯.
 * - no_claim = Archive PRD (no PRD archive in the API).
 */

const USAGE = "Usage alerts PRD";
/** The one-roadmap scenario's area PRD, whose items sit on the company's Product roadmap. */
const SAFETY = AREA_PRDS[0][1];
const CHECKOUT = "Checkout redesign PRD";

const LOOKS = [
  { name: "desktop light", viewport: { width: 1440, height: 900 }, theme: "light" },
  { name: "phone dark", viewport: { width: 390, height: 844 }, theme: "dark" },
] as const;

const rows = (page: Page) => page.getByTestId("one-pager-row");

async function open(page: Page, look: (typeof LOOKS)[number], who = ADMIN.email, scenario?: string) {
  await page.setViewportSize(look.viewport);
  await page.context().addInitScript(([key, theme]) => localStorage.setItem(key, theme), [THEME_KEY, look.theme] as const);
  if (scenario) await page.context().addInitScript(([key, value]) => localStorage.setItem(key, value), [MOCK_SCENARIO_KEY, scenario] as const);
  await login(page, who);
  await page.goto("/simple/one-pagers");
  await expect(rows(page).first()).toBeVisible();
}

/** Delete PRD from an open ⋯; a published PRD asks once more first. */
async function confirmDelete(page: Page, title: string) {
  await page.getByRole("menuitem", { name: "Delete PRD" }).click();
  const dialog = page.getByRole("dialog", { name: `Delete ${title}` });
  await expect(dialog).toContainText(`Delete ${title}?`);
  await expect(dialog).toContainText("It goes to Settings > Trash for 30 days.");
  await expect(dialog.getByText("Finding what goes with it…")).toHaveCount(0);
  const published = dialog.getByLabel("It is published: its copy outside Oracle stays where it is.");
  if (await published.isVisible()) await published.check();
  return dialog;
}

for (const look of LOOKS) {
  test.describe(look.name, () => {
    test("Delete PRD from a row's ⋯ names what it feeds, takes it off the list to Trash, and Undo brings it back", async ({ page }) => {
      test.setTimeout(120_000);
      await open(page, look);
      const row = rows(page).filter({ has: page.getByRole("link", { name: USAGE, exact: true }) });
      await row.getByRole("button", { name: `More for ${USAGE}` }).click();
      await expect(page.getByRole("menuitem").last()).toHaveText("Delete PRD");
      await expect(page.getByRole("menuitem", { name: "Delete PRD" })).toBeInViewport();
      const dialog = await confirmDelete(page, USAGE);
      // What goes with it: its roadmap, and the roadmap items and track that leave with it.
      const withIt = dialog.getByTestId("delete-prd-with");
      await expect(withIt.getByText("Roadmap", { exact: true }).first()).toBeVisible();
      await expect(withIt.getByText("Alert rules engine", { exact: true })).toBeVisible();
      await expect(withIt.getByText("Usage alerts track", { exact: true })).toBeVisible();
      await expect(withIt.getByText("Track", { exact: true })).toBeVisible();
      // Nothing it feeds stays: its items are all on its own roadmap.
      await expect(dialog.getByTestId("delete-prd-feeds")).toHaveCount(0);
      // Tab stays in the dialog.
      for (let i = 0; i < 4; i++) {
        await page.keyboard.press("Tab");
        await expect(dialog.locator(":focus")).toHaveCount(1);
      }
      await dialog.getByRole("button", { name: "Delete PRD" }).click();
      await expect(dialog).toHaveCount(0);
      // Roadmap, in another tab, no longer shows what went.
      const roadmap = await page.context().newPage();
      await roadmap.goto("/simple/roadmap");
      await expect(roadmap.getByText("F-90 Setup checklist", { exact: true }).first()).toBeVisible();
      await expect(roadmap.getByText("Alert rules engine", { exact: true })).toHaveCount(0);
      // The mock's store is each tab's localStorage: a tab left open may write a stale read over Undo.
      await roadmap.close();

      const note = page.getByTestId("one-pagers-note");
      await expect(note).toContainText(`Deleted ${USAGE}. It is in Settings > Trash for 30 days.`);
      await expect(rows(page).filter({ hasText: USAGE })).toHaveCount(0);
      await note.getByRole("button", { name: "Undo" }).click();
      await expect(note).toContainText(`Restored ${USAGE}.`);
      await expect(rows(page).filter({ hasText: USAGE })).toHaveCount(1);
      // Undo brought back what went.
      const again = await page.context().newPage();
      await again.goto("/simple/roadmap");
      await expect(again.getByText("F-86 Alert rules engine", { exact: true }).first()).toBeVisible();
      await again.close();
    });

    test("what Delete PRD says stays is still on Roadmap after the delete", async ({ page }) => {
      test.setTimeout(120_000);
      await open(page, look, ADMIN.email, "one-roadmap");
      await rows(page).getByRole("button", { name: `More for ${SAFETY}` }).click();
      const dialog = await confirmDelete(page, SAFETY);
      const feeds = dialog.getByTestId("delete-prd-feeds");
      await expect(feeds).toContainText("These stay, without it:");
      await expect(feeds.getByText("Report button on every post", { exact: true })).toBeVisible();
      await expect(feeds.getByText("Block list", { exact: true })).toBeVisible();
      // The company roadmap other PRDs feed never goes with it.
      await expect(dialog.getByText(COMPANY_TITLE, { exact: true })).toHaveCount(0);
      await dialog.getByRole("button", { name: "Delete PRD" }).click();
      await expect(page.getByTestId("one-pagers-note")).toContainText(`Deleted ${SAFETY}.`);
      await page.goto("/simple/roadmap");
      await expect(page.getByText("Report button on every post", { exact: true }).first()).toBeVisible();
      await expect(page.getByText("Block list", { exact: true }).first()).toBeVisible();
      // Another PRD's item is still on the Roadmap.
      await expect(page.getByText("Read replicas in two regions", { exact: true }).first()).toBeVisible();
    });

    test("Delete PRD stays off until the published tick, and while a run works on the PRD", async ({ page }) => {
      test.setTimeout(120_000);
      await open(page, look);
      await rows(page).getByRole("button", { name: `More for ${USAGE}` }).click();
      await page.getByRole("menuitem", { name: "Delete PRD" }).click();
      let dialog = page.getByRole("dialog", { name: `Delete ${USAGE}` });
      await expect(dialog.getByText("Finding what goes with it…")).toHaveCount(0);
      const tick = dialog.getByLabel("It is published: its copy outside Oracle stays where it is.");
      await expect(tick).toBeVisible();
      const remove = dialog.getByRole("button", { name: "Delete PRD" });
      await expect(remove).toBeDisabled();
      await tick.check();
      await expect(remove).toBeEnabled();
      await dialog.getByRole("button", { name: "Cancel" }).click();
      await expect(dialog).toHaveCount(0);

      // A run working on its roadmap: Delete PRD stays off, and says why.
      await seedRoadmapReview(page);
      await page.reload();
      await rows(page).getByRole("button", { name: `More for ${USAGE}` }).click();
      await page.getByRole("menuitem", { name: "Delete PRD" }).click();
      dialog = page.getByRole("dialog", { name: `Delete ${USAGE}` });
      await expect(dialog).toContainText("A run is working on it. Delete it when the run ends.");
      const published = dialog.getByLabel("It is published: its copy outside Oracle stays where it is.");
      if (await published.isVisible()) await published.check();
      await expect(dialog.getByRole("button", { name: "Delete PRD" })).toBeDisabled();
    });

    test("Delete PRD from the one-pager's header goes back to One-pagers without it, in Trash, and Undo opens it again", async ({ page }) => {
      test.setTimeout(120_000);
      await open(page, look);
      await rows(page).getByRole("link", { name: CHECKOUT, exact: true }).click();
      await expect(page).toHaveURL(/\/simple\/one-pagers\/[^/]+$/);
      const back = page.url();
      const more = page.getByRole("button", { name: `More for ${CHECKOUT}` });
      await expect(more).toBeVisible();
      await more.click();
      const dialog = await confirmDelete(page, CHECKOUT);
      await dialog.getByRole("button", { name: "Delete PRD" }).click();
      await expect(page).toHaveURL(/\/simple\/one-pagers$/);
      await expect(rows(page).first()).toBeVisible();
      await expect(rows(page).filter({ hasText: CHECKOUT })).toHaveCount(0);
      const toast = page.getByTestId("toasts").getByRole("status").filter({ hasText: `Deleted ${CHECKOUT}.` });
      await expect(toast).toBeVisible();
      await toast.getByRole("button", { name: "Undo" }).click();
      await expect(page).toHaveURL(back);
      await expect(page.getByRole("button", { name: `More for ${CHECKOUT}` })).toBeVisible();
    });

    test("the header's Undo, pressed after leaving One-pagers, restores in place with a link to the PRD", async ({ page }) => {
      test.setTimeout(120_000);
      await open(page, look);
      await rows(page).getByRole("link", { name: CHECKOUT, exact: true }).click();
      await expect(page).toHaveURL(/\/simple\/one-pagers\/[^/]+$/);
      const back = page.url();
      await page.getByRole("button", { name: `More for ${CHECKOUT}` }).click();
      const dialog = await confirmDelete(page, CHECKOUT);
      await dialog.getByRole("button", { name: "Delete PRD" }).click();
      await expect(page).toHaveURL(/\/simple\/one-pagers$/);
      const toast = page.getByTestId("toasts").getByRole("status").filter({ hasText: `Deleted ${CHECKOUT}.` });
      await expect(toast).toBeVisible();
      // Off to Roadmap by its link (the note stays), then Undo.
      await page.getByRole("link", { name: "Roadmap", exact: true }).first().click();
      await expect(page).toHaveURL(/\/simple\/roadmap$/);
      await toast.getByRole("button", { name: "Undo" }).click();
      const restored = page.getByTestId("toasts").getByRole("status").filter({ hasText: `Restored ${CHECKOUT}.` });
      await expect(restored).toBeVisible();
      await expect(page).toHaveURL(/\/simple\/roadmap$/);
      await restored.getByRole("button", { name: "Open it" }).click();
      await expect(page).toHaveURL(back);
    });

    test("a deleted PRD waits in Settings > Trash", async ({ page }) => {
      test.setTimeout(120_000);
      await open(page, look);
      await rows(page).getByRole("button", { name: `More for ${CHECKOUT}` }).click();
      const dialog = await confirmDelete(page, CHECKOUT);
      await dialog.getByRole("button", { name: "Delete PRD" }).click();
      await expect(page.getByTestId("one-pagers-note")).toBeVisible();
      await page.goto("/settings/trash");
      await expect(page.getByTestId("trash-entry").filter({ hasText: CHECKOUT })).toHaveCount(1);
    });

    test("a viewer sees no ⋯ on the list or the one-pager", async ({ page }) => {
      await open(page, look, "viewer@example.com");
      await expect(page.getByRole("button", { name: /^More for / })).toHaveCount(0);
      await rows(page).getByRole("link", { name: CHECKOUT, exact: true }).click();
      await expect(page.getByRole("button", { name: "Export PDF" })).toBeVisible();
      await expect(page.getByRole("button", { name: /^More for / })).toHaveCount(0);
    });
  });
}
