import { expect, test, type Locator, type Page } from "./test";

import { login } from "./helpers";

/*
 * QA findings on Settings > Templates and Settings > Themes (qa-settings-7, 13, 19, 20, 21,
 * 30, 32, 35), through the UI on the mock.
 */

const PHONE = { width: 390, height: 844 };

/** Whether an element shows all of its text (nothing cut off, across or down). */
const fits = (el: Locator) =>
  el.evaluate((e) => e.scrollWidth <= e.clientWidth + 1 && e.scrollHeight <= e.clientHeight + 1);

const top = async (el: Locator) => (await el.boundingBox())!.y;

async function openTheme(page: Page, name: string) {
  await page.getByRole("navigation", { name: "Oracle" }).getByTestId("nav-settings").click();
  await page.getByRole("navigation", { name: "Settings" }).getByTestId("nav-themes").click();
  await page.getByRole("link", { name, exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name })).toBeVisible();
}

async function openTemplates(page: Page) {
  await page.getByRole("navigation", { name: "Oracle" }).getByTestId("nav-settings").click();
  await page.getByRole("navigation", { name: "Settings" }).getByTestId("nav-templates").click();
  await expect(page.getByRole("heading", { level: 1, name: "Templates" })).toBeVisible();
}

test("qa-settings-7: a wrong colour is named by its field, next to that field", async ({ page }) => {
  await login(page);
  await openTheme(page, "Clean document");
  const text = page.getByLabel("Text", { exact: true });
  await text.fill("#12");
  const problem = page.getByTestId("field-problem");
  await expect(problem).toHaveText("Text colour must be a hex colour like #1f2933");
  await expect(text).toHaveAttribute("aria-invalid", "true");
  await expect(text).toHaveAccessibleDescription("Text colour must be a hex colour like #1f2933");
  // Under its own field, not in a list on top.
  const field = await text.boundingBox();
  const under = await problem.boundingBox();
  expect(under!.y).toBeGreaterThan(field!.y);
  expect(under!.y - (field!.y + field!.height)).toBeLessThan(40);
  await expect(page.getByText("colors.text")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled();

  await text.fill("#1f2933");
  await expect(page.getByTestId("field-problem")).toHaveCount(0);
});

test("qa-settings-13: a template names its suggested theme, linked; the key is for developers", async ({ page }) => {
  await login(page);
  await openTemplates(page);
  const row = page.getByTestId("template-row-ai-feature");
  await expect(row.getByTestId("template-theme")).toHaveText("Technical spec");
  await expect(row.getByRole("link", { name: "Technical spec" })).toHaveAttribute("href", "/settings/themes/technical-spec");
  await expect(page.getByTestId("templates-prd")).not.toContainText("technical-spec");
  await expect(page.getByTestId("templates-prd")).not.toContainText("clean-document");

  await page.getByRole("link", { name: "AI feature PRD" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "AI feature PRD" })).toBeVisible();
  const facts = page.getByTestId("template-facts");
  await expect(facts).toContainText("Technical spec");
  await expect(facts).not.toContainText("technical-spec");
  await expect(page.getByTestId("template-developers")).toContainText("For developers");
  await expect(page.getByTestId("template-developers")).toContainText("ai-feature");
  await page.getByRole("link", { name: "Technical spec" }).first().click();
  await expect(page).toHaveURL(/\/settings\/themes\/technical-spec$/);
  await expect(page.getByRole("heading", { level: 1, name: "Technical spec" })).toBeVisible();
});

test("qa-settings-19: 'Suggested when' shows its text; the version preview folds when it equals the editor", async ({
  page,
}) => {
  await login(page);
  await openTemplates(page);
  await page.getByRole("link", { name: "AI feature PRD" }).click();
  await expect(page.getByTestId("suggest-when")).toContainText("Suggested when");
  await expect(page.getByTestId("suggest-when")).toContainText("Any feature whose output comes from a model or agent");

  // The latest version is what the editor holds: printed once, the copy folded away.
  const same = page.getByTestId("version-same");
  await expect(same).toContainText("Same as the editor above");
  await expect(page.getByTestId("version-body")).toBeHidden();
  await same.getByText(/Show v\d+/).click();
  await expect(page.getByTestId("version-body")).toBeVisible();

  // Once the editor changes, the saved version shows in full beside it.
  const editor = page.getByLabel("Template body");
  await editor.fill(`${await editor.inputValue()}\n`);
  await expect(page.getByTestId("version-same")).toHaveCount(0);
  await expect(page.getByTestId("version-body")).toBeVisible();
});

test("qa-settings-20: descriptions and font stacks have room for their text", async ({ page }) => {
  await login(page);
  await openTemplates(page);
  await page.getByRole("link", { name: "AI feature PRD" }).click();
  const description = page.getByLabel("Description", { exact: true });
  await expect(description).toHaveValue("Specify model behaviour, evals, fallbacks, cost and prompt ownership");
  expect(await description.evaluate((e) => e.tagName)).toBe("TEXTAREA");
  expect(await fits(description)).toBe(true);

  await openTheme(page, "Clean document");
  const body = page.getByLabel("Body font", { exact: true });
  await expect(body).toHaveValue(/Helvetica, Arial, sans-serif/);
  expect(await fits(body)).toBe(true);
  expect(await page.getByLabel("Description", { exact: true }).evaluate((e) => e.tagName)).toBe("TEXTAREA");

  await page.goto("/settings/templates/new");
  expect(await page.getByLabel("Description", { exact: true }).evaluate((e) => e.tagName)).toBe("TEXTAREA");
  await page.goto("/settings/themes/new");
  expect(await page.getByLabel("Description", { exact: true }).evaluate((e) => e.tagName)).toBe("TEXTAREA");
});

test("qa-settings-21: themes list swatches are named; the preview opens large; the theme page preview is wide", async ({
  page,
}) => {
  await login(page);
  await page.goto("/settings/themes");
  const row = page.getByTestId("theme-row-clean-document");
  const text = row.getByRole("img", { name: /^Text colour #[0-9a-f]{6}$/i });
  await expect(text).toBeVisible();
  await expect(text).toHaveAttribute("title", (await text.getAttribute("aria-label"))!);
  await expect(row.getByRole("img", { name: /^Background colour #/ })).toBeVisible();

  await row.locator("td").last().click();
  await expect(page.locator('iframe[title="Theme thumbnail"]')).toHaveAttribute("scrolling", "no");
  await page.getByRole("button", { name: "Open a larger preview of Clean document" }).click();
  const dialog = page.getByTestId("theme-preview-dialog");
  await expect(dialog).toBeVisible();
  const frame = dialog.locator("iframe");
  expect((await frame.boundingBox())!.width).toBeGreaterThan(600);
  const large = page.frameLocator('[data-testid="theme-preview-dialog"] iframe');
  await expect(large.getByRole("heading", { name: "Example feature PRD" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);

  // On the theme page the preview gets the main column's width, and Enlarge opens it larger.
  await page.getByRole("link", { name: "Clean document", exact: true }).click();
  const preview = page.getByTestId("theme-preview");
  await expect(preview).toBeVisible();
  expect((await preview.boundingBox())!.width).toBeGreaterThan(560);
  await page.getByRole("button", { name: "Enlarge" }).click();
  await expect(page.getByTestId("theme-preview-large")).toBeVisible();
});

test.describe("qa-settings-30: a viewer on a New page sees a compact lock with a way back", () => {
  for (const [path, tab] of [
    ["/settings/templates/new", "Templates"],
    ["/settings/themes/new", "Themes"],
  ] as const) {
    test(path, async ({ page }) => {
      await login(page, "viewer@example.com");
      await page.goto(path);
      const locked = page.getByTestId("not-for-role");
      await expect(locked).toContainText("Not available for your role");
      expect((await locked.boundingBox())!.height).toBeLessThan(120);
      await expect(locked.getByRole("link", { name: "Open Settings" })).toHaveCount(0);
      await locked.getByRole("link", { name: `Back to ${tab}` }).click();
      await expect(page).toHaveURL(new RegExp(`/settings/${tab.toLowerCase()}$`));
      await expect(page.getByRole("heading", { level: 1, name: tab })).toBeVisible();
    });
  }

  test("on a phone, too", async ({ page }) => {
    await page.setViewportSize(PHONE);
    await login(page, "viewer@example.com");
    await page.goto("/settings/themes/new");
    const locked = page.getByTestId("not-for-role");
    await expect(locked.getByRole("link", { name: "Back to Themes" })).toBeVisible();
    expect((await locked.boundingBox())!.height).toBeLessThan(180);
  });
});

test.describe("qa-settings-32: a wrong key says why next to the field; placeholders read as examples", () => {
  for (const [path, button] of [
    ["/settings/templates/new", "Create template"],
    ["/settings/themes/new", "Create theme"],
  ] as const) {
    test(path, async ({ page }) => {
      await login(page);
      await page.goto(path);
      const create = page.getByRole("button", { name: button });
      await expect(page.getByTestId("create-needs")).toContainText("add a key and a name");
      await expect(page.getByLabel("Key")).toHaveAttribute("placeholder", /^e\.g\. /);
      await expect(page.getByLabel("Name", { exact: true })).toHaveAttribute("placeholder", /^e\.g\. /);

      await page.getByLabel("Key").fill("Bad Key!");
      await page.getByLabel("Name", { exact: true }).fill("Bad key");
      const error = page.getByTestId("key-error");
      await expect(error).toHaveText(
        "Use only lowercase letters, numbers and dashes, starting with a letter or number (no spaces).",
      );
      await expect(page.getByLabel("Key")).toHaveAccessibleDescription(/Use only lowercase letters/);
      await expect(create).toBeDisabled();

      await page.getByLabel("Key").fill("bad-key");
      await expect(error).toHaveCount(0);
      await expect(page.getByTestId("create-needs")).toHaveCount(0);
      await expect(create).toBeEnabled();
    });
  }
});

test("qa-settings-35: on a phone, a theme's details and Archive come before its editor", async ({ page }) => {
  await page.setViewportSize(PHONE);
  await login(page);
  await page.goto("/settings/themes/editorial-memo");
  await expect(page.getByRole("heading", { level: 1, name: "Editorial memo" })).toBeVisible();
  const name = page.getByRole("textbox", { name: "Name", exact: true });
  const archive = page.getByRole("button", { name: "Archive" });
  const colours = page.getByLabel("Text colour picker");
  await expect(name).toHaveValue("Editorial memo");
  expect(await top(name)).toBeLessThan(await top(colours));
  expect(await top(archive)).toBeLessThan(await top(colours));
  expect(await top(archive)).toBeLessThan(await top(page.getByLabel("CSS", { exact: true })));
});
