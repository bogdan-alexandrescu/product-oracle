import { login, openRoadmapItem } from "./helpers";
import { expect, test, type Locator, type Page } from "./test";

/*
 * build-feature-panel (AN PR 1204), ported onto this line's one feature panel (PR 1297): what
 * the panel lacked. Its Notes row, changed in place; the goal's Reading row ("Today 61% · target
 * ... by ..."); a name over 200 characters is refused before it is sent; who may only read is
 * told so, with Suggest a change opening the talk; a change made in the panel shows on the page
 * behind at once (every query reads again on the card-changed event). Mock default scenario (Weekly alert digest,
 * invented data), desktop 1440 and phone 390.
 */

const SIZES = [
  { name: "1440", use: { viewport: { width: 1440, height: 900 } } },
  { name: "390", use: { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true } },
];

async function tap(l: Locator) {
  await l.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await l.click();
}

const panel = (page: Page) => page.getByTestId("floating-card");

async function openDigest(page: Page, email?: string) {
  await login(page, email);
  await page.goto("/simple/roadmap");
  await expect(page.getByTestId("simple-roadmap")).toBeVisible();
  await openRoadmapItem(page, "alert-digest");
  await expect(panel(page)).toBeVisible();
}

for (const size of SIZES) {
  test.describe(size.name, () => {
    test.use(size.use);

    test("the notes are changed in place, and the goal's reading shows beside its target", async ({ page }) => {
      await openDigest(page);
      await expect(panel(page).getByTestId("card-goal-reading")).toHaveText("Today 61% · target 70% of teams by Mar 31, 2027");
      await expect(panel(page).getByTestId("card-notes")).toHaveText("No notes yet");
      await tap(panel(page).getByRole("button", { name: "Change the notes" }));
      const edit = panel(page).getByTestId("card-notes-edit");
      await edit.getByLabel("Notes").fill("x".repeat(501));
      await expect(edit.getByTestId("field-too-long")).toHaveText("Keep the notes to 500 characters");
      await expect(edit.getByRole("button", { name: "Save" })).toBeDisabled();
      await edit.getByLabel("Notes").fill("Send on Monday morning.");
      await tap(edit.getByRole("button", { name: "Save" }));
      await expect(panel(page).getByTestId("card-notes")).toHaveText("Send on Monday morning.");
    });

    test("a name over 200 characters is refused before it is sent", async ({ page }) => {
      await openDigest(page);
      await tap(panel(page).getByRole("button", { name: "More actions" }));
      await tap(page.getByRole("menuitem", { name: "Rename" }));
      await panel(page).getByLabel("Name").fill("A".repeat(201));
      await expect(panel(page).getByTestId("field-too-long")).toHaveText("Keep the name to 200 characters");
      await expect(panel(page).getByRole("button", { name: "Save" })).toBeDisabled();
      await expect(panel(page).getByLabel("Name")).toHaveValue("A".repeat(201));
    });

    test("a rename in the panel shows on the page behind at once, before the panel closes", async ({ page }) => {
      await login(page);
      await page.goto("/simple/priorities");
      const title = page.getByTestId("prio-title").first();
      await expect(title).toBeVisible();
      const name = (await title.innerText()).trim();
      await tap(title);
      await expect(panel(page)).toBeVisible();
      await tap(panel(page).getByRole("button", { name: "More actions" }));
      await tap(page.getByRole("menuitem", { name: "Rename" }));
      await panel(page).getByLabel("Name").fill(`${name} for teams`);
      await tap(panel(page).getByRole("button", { name: "Save" }));
      await expect(panel(page).getByTestId("card-name")).toContainText(`${name} for teams`);
      // The panel is still open: Priorities read again when the change was made.
      await expect(page.getByTestId("prio-title").filter({ hasText: `${name} for teams` })).toHaveCount(1);
      await expect(panel(page)).toBeVisible();
    });

    test("a viewer is told they can read it, and Suggest a change opens the talk", async ({ page }) => {
      await openDigest(page, "viewer@example.com");
      const note = panel(page).getByTestId("card-read-only");
      await expect(note).toContainText("You can read this feature.");
      await expect(panel(page).getByRole("button", { name: "Change the notes" })).toHaveCount(0);
      await tap(note.getByRole("button", { name: "Suggest a change" }));
      await expect(panel(page).getByTestId("item-talk")).toBeVisible();
    });
  });
}
