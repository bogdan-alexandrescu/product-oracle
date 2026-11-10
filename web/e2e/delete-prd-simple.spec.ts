import { THEME_KEY } from "../lib/theme";
import { ADMIN, login } from "./helpers";
import { expect, test, type Page } from "./test";

/*
 * delete-prd-simple, EP2 a "Menus on both" (the owner's pick, Nov 5): a ⋯ menu on each One-pagers
 * row and on the one-pager's header deletes the PRD to Settings > Trash, on the mock's own PRDs
 * (invented). Desktop 1440x900 in light and a 390x844 phone in dark.
 *
 * - protects = an owner's row ⋯ offers the order moves and Delete PRD; the confirm asks first,
 *   says it goes to Settings > Trash for 30 days and names what goes with it (its roadmap) and
 *   what it feeds (its roadmap items and its track); Delete PRD takes the row off the
 *   list with a note and Undo, Trash lists it, and Undo brings it back; the one-pager's header has
 *   the same ⋯ and goes back to One-pagers without the PRD, its Undo opens it again; a viewer sees
 *   no ⋯ anywhere. fails_when = no ⋯, no confirm, the confirm names nothing it feeds, the row
 *   stays, Trash lacks it, Undo fails, or a viewer gets a ⋯.
 * - no_claim = Archive PRD (no PRD archive in the API).
 */

const USAGE = "Usage alerts PRD";
const CHECKOUT = "Checkout redesign PRD";

const LOOKS = [
  { name: "desktop light", viewport: { width: 1440, height: 900 }, theme: "light" },
  { name: "phone dark", viewport: { width: 390, height: 844 }, theme: "dark" },
] as const;

const rows = (page: Page) => page.getByTestId("one-pager-row");

async function open(page: Page, look: (typeof LOOKS)[number], who = ADMIN.email) {
  await page.setViewportSize(look.viewport);
  await page.context().addInitScript(([key, theme]) => localStorage.setItem(key, theme), [THEME_KEY, look.theme] as const);
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
      // What goes with it: its roadmap.
      const withIt = dialog.getByTestId("delete-prd-with");
      await expect(withIt.getByText("Roadmap", { exact: true }).first()).toBeVisible();
      // What it feeds, which stays: its roadmap items and its track.
      const feeds = dialog.getByTestId("delete-prd-feeds");
      await expect(feeds).toContainText("These stay, without it:");
      await expect(feeds.getByText("Alert rules engine", { exact: true })).toBeVisible();
      await expect(feeds.getByText("Usage alerts track", { exact: true })).toBeVisible();
      await expect(feeds.getByText("Track", { exact: true })).toBeVisible();
      await dialog.getByRole("button", { name: "Delete PRD" }).click();
      await expect(dialog).toHaveCount(0);

      const note = page.getByTestId("one-pagers-note");
      await expect(note).toContainText(`Deleted ${USAGE}. It is in Settings > Trash for 30 days.`);
      await expect(rows(page).filter({ hasText: USAGE })).toHaveCount(0);
      await note.getByRole("button", { name: "Undo" }).click();
      await expect(note).toContainText(`Restored ${USAGE}.`);
      await expect(rows(page).filter({ hasText: USAGE })).toHaveCount(1);
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
