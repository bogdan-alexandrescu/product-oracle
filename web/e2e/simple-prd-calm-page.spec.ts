import { login } from "./helpers";
import { expect, test, type Page } from "./test";

/**
 * PS1 a "Calm page" (mk-prd-look): on the Simple side a PRD reads as its one-pager, then the
 * whole PRD it is built from in one calm column, every section numbered as on the Detailed side,
 * with a contents list beside it on a desktop. Driven through the UI as an owner and a viewer, on
 * a desktop (1440, light and dark) and a phone (390).
 *
 * protects = the one-pager keeps its blocks, Edit, Present and Export PDF; under it the whole PRD
 * reads section by section, numbered (1 Problem …), its codes with their names, its tables in
 * their own box; the contents list jumps to a block or a section; a line that starts with a
 * feature code shows the code as a chip that opens the feature panel; a viewer reads it all with
 * no Edit; Present shows the one-pager alone;
 * fails_when = the page shows the one-pager only, the PRD's sections carry no numbers, a code
 * shows without its name, or a feature code opens nothing;
 * no_claim = the PRD version's API (GET /v1/documents/{doc}/versions/{n}, unchanged).
 */

const URL = "/simple/one-pagers/guided-setup";

async function openPage(page: Page, email?: string) {
  await login(page, email);
  await page.goto("/simple/one-pagers");
  await expect(page.getByRole("heading", { level: 1, name: "One-pagers" })).toBeVisible();
  // The list's rows read a size up.
  await expect(page.getByTestId("one-pager-row").first()).toHaveCSS("font-size", "18px");
  await page.goto(URL);
  await expect(page.getByRole("heading", { level: 1, name: "Guided setup" })).toBeVisible();
}

const whole = (page: Page) => page.getByTestId("prd-whole");
/** A section of the whole PRD, found by its numbered heading. */
const prdSection = (page: Page, heading: string) => whole(page).locator("section").filter({ has: page.getByRole("heading", { name: heading, exact: true }) });

for (const scheme of ["light", "dark"] as const) {
  test.describe(`desktop 1440 · ${scheme}`, () => {
    test.use({ viewport: { width: 1440, height: 900 }, colorScheme: scheme });

    test("the one-pager, then the whole PRD numbered, with a contents list beside it", async ({ page }) => {
      await openPage(page);
      const onePager = page.getByRole("article", { name: "One-pager" });
      await expect(onePager.getByRole("heading", { level: 2, name: "What we will build" })).toBeVisible();
      await expect(page.getByRole("button", { name: /^Edit “A setup checklist/ })).toHaveCount(1);
      await expect(page.getByRole("button", { name: "Export PDF" })).toBeVisible();

      // The whole PRD under the one-pager, numbered as on the Detailed side.
      await expect(whole(page).getByRole("heading", { level: 2, name: "The whole PRD" })).toBeVisible();
      const problem = prdSection(page, "1 Problem");
      await expect(problem.getByRole("heading", { level: 3 })).toHaveText("1 Problem");
      await expect(problem).toContainText("New workspace admins stall during setup");
      // A code is never shown without its name.
      const risks = prdSection(page, "7 Risks and open decisions");
      await expect(risks).toContainText("F-26 Calendar invites may slip past M1");
      await expect(whole(page)).not.toContainText("[c:");

      // The contents list beside it: the blocks, then the PRD's sections; a pick jumps there.
      const contents = page.getByRole("navigation", { name: "Contents" });
      await expect(contents.getByRole("link", { name: "What we will build", exact: true })).toBeVisible();
      await contents.getByRole("link", { name: "11 Not this quarter" }).click();
      const later = prdSection(page, "11 Not this quarter");
      await expect(later).toBeInViewport();
      await expect(contents).toBeInViewport();
      await contents.getByRole("link", { name: "Outcomes and how we measure them", exact: true }).click();
      await expect(onePager.getByRole("region", { name: "Outcomes and how we measure them" })).toBeInViewport();

      // The table reads in its own box.
      await expect(prdSection(page, "9 Glossary").getByRole("region", { name: "Table" })).toContainText("Calendar invites");

      // A feature code in the PRD opens the feature panel.
      await risks.getByRole("button", { name: "Open F-26 Calendar invites" }).click();
      await expect(page.getByTestId("item-panel")).toBeVisible();
      await expect(page.getByTestId("item-panel")).toHaveAttribute("aria-label", /Calendar invites/);
    });

    test("a line that starts with a feature code shows it as a chip that opens the panel", async ({ page }) => {
      await openPage(page);
      const line = page.locator('[data-line="risks-3"]');
      await expect(line).toContainText("F-26 Calendar invites may slip past M1");
      await line.getByRole("button", { name: "Open F-26 Calendar invites" }).click();
      await expect(page.getByTestId("item-panel")).toHaveAttribute("aria-label", /Calendar invites/);
    });

    test("Present shows the one-pager alone", async ({ page }) => {
      await openPage(page);
      await expect(whole(page)).toBeVisible();
      await page.getByRole("button", { name: "Present" }).click();
      await expect(page.getByRole("button", { name: "Stop presenting" })).toBeVisible();
      await expect(whole(page)).toHaveCount(0);
      await expect(page.getByRole("navigation", { name: "Contents" })).toHaveCount(0);
      await page.getByRole("button", { name: "Stop presenting" }).click();
      await expect(whole(page)).toBeVisible();
    });

    test("a viewer reads the whole PRD with no Edit", async ({ page }) => {
      await openPage(page, "viewer@example.com");
      await expect(prdSection(page, "1 Problem")).toBeVisible();
      await expect(page.getByRole("navigation", { name: "Contents" })).toBeVisible();
      await expect(page.getByRole("button", { name: /^Edit “/ })).toHaveCount(0);
    });
  });
}

test.describe("phone 390", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("the whole PRD reads under the one-pager; a table scrolls in its own box", async ({ page }) => {
    await openPage(page);
    await expect(page.getByRole("navigation", { name: "Contents" })).toBeHidden();
    const targets = prdSection(page, "10 Targets");
    await targets.scrollIntoViewIfNeeded();
    await expect(targets).toContainText("Company-wide target: 250 paid workspaces a month");
    await expect(prdSection(page, "9 Glossary").getByRole("region", { name: "Table" })).toBeVisible();
    // Nothing widens the page.
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  });
});
