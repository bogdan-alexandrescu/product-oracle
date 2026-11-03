import { expect, test, type Page } from "./test";

import { MOCK_SCENARIO_KEY, TRASH_KEPT_LINKS_SCENARIO } from "../lib/api/mock/server";
import { login } from "./helpers";

/**
 * Detailed › PRDs › New PRD (new-prd-form): several approvers, a picked template stays
 * picked, and a PRD moved to Trash releases its requests. Driven through the mock build's UI,
 * desktop and phone. Invented example data only.
 *
 * Test cards:
 * - "several approvers" (2): protects='Who reads and approves it?' takes several answers and
 *   the recommendation reads all of them; fails_when=a second pick clears the first, Not sure
 *   stays on, or the founder beside leadership loses the memo; no_claim=storage (pytest
 *   test_prd_readers).
 * - "a picked template stays picked" (3): protects=answering Yes to the model question never
 *   changes a template the person picked (even the one already shown), shows
 *   'Recommended now: AI feature PRD · Use it', and switches only on that click;
 *   fails_when=the pick changes on its own or Use it does nothing; no_claim=the theme.
 * - "nothing picked" (3): protects=a template Oracle chose may follow the answers and says so
 *   in one line; fails_when=it switches without saying so; no_claim=the wording of the reason.
 * - "Trash releases the request" (4): protects=moving a PRD to Trash releases the request
 *   linked to it, so a new PRD takes it, and Restore leaves it with the new brief;
 *   fails_when=Continue fails with "already linked", or Restore takes it back;
 *   no_claim=restore re-linking a free request (pytest test_prd_trash_requests).
 * - "Release it" (4): protects=a request still linked to a PRD in Trash is refused in words
 *   that name the PRD and say it is in Trash, and Release it frees it and goes on;
 *   fails_when=the message says "another PRD" or Release it is missing; no_claim=live PRDs.
 * - "Release it follows the code" (4, review minor): protects=Release it shows for the Trash
 *   refusal's code, not for its words, so a live PRD whose title holds "which is in Trash"
 *   gets no Release it; fails_when=the button reads the message; no_claim=the 409's code
 *   itself (pytest test_prd_trash_requests).
 * Item (1), several goals under 'The goals it helps' on Simple Home, was already on main
 * (newprd-multigoal.spec.ts): this lane adds nothing for it.
 */

const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };
const PROBLEM = "People who share a pantry lose track of what is left, so they buy the same things twice.";
const READERS = "Who reads and approves it?";
const MODEL = "Does its output come from a model or agent?";

const inspector = (page: Page) => page.getByTestId("request-inspector");
const row = (page: Page, title: string) => page.getByTestId("request-row").filter({ hasText: title });
const behind = (page: Page) => page.getByRole("group", { name: /Requests behind it/ });

async function openNewPrd(page: Page) {
  await page.goto("/documents");
  await expect(page.getByTestId("documents-table")).toBeVisible();
  await page.getByRole("link", { name: "New PRD" }).filter({ visible: true }).first().click();
  await expect(page.getByRole("heading", { level: 1, name: "New PRD" })).toBeVisible();
}

async function openRequests(page: Page) {
  await page.goto("/requests");
  await expect(page.getByTestId("request-row").first()).toBeVisible();
}

async function pickRequest(page: Page, title: string) {
  await row(page, title).getByRole("button", { name: title }).click();
  await expect(inspector(page).getByRole("heading", { name: title })).toBeVisible();
}

/** Links the request to the first PRD offered; returns that PRD's title. */
async function linkFirstPrd(page: Page, title: string): Promise<string> {
  await openRequests(page);
  await pickRequest(page, title);
  const select = inspector(page).getByLabel("Linked PRD");
  await select.selectOption({ index: 1 });
  const prd = (await select.locator("option:checked").innerText()).trim();
  await inspector(page).getByRole("button", { name: "Save links" }).click();
  await expect(inspector(page).getByRole("link", { name: prd })).toBeVisible();
  return prd;
}

/** Links the request to the PRD of this title. */
async function linkPrd(page: Page, title: string, prd: string) {
  await openRequests(page);
  await pickRequest(page, title);
  await inspector(page).getByLabel("Linked PRD").selectOption({ label: prd });
  await inspector(page).getByRole("button", { name: "Save links" }).click();
  await expect(inspector(page).getByRole("link", { name: prd })).toBeVisible();
}

async function trashPrd(page: Page, prd: string) {
  await page.goto("/documents");
  await expect(page.getByTestId("documents-table")).toBeVisible();
  const prdRow = page.getByTestId("document-row").filter({ hasText: prd }).first();
  await expect(async () => {
    await prdRow.evaluate((el) => el.scrollIntoView({ block: "center" }));
    if (!(await page.getByRole("menuitem", { name: "Delete…" }).isVisible())) await prdRow.getByRole("button", { name: `Actions for ${prd}` }).click();
    await page.getByRole("menuitem", { name: "Delete…" }).click({ timeout: 2_000 });
  }).toPass({ timeout: 20_000 });
  const dialog = page.getByRole("dialog", { name: `Delete ${prd}` });
  const external = dialog.getByLabel("Delete it here; the external copy stays where it is");
  if (await external.isVisible()) await external.check();
  await dialog.getByRole("button", { name: "Move to Trash" }).click();
  await expect(dialog).toHaveCount(0);
}

for (const [label, size] of [
  ["desktop", DESKTOP],
  ["phone", PHONE],
] as const) {
  test.describe(label, () => {
    test.use({ viewport: size });

    test("several approvers: the readers question takes several answers and the recommendation reads them all", async ({ page }) => {
      await login(page);
      await openNewPrd(page);
      const group = page.getByRole("group", { name: READERS });
      const box = (name: string) => group.getByRole("checkbox", { name });
      // The chips are labels over visually hidden boxes: a person clicks the chip.
      const chip = (name: string) => group.getByText(name, { exact: true }).click();
      await expect(box("Not sure")).toBeChecked();
      await chip("The founder");
      await chip("Product and engineering");
      await chip("Engineers or coding agents");
      for (const name of ["The founder", "Product and engineering", "Engineers or coding agents"]) await expect(box(name)).toBeChecked();
      await expect(box("Not sure")).not.toBeChecked();
      await expect(box("Leadership or the board")).not.toBeChecked();
      // Leadership among them: the decision narrative, as for leadership alone.
      await chip("Leadership or the board");
      await expect(page.getByTestId("recommended-template")).toHaveText("Decision narrative");
      await chip("Leadership or the board");
      await expect(page.getByTestId("recommended-template")).toHaveText("Goal-traced PRD");
      // Not sure clears them all.
      await chip("Not sure");
      await expect(group.getByRole("checkbox", { checked: true })).toHaveCount(1);
      await chip("The founder");
      await chip("Product and engineering");

      await page.getByRole("textbox", { name: "Title" }).fill("Shared pantry list");
      await page.getByRole("textbox", { name: "What problem does it solve?" }).fill(PROBLEM);
      await page.getByRole("button", { name: "Continue" }).first().click();
      await expect(page).toHaveURL(/\/intakes\/[0-9a-f-]+$/);
    });

    test("a picked template stays picked: the new recommendation shows beside it and switches only on Use it", async ({ page }) => {
      await login(page);
      await openNewPrd(page);
      const shown = page.getByTestId("template-option-oracle-default").getByRole("radio");
      await expect(shown).toBeChecked();
      // Pick the template already shown: it is the person's pick now.
      await shown.click();
      await page.getByRole("group", { name: MODEL }).getByText("Yes", { exact: true }).click();
      await expect(page.getByTestId("recommended-template")).toHaveText("AI feature PRD");
      const now = page.getByTestId("template-recommended-now");
      await expect(now).toContainText("Recommended now: AI feature PRD");
      await expect(shown).toBeChecked();
      await expect(page.getByTestId("template-switched")).toHaveCount(0);

      // A different pick stays too.
      await page.getByTestId("template-option-one-pager").getByRole("radio").click();
      await page.getByRole("group", { name: MODEL }).getByText("No", { exact: true }).click();
      await page.getByRole("group", { name: MODEL }).getByText("Yes", { exact: true }).click();
      await expect(now).toContainText("Recommended now: AI feature PRD");
      await expect(page.getByTestId("template-option-one-pager").getByRole("radio")).toBeChecked();

      await now.getByRole("button", { name: "Use AI feature PRD" }).click();
      await expect(page.getByTestId("template-option-ai-feature").getByRole("radio")).toBeChecked();
      await expect(now).toHaveCount(0);
    });

    test("nothing picked: the template follows the answers and says so in one line", async ({ page }) => {
      await login(page);
      await openNewPrd(page);
      await expect(page.getByTestId("template-option-oracle-default").getByRole("radio")).toBeChecked();
      await page.getByRole("group", { name: MODEL }).getByText("Yes", { exact: true }).click();
      await expect(page.getByTestId("template-option-ai-feature").getByRole("radio")).toBeChecked();
      await expect(page.getByTestId("template-switched")).toHaveText("Switched to AI feature PRD to match your answers.");
      await expect(page.getByTestId("template-recommended-now")).toHaveCount(0);
    });

    test("Trash releases the request: a new PRD takes it, and Restore leaves it with the new brief", async ({ page }) => {
      await login(page);
      const prd = await linkFirstPrd(page, "Weekly summary email");
      await trashPrd(page, prd);

      // The request is free: no PRD on its page, and Start a PRD takes it.
      await openRequests(page);
      await pickRequest(page, "Weekly summary email");
      await expect(inspector(page).getByRole("link", { name: prd })).toHaveCount(0);
      await inspector(page).getByRole("button", { name: "Start a PRD" }).click();
      await expect(behind(page).getByRole("checkbox", { name: "Weekly summary email" })).toBeChecked();
      await page.getByRole("textbox", { name: "Title" }).fill("Weekly order summary");
      await page.getByRole("textbox", { name: "What problem does it solve?" }).fill(PROBLEM);
      await page.getByRole("button", { name: "Continue" }).first().click();
      await expect(page).toHaveURL(/\/intakes\/[0-9a-f-]+$/);
      // The request's own page names the new brief.
      await openRequests(page);
      await pickRequest(page, "Weekly summary email");
      await expect(inspector(page).getByRole("link", { name: "Weekly order summary" })).toBeVisible();

      // Restore: the request is taken by the new brief, so it stays there.
      await page.goto("/settings/trash");
      await page.getByTestId("trash-entry").filter({ hasText: prd }).getByRole("button", { name: `Restore ${prd}` }).click();
      await expect(page.getByTestId("trash-entry")).toHaveCount(0);
      await openRequests(page);
      await pickRequest(page, "Weekly summary email");
      await expect(inspector(page).getByRole("link", { name: "Weekly order summary" })).toBeVisible();
      await expect(inspector(page).getByRole("link", { name: prd })).toHaveCount(0);
    });

    test("Release it: a request still on a PRD in Trash is refused by name, and Release it lets Continue through", async ({ page }) => {
      await page.addInitScript(([key, value]) => localStorage.setItem(key, value), [MOCK_SCENARIO_KEY, TRASH_KEPT_LINKS_SCENARIO] as const);
      await login(page);
      const prd = await linkFirstPrd(page, "Weekly summary email");
      await trashPrd(page, prd);

      await openNewPrd(page);
      await page.getByRole("textbox", { name: "Title" }).fill("Weekly order summary");
      await page.getByRole("textbox", { name: "What problem does it solve?" }).fill(PROBLEM);
      await behind(page).getByRole("checkbox", { name: "Weekly summary email" }).check();
      await page.getByRole("button", { name: "Continue" }).first().click();
      const alert = page.getByRole("alert").filter({ hasText: "in Trash" });
      await expect(alert).toContainText(`"Weekly summary email" is still linked to the PRD "${prd}", which is in Trash.`);
      await expect(alert).not.toContainText("another PRD");
      await alert.getByRole("button", { name: "Release it" }).click();
      await expect(page).toHaveURL(/\/intakes\/[0-9a-f-]+$/);
      // The request's own page names the new brief.
      await openRequests(page);
      await pickRequest(page, "Weekly summary email");
      await expect(inspector(page).getByRole("link", { name: "Weekly order summary" })).toBeVisible();
    });

    test("Release it follows the code: a live PRD whose title says 'which is in Trash' offers no Release it", async ({ page, context }) => {
      await login(page);
      const prd = "Shelf the box which is in Trash";
      await openNewPrd(page);
      await page.getByRole("textbox", { name: "Title" }).fill(prd);
      await page.getByTestId("template-option-prd-rfc").click();
      await page.getByRole("button", { name: "Start from an empty skeleton instead" }).click();
      await expect(page).toHaveURL(/\/documents\/shelf-the-box-which-is-in-trash$/);

      await openNewPrd(page);
      await page.getByRole("textbox", { name: "Title" }).fill("Weekly order summary");
      await page.getByRole("textbox", { name: "What problem does it solve?" }).fill(PROBLEM);
      await behind(page).getByRole("checkbox", { name: "Weekly summary email" }).check();
      // Meanwhile, in a second tab, the request is linked to that live PRD.
      const other = await context.newPage();
      await linkPrd(other, "Weekly summary email", prd);
      await other.close();

      await page.getByRole("button", { name: "Continue" }).first().click();
      const alert = page.getByRole("alert").filter({ hasText: "already linked" });
      await expect(alert).toContainText(`"Weekly summary email" is already linked to the PRD "${prd}"`);
      await expect(alert.getByRole("button", { name: "Release it" })).toHaveCount(0);
    });
  });
}
