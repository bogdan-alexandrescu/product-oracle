import type { FrameLocator } from "@playwright/test";

import { expect, test, type Page } from "./test";

import { login } from "./helpers";

const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };

/** A list date ("Oct 1, 2026"): month, day and year, no time of day. */
const LIST_DATE = /[A-Z][a-z]{2} \d{1,2}, \d{4}/;
const TIME_OF_DAY = /\d{1,2}:\d{2}|AM|PM/;

/** The AI feature PRD's sections, by their headings; its title heading is a placeholder. */
const AI_SECTIONS = "Title, Model behaviour, Evals, Fallbacks, Cost, Sources and data points";

/** The sample's title in a preview frame takes one line: its height is about one line-height. */
async function expectTitleOnOneLine(frame: FrameLocator, label: string) {
  const title = frame.getByRole("heading", { level: 1 });
  await expect(title, label).toBeVisible();
  await expect
    .poll(
      () =>
        title.evaluate((el) => {
          const { height } = el.getBoundingClientRect();
          const s = getComputedStyle(el);
          const line = parseFloat(s.lineHeight) || parseFloat(s.fontSize) * 1.2;
          return height / line;
        }),
      { message: label },
    )
    .toBeLessThan(1.5);
}

test.describe("desktop", () => {
  test.use({ viewport: DESKTOP });

  test("qa-settings-26: suggested themes read as names; keys and sections are not code", async ({ page }) => {
    await login(page);
    await page.goto("/settings/templates");
    const row = page.getByTestId("template-row-ai-feature");
    await expect(row).toContainText("Technical spec");
    await expect(row).not.toContainText("technical-spec");
    await expect(page.locator('tr[data-testid^="template-row-"] .font-mono')).toHaveCount(0);

    // Selecting the row: its facts by name, the key in plain text.
    await row.getByText("v1", { exact: true }).click();
    const inspector = page.getByTestId("template-inspector");
    await expect(inspector).toContainText("AI feature PRD");
    await expect(inspector).toContainText("Technical spec");
    await expect(inspector.locator(".font-mono")).toHaveCount(0);

    // The template page: required sections by their headings, the theme by its name.
    await page.goto("/settings/templates/ai-feature");
    await expect(page.getByTestId("version-required")).toHaveText(AI_SECTIONS);
    await expect(page.getByTestId("version-required")).not.toHaveClass(/font-mono/);
    await expect(page.getByTestId("suggested-theme")).toHaveText("Technical spec");
    await expect(page.getByTestId("check-theme")).toHaveText("Technical spec");

    // The themes list keeps its key out of code font too.
    await page.goto("/settings/themes");
    await expect(page.getByTestId("theme-inspector")).toBeVisible();
    await expect(page.getByTestId("theme-inspector").locator(".font-mono")).toHaveCount(0);
  });

  test("qa-settings-27: a template page says each fact once; the placeholder title is 'Title'", async ({ page }) => {
    await login(page);
    await page.goto("/settings/templates/ai-feature");
    await expect(page.getByRole("heading", { level: 1, name: "AI feature PRD" })).toBeVisible();
    // The name is the page's heading only, not repeated as the details panel's title.
    await expect(page.getByRole("heading", { name: "AI feature PRD" })).toHaveCount(1);
    const details = page.locator('aside[aria-label="Template details"]');
    await expect(details).toBeVisible();
    // Kind and version are the header's chips; not again in the details.
    await expect(details.getByText("PRD", { exact: true })).toHaveCount(0);
    await expect(details.getByText("v1", { exact: true })).toHaveCount(0);
    await expect(page.getByTestId("suggest-when")).toHaveCount(1);

    // The live check names the title section "Title", not its placeholder heading.
    const sections = page.getByTestId("section-names");
    await expect(sections).toHaveText(AI_SECTIONS);
    await expect(sections).not.toContainText("<Feature>");
  });

  test("qa-settings-28: each form's main action sits under the form and says why it is disabled", async ({ page }) => {
    await login(page);
    const header = () => page.locator("header[data-page-header]").filter({ visible: true });

    // New template.
    await page.goto("/settings/templates/new");
    let action = page.getByRole("button", { name: "Create template" });
    await expect(action).toBeDisabled();
    await expect(header().getByRole("button", { name: "Create template" })).toHaveCount(0);
    await expect(page.getByTestId("create-template-reason")).toHaveText("Enter a key to create the template.");
    await expect(action).toHaveAccessibleDescription("Enter a key to create the template.");
    expect((await action.boundingBox())!.y).toBeGreaterThan((await page.getByLabel("Body").boundingBox())!.y);
    await page.getByLabel("Key").fill("launch-brief");
    await expect(page.getByTestId("create-template-reason")).toHaveText("Enter a name to create the template.");
    await page.getByLabel("Name").fill("Launch brief");
    await expect(action).toBeEnabled();
    await expect(page.getByTestId("create-template-reason")).toHaveCount(0);

    // New theme.
    await page.goto("/settings/themes/new");
    action = page.getByRole("button", { name: "Create theme" });
    await expect(action).toBeDisabled();
    await expect(header().getByRole("button", { name: "Create theme" })).toHaveCount(0);
    await expect(page.getByTestId("create-theme-reason")).toHaveText("Enter a key to create the theme.");
    expect((await action.boundingBox())!.y).toBeGreaterThan((await page.getByLabel("Start from").boundingBox())!.y);
    await page.getByLabel("Key").fill("company-brand");
    await page.getByLabel("Name").fill("Company brand");
    await expect(action).toBeEnabled();
    await expect(page.getByTestId("create-theme-reason")).toHaveCount(0);

    // A template: Save as new version under the editor.
    await page.goto("/settings/templates/one-pager");
    action = page.getByRole("button", { name: "Save as new version" });
    await expect(action).toBeDisabled();
    await expect(header().getByRole("button", { name: "Save as new version" })).toHaveCount(0);
    await expect(page.getByTestId("version-save-reason")).toHaveText("Change the template to save a new version.");
    expect((await action.boundingBox())!.y).toBeGreaterThan((await page.getByLabel("Template body").boundingBox())!.y);
    await expect(action).toHaveAttribute("data-variant", "primary");

    // A theme: Save under the editor.
    await page.goto("/settings/themes/clean-document");
    action = page.getByRole("button", { name: "Save", exact: true });
    await expect(action).toBeDisabled();
    await expect(header().getByRole("button", { name: "Save", exact: true })).toHaveCount(0);
    await expect(page.getByTestId("theme-save-reason")).toHaveText("Change something to save the theme.");
    expect((await action.boundingBox())!.y).toBeGreaterThan((await page.getByLabel("Muted", { exact: true }).boundingBox())!.y);
    await page.getByLabel("Base size (pt)").fill("12");
    await expect(action).toBeEnabled();
    await expect(page.getByTestId("theme-save-reason")).toHaveCount(0);
  });

  for (const [role, email] of [
    ["owner", undefined],
    ["commenter", "commenter@example.com"],
    ["viewer", "viewer@example.com"],
  ] as const) {
    test(`qa-settings-29: a template's name opens it and its row selects it, the same for a ${role}`, async ({ page }) => {
      await login(page, email);
      await page.goto("/settings/templates");
      const row = page.getByTestId("template-row-ai-feature");
      // A click on the row (not the name) selects it: the inspector shows it, the list stays.
      await row.getByText("v1", { exact: true }).click();
      await expect(row).toHaveAttribute("aria-selected", "true");
      await expect(page.getByTestId("template-inspector")).toContainText("AI feature PRD");
      await expect(page).toHaveURL(/\/settings\/templates$/);
      // A click on the name opens the template's page.
      await row.getByRole("link", { name: "AI feature PRD" }).click();
      await expect(page).toHaveURL(/\/settings\/templates\/ai-feature$/);
      await expect(page.getByRole("heading", { level: 1, name: "AI feature PRD" })).toBeVisible();
    });
  }

  test("qa-settings-31: detail pages show dates as the lists do", async ({ page }) => {
    await login(page);
    await page.goto("/settings/themes");
    const listed = (await page.getByTestId("theme-row-clean-document").locator("td").last().innerText()).trim();
    expect(listed).toMatch(LIST_DATE);

    await page.goto("/settings/themes/clean-document");
    const details = page.locator('aside[aria-label="Theme details"]');
    await expect(details).toContainText(listed);
    await expect(details).not.toContainText(TIME_OF_DAY);

    await page.goto("/settings/templates/one-pager");
    const option = page.getByLabel("Version", { exact: true }).locator("option").first();
    await expect(option).toHaveText(/^v1 · [A-Z][a-z]{2} \d{1,2}, \d{4} · latest$/);
    await expect(page.locator('aside[aria-label="Template details"]')).not.toContainText(TIME_OF_DAY);
  });

  test("qa-settings-32: fonts are picked by name; the CSS stack waits under Advanced", async ({ page }) => {
    await login(page);
    await page.goto("/settings/themes/clean-document");
    const heading = page.getByLabel("Heading font", { exact: true });
    expect(await heading.evaluate((el) => el.tagName)).toBe("SELECT");
    await expect(heading).toHaveValue("DejaVu Sans");
    // The raw stacks (in the closed Advanced boxes) are out of sight.
    await expect(page.getByText('"DejaVu Sans", Helvetica, Arial, sans-serif').filter({ visible: true })).toHaveCount(0);

    const stack = page.getByLabel("Heading font fallbacks (CSS)");
    await expect(stack).toBeHidden();
    await page.locator("details").filter({ has: stack }).locator("summary").click();
    await expect(stack).toBeVisible();
    await expect(stack).toHaveValue('"DejaVu Sans", Helvetica, Arial, sans-serif');

    // Picking a font by name writes its stack.
    await heading.selectOption("Georgia");
    await expect(stack).toHaveValue('Georgia, "Times New Roman", serif');
    await expect(page.getByTestId("font-heading-hint")).toHaveText("Uses Georgia; without it, Times New Roman, then serif.");
  });
});

for (const [name, viewport] of [
  ["1440", DESKTOP],
  ["390", PHONE],
] as const) {
  test.describe(`at ${name}`, () => {
    test.use({ viewport });

    test(`qa-settings-30: the theme preview reads as a page, its title on one line (${name})`, async ({ page }) => {
      await login(page);
      await page.goto("/settings/themes");
      await expectTitleOnOneLine(page.frameLocator('[data-testid="theme-inspector-preview"]'), "themes list");
      await page.goto("/settings/themes/editorial-memo");
      await expectTitleOnOneLine(page.frameLocator('[data-testid="theme-preview"]'), "theme page");
      await page.goto("/settings/themes/new");
      await expectTitleOnOneLine(page.frameLocator('[data-testid="theme-preview"]'), "new theme");
    });
  });
}

test.describe("phone", () => {
  test.use({ viewport: PHONE });

  async function tallLinks(page: Page, path: string, rows: string) {
    await page.goto(path);
    const links = page.locator(`tr[data-testid^="${rows}"] td[data-phone="title"] a`).filter({ visible: true });
    await expect(links.first()).toBeVisible();
    for (const link of await links.all()) {
      expect((await link.boundingBox())!.height, `${path}: ${await link.innerText()}`).toBeGreaterThanOrEqual(24);
    }
  }

  test("qa-settings-43: template and theme names are tall enough to tap", async ({ page }) => {
    await login(page);
    await tallLinks(page, "/settings/templates", "template-row-");
    await tallLinks(page, "/settings/themes", "theme-row-");
  });

  /**
   * The panel's top is in the upper half of the window (at the top, unless the page ends
   * first: the last panel cannot scroll higher than the page's end).
   */
  async function expectRevealed(panel: ReturnType<Page["getByTestId"]>) {
    await expect.poll(async () => (await panel.boundingBox())!.y).toBeLessThan(PHONE.height / 2);
    await expect.poll(async () => (await panel.boundingBox())!.y).toBeGreaterThanOrEqual(-1);
  }

  async function tapRow(page: Page, testId: string) {
    const row = page.getByTestId(testId);
    await row.scrollIntoViewIfNeeded();
    const box = (await row.boundingBox())!;
    // The row's top right corner: the row itself, not its name's link.
    await row.click({ position: { x: box.width - 8, y: 6 } });
  }

  test("qa-settings-44: tapping a template or theme brings its panel into view", async ({ page }) => {
    await login(page);
    await page.goto("/settings/templates");
    const templates = page.getByTestId("template-inspector");
    await expect(templates).toBeVisible();
    await expect(templates).not.toBeInViewport();
    await tapRow(page, "template-row-outcome-roadmap");
    await expect(page).toHaveURL(/\/settings\/templates$/);
    await expectRevealed(templates);
    await expect(templates.getByRole("heading", { level: 2 })).toHaveText("Outcome roadmap");

    await page.goto("/settings/themes");
    const themes = page.getByTestId("theme-inspector");
    await expect(themes).toBeVisible();
    await tapRow(page, "theme-row-roadmap-board");
    await expect(page).toHaveURL(/\/settings\/themes$/);
    await expectRevealed(themes);
    await expect(themes.getByRole("heading", { level: 2 })).toHaveText("Roadmap board");
  });
});
