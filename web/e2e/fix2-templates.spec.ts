import { expect, test, type Locator, type Page } from "./test";

import { login } from "./helpers";

/** A box shows its whole text: nothing is scrolled out of sight inside it. */
async function expectNotClipped(box: Locator) {
  const { scroll, client } = await box.evaluate((el) => ({ scroll: el.scrollHeight, client: el.clientHeight }));
  expect(scroll).toBeLessThanOrEqual(client + 1);
}

const LONG =
  "For launches that cross several teams, where marketing, support and sales each need their own part of the story told plainly before the date";

test("qa-settings-10: a new template's key is checked, and the field says what a key may contain", async ({ page }) => {
  await login(page);
  await page.goto("/settings/templates/new");
  const key = page.getByLabel("Key");
  const hint = page.getByTestId("template-key-hint");
  await expect(hint).toHaveText("Lowercase letters, digits and hyphens, starting with a letter or digit. It cannot change later.");
  await page.getByLabel("Name").fill("Launch brief");

  await key.fill("-launch");
  // The browser checks the pattern now (a bare "-" made it invalid under the /v flag, so it was ignored).
  expect(await key.evaluate((el) => (el as HTMLInputElement).validity.patternMismatch)).toBe(true);
  await expect(key).toHaveAttribute("aria-invalid", "true");
  await expect(hint).toHaveText(
    "A key may contain only lowercase letters, digits and hyphens, and starts with a letter or digit.",
  );
  await expect(page.getByRole("button", { name: "Create template" })).toBeDisabled();

  await key.fill("launch-brief");
  expect(await key.evaluate((el) => (el as HTMLInputElement).validity.patternMismatch)).toBe(false);
  await expect(key).not.toHaveAttribute("aria-invalid", "true");
});

test("qa-settings-10, qa-settings-34: a new theme's key is checked; a taken key is said under the field", async ({ page }) => {
  await login(page);
  await page.goto("/settings/themes/new");
  const key = page.getByLabel("Key");
  const hint = page.getByTestId("theme-key-hint");
  await key.fill("a");
  expect(await key.evaluate((el) => (el as HTMLInputElement).validity.patternMismatch)).toBe(true);
  await expect(hint).toHaveText("A key needs at least 2 characters: lowercase letters, digits and hyphens.");

  await key.fill("clean-document");
  await page.getByLabel("Name").fill("Another clean one");
  await page.getByRole("button", { name: "Create theme" }).click();
  await expect(hint).toHaveText("A theme with key clean-document already exists. Archived themes keep their keys.");
  await expect(key).toHaveAttribute("aria-invalid", "true");
  // Typing again clears it.
  await key.fill("clean-document-2");
  await expect(hint).toHaveText("Lowercase letters, digits and hyphens, starting with a letter or digit. It cannot change later.");
});

test("qa-settings-34: template problems read as sentences; a taken key is said under the Key field", async ({ page }) => {
  await login(page);
  await page.goto("/settings/templates/new");
  const body = page.getByLabel("Body");
  const original = await body.inputValue();
  await body.fill("Just some words, no headings.\n");
  await expect(page.getByTestId("problems")).toContainText("The template has no headings (levels 1 to 3).");
  await expect(page.getByTestId("problems")).not.toContainText("level 1-3");

  await body.fill(original);
  await page.getByLabel("Key").fill("one-pager");
  await page.getByLabel("Name").fill("Another one-pager");
  const create = page.getByRole("button", { name: "Create template" });
  await expect(create).toBeEnabled();
  await create.click();
  await expect(page.getByTestId("template-key-hint")).toHaveText(
    "A template with key one-pager already exists. Archived templates keep their keys.",
  );
  await expect(page.getByText("template 'one-pager' already exists")).toHaveCount(0);
});

test("qa-settings-7: a malformed colour is said in words next to its field", async ({ page }) => {
  await login(page);
  await page.goto("/settings/themes/clean-document");
  await page.getByLabel("Text", { exact: true }).fill("red");
  const problem = page.getByTestId("colour-text-problem");
  await expect(problem).toHaveText("Text colour must be a hex colour like #1f2933.");
  await expect(page.getByLabel("Text", { exact: true })).toHaveAttribute("aria-invalid", "true");
  await expect(page.getByText("colors.text")).toHaveCount(0);

  // Low contrast names the colour the same way.
  await page.getByLabel("Text", { exact: true }).fill("#1f2933");
  await page.getByLabel("Muted", { exact: true }).fill("#aaaaaa");
  await expect(page.getByTestId("contrast-errors")).toContainText("Muted colour #aaaaaa on the background #ffffff");
  await expect(page.getByLabel("Muted", { exact: true })).toHaveAttribute("aria-invalid", "true");
});

test("qa-settings-31: a template shows when it is suggested, and its sections by their headings", async ({ page }) => {
  await login(page);
  await page.goto("/settings/templates/one-pager");
  await expect(page.getByTestId("suggest-when")).toContainText(
    'Early idea, small team, single feature, or "should we spend more time on this"',
  );

  await page.goto("/settings/templates/new");
  await expect(page.getByTestId("section-names")).toHaveText("Title, Problem, Solution, Sources and data points");
  await expect(page.getByTestId("brief-sections")).toHaveText("Problem, Solution");
});

test("qa-settings-32: descriptions grow with their text on template and theme pages", async ({ page }) => {
  await login(page);
  for (const path of ["/settings/templates/new", "/settings/themes/new", "/settings/themes/clean-document", "/settings/templates/one-pager"]) {
    await page.goto(path);
    const description = page.getByLabel("Description");
    await expect(description, path).toBeVisible();
    expect(await description.evaluate((el) => el.tagName), path).toBe("TEXTAREA");
    const before = (await description.boundingBox())!.height;
    await description.fill(LONG);
    await expect.poll(async () => (await description.boundingBox())!.height, { message: path }).toBeGreaterThan(before);
    await expectNotClipped(description);
  }
});

test("qa-settings-33: the theme list's preview scrolls in full; fonts are named by family", async ({ page }) => {
  await login(page);
  await page.goto("/settings/themes");
  const preview = page.getByTestId("theme-inspector-preview");
  await expect(preview).toBeVisible();
  // A scrollable frame, tall enough to read, instead of a small box that cut the sample off.
  expect((await preview.boundingBox())!.height).toBeGreaterThanOrEqual(400);
  await expect(page.frameLocator('[data-testid="theme-inspector-preview"]').getByRole("heading", { name: "Example feature PRD" })).toBeVisible();

  await page.goto("/settings/themes/clean-document");
  const hint = page.getByTestId("font-heading-hint");
  await expect(hint).toHaveText("Uses DejaVu Sans; without it, Helvetica, then Arial, then sans-serif.");
  // qa-settings-32: a picker names the font; the CSS stack sits under Advanced.
  await expect(page.getByLabel("Heading font", { exact: true })).toHaveValue("DejaVu Sans");
});

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  async function backLinkTall(page: Page, path: string, name: string) {
    await page.goto(path);
    const back = page.getByRole("link", { name });
    await expect(back, path).toBeVisible();
    expect((await back.boundingBox())!.height, path).toBeGreaterThanOrEqual(44);
  }

  test("qa-settings-42: the back links to Themes and Templates are a thumb tall", async ({ page }) => {
    await login(page);
    await backLinkTall(page, "/settings/templates/new", "← Templates");
    await backLinkTall(page, "/settings/templates/one-pager", "← Templates");
    await backLinkTall(page, "/settings/themes/new", "← Themes");
    await backLinkTall(page, "/settings/themes/clean-document", "← Themes");
  });
});
