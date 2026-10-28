import { expect, test, type Page } from "./test";

import { MOCK_ROLE_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";

// QA pass 1, docs lane: the New PRD and New roadmap pages (/documents/new).

type Role = "viewer" | "commenter" | "approver" | "owner";

async function open(page: Page, role: Role, url = "/documents/new?kind=prd") {
  await page.addInitScript(([rk, r]) => localStorage.setItem(rk, r), [MOCK_ROLE_KEY, role] as const);
  await login(page);
  await page.goto(url);
}

const companyDefault = (page: Page) => page.getByTestId("recommendation-panel");

test.describe("desktop", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("qa-docs-8: Make company default asks first, can be undone, and only one of the two buttons shows", async ({ page }) => {
    await open(page, "owner");
    await expect(page.getByRole("heading", { level: 1, name: "New PRD" })).toBeVisible();
    const panel = companyDefault(page);
    await expect(panel).toContainText("None set. New PRDs start with the recommendation.");
    await page.getByTestId("template-option-prd-rfc").click();

    // Back on the question changes nothing.
    await panel.getByRole("button", { name: "Make company default" }).click();
    const ask = page.getByRole("alertdialog", { name: "Make company default" });
    await expect(ask).toContainText("Every new PRD in the company will start with Product spec + RFC");
    await ask.getByRole("button", { name: "Back" }).click();
    await expect(ask).toBeHidden();
    await expect(page.getByTestId("company-default")).toHaveCount(0);

    // Confirmed: it says so, with Undo; the selection is the default, so neither button shows.
    await panel.getByRole("button", { name: "Make company default" }).click();
    await ask.getByRole("button", { name: "Make company default" }).click();
    await expect(page.getByTestId("company-default-saved")).toContainText("Company default for new PRDs saved.");
    await expect(page.getByTestId("company-default")).toContainText("Product spec + RFC");
    await expect(page.getByTestId("company-default")).toContainText("Selected");
    await expect(panel.getByRole("button", { name: "Use company default" })).toHaveCount(0);
    await expect(panel.getByRole("button", { name: "Make company default" })).toHaveCount(0);

    // Another template: Use and Make both apply to different things; the name is never cut.
    await page.getByTestId("template-option-oracle-default").click();
    await expect(panel.getByRole("button", { name: "Use company default" })).toBeVisible();
    const name = page.getByTestId("company-default").locator("span").first();
    expect(await name.evaluate((el) => getComputedStyle(el).textOverflow)).not.toBe("ellipsis");

    // Undo puts back the one before it (none).
    await page.getByTestId("company-default-saved").getByRole("button", { name: "Undo" }).click();
    await expect(page.getByTestId("company-default")).toHaveCount(0);
    await expect(panel).toContainText("None set.");
    await page.reload();
    await expect(companyDefault(page)).toContainText("None set.");
  });

  test("qa-docs-9: Continue on an empty form says what is missing, next to each field", async ({ page }) => {
    await open(page, "approver");
    await missingFields(page);
  });

  test("qa-docs-10 / qa-shell-9: a viewer has no New PRD and is told up front on the page, in words", async ({ page }) => {
    await open(page, "viewer", "/documents");
    await expect(page.getByRole("heading", { level: 1, name: "PRDs" })).toBeVisible();
    await expect(page.getByRole("link", { name: "New PRD" })).toHaveCount(0);

    await page.goto("/documents/new?kind=prd");
    await expect(page.getByRole("heading", { level: 1, name: "New PRD" })).toBeVisible();
    const note = page.getByTestId("new-prd-not-allowed");
    await expect(note).toContainText("Only commenters, approvers and owners can start a PRD.");
    await expect(page.getByRole("textbox", { name: "Title" })).toHaveCount(0);
    await expect(page.getByTestId("recommendation-panel")).toHaveCount(0);
    await expect(page.locator("body")).not.toContainText(/403|Requires the/);
    await note.getByRole("link", { name: "Back to PRDs" }).click();
    await expect(page).toHaveURL(/\/documents$/);
  });

  test("qa-docs-10: a commenter writes a PRD brief but is told up front a roadmap is not theirs to start", async ({ page }) => {
    await open(page, "commenter");
    await expect(page.getByRole("textbox", { name: "Title" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Continue" })).toBeEnabled();

    await page.goto("/documents/new?kind=roadmap");
    await expect(page.getByRole("heading", { level: 1, name: "New roadmap" })).toBeVisible();
    await expect(page.getByTestId("new-draft-not-allowed")).toContainText("Only approvers and owners can start a roadmap.");
    await expect(page.getByRole("textbox", { name: "Title" })).toHaveCount(0);
    await expect(page.locator("body")).not.toContainText(/403|Requires the/);
  });

  test("qa-docs-24: the selected template and theme are named, never by key", async ({ page }) => {
    await open(page, "owner");
    const panel = page.getByTestId("recommendation-panel");
    await expect(panel).toContainText("Goal-traced PRD");
    await expect(panel).not.toContainText(/oracle-default|clean-document|prd-rfc/);
    await page.getByTestId("template-option-prd-rfc").click();
    await expect(panel).toContainText("Product spec + RFC");
    await expect(panel).not.toContainText(/oracle-default|clean-document|prd-rfc/);
  });
});

async function missingFields(page: Page) {
  const title = page.getByRole("textbox", { name: "Title" });
  const problem = page.getByRole("textbox", { name: "What problem does it solve?" });
  const go = page.getByRole("button", { name: "Continue" });
  await expect(go).toBeEnabled();
  await go.click();
  await expect(page.getByTestId("new-prd-missing")).toHaveText("To continue, give it a title and say what problem it solves.");
  await expect(page.getByText("Give the PRD a title.")).toBeVisible();
  await expect(title).toHaveAttribute("aria-invalid", "true");
  await expect(title).toBeFocused();
  await expect(page).toHaveURL(/\/documents\/new\?kind=prd$/);

  await title.fill("Saved addresses at checkout");
  await problem.fill("Too short");
  await go.click();
  await expect(page.getByTestId("new-prd-missing")).toHaveText("To continue, say what problem it solves.");
  await expect(page.getByText("Say a little more: at least 20 characters (9 so far).")).toBeVisible();
  await expect(problem).toBeFocused();

  await problem.fill("Returning buyers retype their address at every checkout.");
  await expect(page.getByTestId("new-prd-missing")).toHaveCount(0);
  await go.click();
  await expect(page).toHaveURL(/\/intakes\/[0-9a-f-]+$/);
}

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("qa-docs-9: on a phone too, Continue says what is missing", async ({ page }) => {
    await open(page, "approver");
    await missingFields(page);
  });

  test("qa-docs-10: on a phone a viewer reads the note, with no form", async ({ page }) => {
    await open(page, "viewer");
    await expect(page.getByTestId("new-prd-not-allowed")).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Title" })).toHaveCount(0);
    const wide = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(wide).toBeLessThanOrEqual(0);
  });
});

for (const scheme of ["light", "dark"] as const) {
  test(`qa-docs-64 (${scheme}): theme thumbnails show a page, descriptions wrap, the goal distance says to what`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize({ width: 1440, height: 900 });
    await open(page, "owner");

    // Each thumbnail shows a page: the preview at a size whose words can be read, never blank.
    const thumbs = page.getByRole("radiogroup", { name: "Theme" }).getByTestId("theme-thumbnail");
    await expect(thumbs.first()).toBeVisible();
    const n = await thumbs.count();
    expect(n).toBeGreaterThan(0);
    for (let i = 0; i < n; i++) await expect(thumbs.nth(i)).toHaveAttribute("data-ready", "true");
    const frame = page.getByTestId("theme-option-clean-document").locator("iframe");
    await expect(frame).toHaveCSS("width", "400px");
    await expect(page.getByTestId("theme-option-clean-document").frameLocator("iframe").locator("body")).toContainText(/\w+/);

    // Template descriptions wrap, whole.
    const desc = page.getByTestId("template-option-oracle-default").getByText(/^Goal trace, problem alignment/);
    await expect(desc).toBeVisible();
    const clipped = await desc.evaluate((el) => getComputedStyle(el).textOverflow === "ellipsis" || el.scrollWidth > el.clientWidth);
    expect(clipped).toBe(false);

    // A goal's distance says what it is a distance to.
    const goals = page.getByRole("group", { name: "Which goals does it serve?" });
    await expect(goals).toContainText("from target");
    await expect(goals).not.toContainText(/ to go\b/);
  });
}
