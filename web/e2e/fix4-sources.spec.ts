import { expect, test, type Page } from "./test";

import { login } from "./helpers";

/*
 * Fix pass 4 on /sources (qa-work-32, 33, 34, 46), driven through the UI on the mock.
 */

const PHONE = { width: 390, height: 844 };

async function openCoverage(page: Page) {
  await login(page);
  await page.goto("/sources");
  await expect(page.getByRole("region", { name: "Coverage" })).toBeVisible();
  await expect(page.getByTestId("coverage-inspector")).toBeVisible();
}

async function search(page: Page, words: string) {
  await page.getByLabel("Search", { exact: true }).fill(words);
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.getByRole("region", { name: "Results" })).toBeVisible();
}

for (const [width, size] of [["desktop", undefined], ["phone", PHONE]] as const) {
  test(`qa-work-32 (${width}): the title's tip is About Sources; the ranking tip sits by Search`, async ({ page }) => {
    if (size) await page.setViewportSize(size);
    await openCoverage(page);
    const about = page.getByRole("button", { name: "About Sources" }).filter({ visible: true }).first();
    await expect(about).toBeVisible();
    await about.click();
    await expect(page.getByText(/each source.s items, how fresh they are/).filter({ visible: true }).first()).toBeVisible();
    const form = page.getByRole("search");
    await expect(form.getByRole("button", { name: "About Ranking" })).toBeVisible();
    // The page's tip no longer talks about ranking.
    await expect(page.getByRole("button", { name: "About Ranking" }).filter({ visible: true })).toHaveCount(1);
  });
}

test("qa-work-33: a selected result reads in plain words, with how they relate", async ({ page }) => {
  await openCoverage(page);
  await search(page, "pricing");
  const hit = page.getByTestId("hit-inspector");
  await expect(hit).toBeVisible();
  await expect(hit).not.toContainText("Relevance");
  await expect(hit).not.toContainText(/\b0\.\d\d\b/);
  await expect(hit).toContainText(/Confidence\s*(High|Medium|Low)/);
  await expect(hit).toContainText(/Match\s*(Strong|Fair|Weak)/);
  await expect(hit.getByTestId("hit-ranking")).toContainText("ordered by how well their words match your search");
  await expect(hit).toContainText(/(High|Medium|Low)\s*counts \d+%/);
  // The result's confidence chip opens the same words.
  await page.getByTestId("search-hit").first().getByTestId("confidence").locator("summary").click();
  const factors = page.getByRole("table", { name: "Confidence factors" }).first();
  await expect(factors).not.toContainText(/\b0\.\d\d\b/);
  await expect(factors.getByRole("columnheader", { name: "Level" })).toBeVisible();
});

test("qa-work-33 (phone): the result's panel shows no raw scores", async ({ page }) => {
  await page.setViewportSize(PHONE);
  await openCoverage(page);
  await search(page, "pricing");
  await page.getByTestId("search-hit").first().getByRole("button").first().click();
  const hit = page.getByTestId("hit-inspector");
  await expect(hit).toBeVisible();
  await expect(hit).not.toContainText("Relevance");
  await expect(hit).not.toContainText(/\b0\.\d\d\b/);
});

test("qa-work-34: Used in says 'Feature'; the kind's date says it is the newest", async ({ page }) => {
  await openCoverage(page);
  const ins = page.getByTestId("coverage-inspector");
  const used = ins.getByRole("list", { name: "Used in" });
  const dark = used.getByRole("listitem").filter({ hasText: "Dark mode" });
  await expect(dark.getByText("Feature", { exact: true })).toBeVisible();
  await expect(used.getByText("feature", { exact: true })).toHaveCount(0);
  await expect(ins.getByTestId("coverage-kinds")).toContainText(/Messages\s*2\s*· newest [A-Z][a-z]{2} \d{1,2}, \d{4}/);
});

test("qa-work-46: Edit picks says it opens Settings, where picks read by name and long lists collapse", async ({ page }) => {
  await openCoverage(page);
  const edit = page.getByTestId("coverage-inspector").getByRole("link", { name: "Edit picks in Settings" });
  await expect(edit).toBeVisible();
  await edit.click();
  await expect(page).toHaveURL(/\/settings\/sources/);
  const chat = page.getByRole("listitem", { name: "Product chat" });
  await expect(chat.getByTestId("source-picks")).toHaveText("#product, #customer-feedback");
  // The skipped channel reads by its name, never its Slack id.
  await expect(chat.getByRole("list", { name: "Sync notes for Product chat" })).toContainText("#partner-launch");
  await expect(chat).not.toContainText("C0777PARTNER");
  // 120 channels saved before names were kept: counted as unknown (Settings' words, qa-settings-23), not listed by id.
  const legacy = page.getByRole("listitem", { name: "Legacy all-hands chat" });
  await expect(legacy.getByTestId("source-picks")).toHaveText("120 unknown channels");
  await expect(legacy.getByTestId("source-picks")).toHaveAttribute("title", /^No name saved for /);
  await expect(legacy).not.toContainText("LEGACY");
});

test("qa-work-46 (phone): the picks stay one short line", async ({ page }) => {
  await page.setViewportSize(PHONE);
  await login(page);
  await page.goto("/settings/sources");
  const legacy = page.getByRole("listitem", { name: "Legacy all-hands chat" });
  await expect(legacy.getByTestId("source-picks")).toHaveText("120 unknown channels");
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});
