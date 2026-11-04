import { expect, test, type Page } from "./test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";

import { login } from "./helpers";

/*
 * decisions-reversed-or-trashed: a decision made in a review meeting of a roadmap that goes to
 * Trash is marked so in Company › Decisions, in its row and in its inspector, and drafts no
 * longer cite it. The "trash-family" mock scenario: usage-alerts (published) has a derived
 * roadmap, and a meeting decided "Cut bulk export from the first release" about that roadmap.
 * Deleting the PRD from PRDs takes the roadmap to Trash with it.
 */

const PRD = "Usage alerts PRD";
const ROADMAP = "Usage alerts roadmap";
const CUT = "Cut bulk export from the first release";
const MARK = "Made about a roadmap now in Trash";

const row = (page: Page, text: string) =>
  page
    .getByTestId("decision-row")
    .filter({ hasText: text })
    .filter({ visible: true });
const inspector = (page: Page) =>
  page.getByTestId("decision-inspector").filter({ visible: true });
const prdRow = (page: Page) =>
  page.getByTestId("document-row").filter({ hasText: PRD });

async function deletePrd(page: Page) {
  await page.goto("/documents");
  await expect(page.getByTestId("documents-table")).toBeVisible();
  // A scroll closes a row menu: centre the row and open again until Delete… takes.
  await expect(async () => {
    await prdRow(page).evaluate((el) => el.scrollIntoView({ block: "center" }));
    if (!(await page.getByRole("menuitem", { name: "Delete…" }).isVisible()))
      await prdRow(page)
        .getByRole("button", { name: `Actions for ${PRD}` })
        .click();
    await page
      .getByRole("menuitem", { name: "Delete…" })
      .click({ timeout: 2_000 });
  }).toPass({ timeout: 20_000 });
  const dialog = page.getByRole("dialog", { name: `Delete ${PRD}` });
  await expect(dialog.getByTestId("delete-dependents")).toContainText(ROADMAP);
  await dialog
    .getByLabel("Delete it here; the external copy stays where it is")
    .check();
  await dialog.getByRole("button", { name: "Move to Trash" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByRole("status").filter({ hasText: "Moved to Trash" }),
  ).toBeVisible();
}

async function marksTheCut(page: Page) {
  await page.addInitScript(
    ([key]) => localStorage.setItem(key, "trash-family"),
    [MOCK_SCENARIO_KEY] as const,
  );
  await login(page);
  await page.goto("/company/decisions?state=all");
  await expect(row(page, CUT)).toBeVisible();
  await expect(row(page, CUT)).not.toContainText(MARK);

  await deletePrd(page);

  await page.goto("/company/decisions?state=all");
  await expect(row(page, CUT)).toContainText(MARK);
  await row(page, CUT).click();
  await expect(inspector(page)).toContainText(CUT);
  await expect(inspector(page).getByTestId("decision-trash-note")).toHaveText(
    `${MARK}. Drafts no longer cite it.`,
  );
}

test.describe("desktop", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("a decision about a roadmap moved to Trash reads Made about a roadmap now in Trash", async ({
    page,
  }) => {
    await marksTheCut(page);
  });
});

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("a decision about a roadmap moved to Trash reads Made about a roadmap now in Trash", async ({
    page,
  }) => {
    await marksTheCut(page);
  });
});
