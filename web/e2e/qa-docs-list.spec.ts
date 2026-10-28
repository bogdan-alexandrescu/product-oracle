import { expect, test, type Page } from "./test";

import { MOCK_FAIL_KEY, MOCK_ROLE_KEY, MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";

// QA pass 1, docs lane: the PRDs list (/documents), its side panel, row menu, delete dialog
// and Ideas tab.

type Role = "viewer" | "commenter" | "approver" | "owner";

async function open(page: Page, role: Role = "owner", scenario?: string) {
  await page.addInitScript(([rk, r]) => localStorage.setItem(rk, r), [
    MOCK_ROLE_KEY,
    role,
  ] as const);
  if (scenario)
    await page.addInitScript(([sk, s]) => localStorage.setItem(sk, s), [
      MOCK_SCENARIO_KEY,
      scenario,
    ] as const);
  await login(page);
  await page.goto("/documents");
  await expect(page.getByTestId("document-row").first()).toBeVisible();
}

const row = (page: Page, title: string) =>
  page.getByTestId("document-row").filter({ hasText: title });
/** Selects a row; a click on the row already selected would open it. */
async function pick(page: Page, name: string) {
  const r = row(page, name);
  if ((await r.getAttribute("aria-selected")) !== "true") await r.locator("td").last().click({ position: { x: 4, y: 4 } });
}
const inspector = (page: Page) => page.getByTestId("document-inspector");

test.describe("desktop", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("qa-docs-40, prod-8: one title and one count; the panel says the approved version once", async ({
    page,
  }) => {
    await open(page);
    // The count is on the PRDs tab only: no '7 PRDs' chip, no second 'PRDs' card title.
    await expect(page.getByText(/^\d+ PRDs?$/)).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "PRDs" })).toHaveCount(1);
    await expect(
      page.getByRole("button", { name: /^PRDs\s*\d+$/ }),
    ).toBeVisible();

    // Usage alerts: its latest version is its approved one, said once, in words.
    await pick(page, "Usage alerts PRD");
    await expect(inspector(page).getByTestId("inspector-approved")).toHaveText(
      /^v\d+, the latest$/,
    );
    // A PRD with nothing approved says so, not 'No' or a dash.
    await pick(page, "Saved carts PRD");
    await expect(inspector(page).getByTestId("inspector-approved")).toHaveText(
      "Not approved",
    );
  });

  test("qa-docs-24, qa-docs-42: templates and themes by their names, in the body font", async ({
    page,
  }) => {
    await open(page);
    const table = page.getByTestId("documents-table");
    await expect(row(page, "Saved carts PRD")).toContainText("Goal-traced PRD");
    await expect(table).not.toContainText("oracle-default");
    await expect(table.locator(".font-mono")).toHaveCount(0);
    await row(page, "Saved carts PRD").click();
    await expect(inspector(page).getByTestId("inspector-template")).toHaveText(
      "Goal-traced PRD",
    );
    await expect(inspector(page).getByTestId("inspector-theme")).toHaveText(
      "Clean document",
    );
    await expect(inspector(page)).not.toContainText("clean-document");
    await expect(inspector(page).locator(".font-mono")).toHaveCount(0);
    // One empty marker: no '-' anywhere a value is missing.
    for (const cell of await table.locator("td").allInnerTexts())
      expect(cell.trim()).not.toBe("-");
  });

  test("qa-docs-25: the info tip is plain words and names the rail's Plan", async ({
    page,
  }) => {
    await open(page);
    await page.getByRole("button", { name: "About PRDs" }).click();
    const tip = page.getByRole("tooltip");
    await expect(tip).toContainText("Plan");
    await expect(tip).not.toContainText("POST");
    await expect(tip).not.toContainText("oracle push");
    await expect(tip).not.toContainText(/\bRoadmap\b/);
  });

  test("qa-docs-41: In review filters the list and the column headers sort", async ({
    page,
  }) => {
    await open(page);
    const all = await page.getByTestId("document-row").count();
    const filter = page.getByTestId("prd-filter");
    const inReview = filter.getByRole("button", { name: /^In review/ });
    await inReview.click();
    await expect(inReview).toHaveAttribute("aria-pressed", "true");
    const n = await page.getByTestId("document-row").count();
    expect(n).toBeGreaterThan(0);
    expect(n).toBeLessThan(all);
    for (const r of await page.getByTestId("document-row").all())
      await expect(r).toContainText("In review");
    await filter.getByRole("button", { name: "All" }).click();
    await expect(page.getByTestId("document-row")).toHaveCount(all);

    await page.getByTestId("sort-title").click();
    const titles = await page
      .getByTestId("document-row")
      .locator("td:first-child a")
      .allInnerTexts();
    expect(titles).toEqual([...titles].sort((a, b) => a.localeCompare(b)));
    await page.getByTestId("sort-title").click();
    const reversed = await page
      .getByTestId("document-row")
      .locator("td:first-child a")
      .allInnerTexts();
    expect(reversed).toEqual([...titles].reverse());
  });

  test("review: each sorted header says its order with aria-sort, in words that fit the column", async ({
    page,
  }) => {
    await open(page);
    const table = page.getByTestId("documents-table");
    const header = (k: string) =>
      table.getByRole("columnheader").filter({ has: page.getByTestId(`sort-${k}`) });
    // Newest first by default: Updated is the sorted column.
    await expect(header("updated")).toHaveAttribute("aria-sort", "descending");
    await expect(page.getByTestId("sort-updated")).toHaveAccessibleName("Sort by Updated, newest first");
    for (const k of ["title", "status", "latest"])
      await expect(header(k)).toHaveAttribute("aria-sort", "none");

    await page.getByTestId("sort-title").click();
    await expect(header("title")).toHaveAttribute("aria-sort", "ascending");
    await expect(page.getByTestId("sort-title")).toHaveAccessibleName("Sort by Document, A to Z");
    await expect(header("updated")).toHaveAttribute("aria-sort", "none");
    await page.getByTestId("sort-title").click();
    await expect(header("title")).toHaveAttribute("aria-sort", "descending");
    await expect(page.getByTestId("sort-title")).toHaveAccessibleName("Sort by Document, Z to A");

    await page.getByTestId("sort-status").click();
    await expect(header("status")).toHaveAttribute("aria-sort", "ascending");
    await expect(page.getByTestId("sort-status")).toHaveAccessibleName("Sort by Status, drafts first");

    await page.getByTestId("sort-updated").click();
    await expect(header("updated")).toHaveAttribute("aria-sort", "descending");
    await page.getByTestId("sort-updated").click();
    await expect(header("updated")).toHaveAttribute("aria-sort", "ascending");
    await expect(page.getByTestId("sort-updated")).toHaveAccessibleName("Sort by Updated, oldest first");
  });

  test("review: when template names cannot load, the list says so and still reads in words", async ({
    page,
  }) => {
    await page.addInitScript(([k, v]) => localStorage.setItem(k, v), [MOCK_FAIL_KEY, "/v1/templates"] as const);
    await open(page);
    await expect(page.getByTestId("template-names-failed")).toHaveText(
      "Template names could not load, so they show in plain words.",
    );
    await expect(page.getByTestId("documents-table")).not.toContainText("oracle-default");
  });

  test("qa-docs-17: the row menu says it opens the latest version, and does", async ({
    page,
  }) => {
    await open(page);
    await row(page, "Saved carts PRD")
      .getByRole("button", { name: "Actions for Saved carts PRD" })
      .click();
    const menu = page.getByRole("menu", {
      name: "Actions for Saved carts PRD",
    });
    await expect(menu.getByRole("menuitem", { name: "Edit" })).toHaveCount(0);
    await menu.getByRole("menuitem", { name: "Open v2" }).click();
    await expect(page).toHaveURL(/\/documents\/saved-carts\/v\/2$/);
  });

  test("qa-docs-43: the delete dialog names the draft run in words, not its flow", async ({
    page,
  }) => {
    // priority-order: a Baseline to PRD run writes Usage alerts.
    await open(page, "owner", "priority-order");
    await row(page, "Usage alerts PRD")
      .getByRole("button", { name: "Actions for Usage alerts PRD" })
      .click();
    await page.getByRole("menuitem", { name: "Delete…" }).click();
    const dialog = page.getByRole("dialog", {
      name: "Delete Usage alerts PRD",
    });
    const goes = dialog.getByTestId("delete-dependents");
    await expect(goes.getByTestId("delete-runs")).toHaveText(
      /^The (\d+ )?draft runs? that created/,
    );
    await expect(goes).not.toContainText("Baseline to PRD");
    await expect(goes).not.toContainText(/Run\s{2}/);
  });

  test("qa-docs-44: an empty Ideas tab says where ideas come from and links there", async ({
    page,
  }) => {
    await open(page);
    await page.getByRole("button", { name: /^Ideas/ }).click();
    const empty = page.getByTestId("ideas-empty");
    await expect(empty).toContainText("An idea is a brief for a PRD");
    await empty.getByRole("link", { name: "Requests" }).click();
    await expect(page).toHaveURL(/\/requests/);
    await page.goBack();
    await page.getByRole("button", { name: /^Ideas/ }).click();
    await page
      .getByTestId("ideas-empty")
      .getByRole("link", { name: "New PRD" })
      .click();
    await expect(page).toHaveURL(/\/documents\/new/);
  });

  for (const theme of ["light", "dark"] as const) {
    test(`qa-docs-41 (${theme}): the sorted column shows its arrow and the filter reads`, async ({
      page,
    }) => {
      await page.addInitScript(
        (t) => localStorage.setItem("oracle-theme", t),
        theme,
      );
      await open(page);
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      // Updated sorts newest first by default.
      await expect(page.getByTestId("sort-updated")).toHaveAttribute(
        "aria-label",
        /newest or highest first/,
      );
      await expect(
        page
          .getByTestId("prd-filter")
          .getByRole("button", { name: /^In review/ }),
      ).toBeVisible();
    });
  }
});

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("qa-docs-16: tapping a PRD opens it, no panel waits below the list", async ({
    page,
  }) => {
    await open(page);
    await expect(inspector(page)).toHaveCount(0);
    // The status cell, not the title link: a tap anywhere on the row opens it.
    await row(page, "Saved carts PRD").locator("td").nth(1).click();
    await expect(page).toHaveURL(/\/documents\/saved-carts$/);
    await expect(
      page.getByRole("heading", { level: 1, name: "Saved carts PRD" }),
    ).toBeVisible();
  });

  test("review: on a phone the arrow keys move the selection; Enter opens the PRD", async ({
    page,
  }) => {
    await open(page);
    const rows = page.getByTestId("document-row");
    const second = rows.nth(1);
    const href = await second.locator("td:first-child a").getAttribute("href");
    const title = await second.locator("td:first-child a").innerText();
    await rows.first().focus();
    await page.keyboard.press("ArrowDown");
    await expect(second).toBeFocused();
    await expect(second).toHaveAttribute("aria-selected", "true");
    await expect(page).toHaveURL(/\/documents$/);
    await page.keyboard.press("ArrowUp");
    await expect(rows.first()).toBeFocused();
    await expect(page).toHaveURL(/\/documents$/);
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(new RegExp(`${href}$`));
    await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();
  });

  test("qa-docs-44: the Ideas empty text wraps on a phone", async ({
    page,
  }) => {
    await open(page);
    await page.getByRole("button", { name: /^Ideas/ }).click();
    await expect(page.getByTestId("ideas-empty")).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth,
      ),
    ).toBeLessThanOrEqual(0);
  });
});
