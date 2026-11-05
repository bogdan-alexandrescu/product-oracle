import { THEME_KEY } from "../lib/theme";
import { ADMIN, login } from "./helpers";
import { expect, test, type Page } from "./test";

/*
 * edit-goals-prds EP2 a "Menus on both" (the owner's pick, BGD Nov 5): a ⋯ menu on each One-pagers
 * row and on the one-pager's header deletes the PRD to Settings > Trash, on the mock's own PRDs
 * (invented). Desktop 1440x900 and phone 390x844, light and dark.
 *
 * Card ep2-row-delete: protects = an owner's row ⋯ offers Delete PRD; the confirm asks first and
 * says it goes to Settings > Trash for 30 days; Delete PRD takes the row off the list with a note
 * and Undo, and Undo brings it back; fails_when = no ⋯, no confirm, the row stays, or Undo fails.
 * Card ep2-header-delete: protects = the one-pager's header has the same ⋯; Delete PRD goes back to
 * One-pagers without it; fails_when = no header ⋯ or the PRD is still listed.
 * Card ep2-readonly: protects = a viewer's list has no ⋯ on any row and no header ⋯; fails_when =
 * any ⋯ shows. no_claim = Archive PRD and the features' choice (the owner's question: no PRD
 * archive in the API yet).
 */

const LOOKS = [
  {
    name: "desktop light",
    viewport: { width: 1440, height: 900 },
    theme: "light",
  },
  {
    name: "desktop dark",
    viewport: { width: 1440, height: 900 },
    theme: "dark",
  },
  {
    name: "phone light",
    viewport: { width: 390, height: 844 },
    theme: "light",
  },
  { name: "phone dark", viewport: { width: 390, height: 844 }, theme: "dark" },
] as const;

async function open(
  page: Page,
  look: (typeof LOOKS)[number],
  who = ADMIN.email,
) {
  await page.setViewportSize(look.viewport);
  await page
    .context()
    .addInitScript(
      ([themeKey, theme]) => localStorage.setItem(themeKey, theme),
      [THEME_KEY, look.theme] as const,
    );
  await login(page, who);
  await page.goto("/simple/one-pagers");
  await expect(rows(page).first()).toBeVisible();
}

const rows = (page: Page) => page.getByTestId("one-pager-row");

/** Opens the confirm from a ⋯ and deletes; a published PRD asks once more first. */
async function confirmDelete(page: Page, title: string) {
  await page.getByRole("menuitem", { name: "Delete PRD" }).click();
  const dialog = page.getByRole("dialog", { name: `Delete ${title}` });
  await expect(dialog).toContainText(`Delete ${title}?`);
  await expect(dialog).toContainText(
    "It goes to Settings > Trash for 30 days.",
  );
  await expect(dialog.getByText("Finding what goes with it…")).toHaveCount(0);
  const published = dialog.getByLabel(
    "It is published: its copy outside Oracle stays where it is.",
  );
  if (await published.isVisible()) await published.check();
  await dialog.getByRole("button", { name: "Delete PRD" }).click();
  await expect(dialog).toHaveCount(0);
}

for (const look of LOOKS) {
  test.describe(look.name, () => {
    test("Delete PRD from a row's ⋯ asks first, takes it off the list, and Undo brings it back", async ({
      page,
    }) => {
      await open(page, look);
      const row = rows(page).nth(1);
      const title = (await row.getByRole("link").first().innerText()).trim();
      await row.getByRole("button", { name: `More for ${title}` }).click();
      await expect(page.getByRole("menuitem")).toHaveText(["Delete PRD"]);
      await expect(
        page.getByRole("menuitem", { name: "Delete PRD" }),
      ).toBeInViewport();
      await confirmDelete(page, title);
      const note = page.getByTestId("one-pagers-note");
      await expect(note).toHaveText(
        new RegExp(
          `Deleted ${title}\\. It is in Settings > Trash for 30 days\\.`,
        ),
      );
      await expect(rows(page).filter({ hasText: title })).toHaveCount(0);
      await note.getByRole("button", { name: "Undo" }).click();
      await expect(note).toContainText(`Restored ${title}.`);
      await expect(rows(page).filter({ hasText: title })).toHaveCount(1);
    });

    test("Delete PRD from the one-pager's header goes back to One-pagers without it", async ({
      page,
    }) => {
      await open(page, look);
      const row = rows(page).first();
      const title = (await row.getByRole("link").first().innerText()).trim();
      await row.getByRole("link").first().click();
      await expect(page).toHaveURL(/\/simple\/one-pagers\/[^/]+$/);
      const more = page.getByRole("button", { name: `More for ${title}` });
      await expect(more).toBeVisible();
      await more.click();
      await confirmDelete(page, title);
      await expect(page).toHaveURL(/\/simple\/one-pagers$/);
      await expect(rows(page).first()).toBeVisible();
      await expect(rows(page).filter({ hasText: title })).toHaveCount(0);
    });

    test("a viewer sees no ⋯ on the list or the one-pager", async ({
      page,
    }) => {
      await open(page, look, "viewer@example.com");
      await expect(
        page.getByRole("button", { name: /^More for / }),
      ).toHaveCount(0);
      await rows(page).first().getByRole("link").first().click();
      await expect(
        page.getByRole("button", { name: "Export PDF" }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: /^More for / }),
      ).toHaveCount(0);
    });
  });
}
