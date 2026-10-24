import { expect, type Locator, type Page, test } from "./test";

import { NOTION_PAGED_SCENARIO } from "../lib/api/mock/notion";
import { SOURCES_STORAGE_KEY } from "../lib/api/mock/sources";
import { login } from "./helpers";

const id = (n: number) => `a0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const HANDBOOK = id(1);
const RESEARCH_INTERVIEWS = id(9);
const ONBOARDING = id(14);

async function openPicker(page: Page): Promise<{ form: Locator; picker: Locator }> {
  await login(page);
  await page.goto("/settings/sources");
  const form = page.getByRole("form", { name: "Add a source" });
  await form.getByLabel("Kind").selectOption("notion");
  await expect(form.getByLabel("Connection")).toHaveValue(/.+/);
  const picker = form.getByTestId("notion-picker");
  await expect(picker.getByRole("treeitem", { name: "Product handbook" })).toBeVisible();
  return { form, picker };
}

/** A source's config as the API stored it (the mock API runs in the page, so there is no request to watch). */
async function savedConfig(page: Page, name: string): Promise<unknown> {
  return page.evaluate(
    ([key, name]) => JSON.parse(localStorage.getItem(key)!).sources.find((s: { name: string }) => s.name === name)?.config,
    [SOURCES_STORAGE_KEY, name],
  );
}

/** Every visible text node inside `scope` is 13 px or larger. */
async function smallestText(scope: Locator): Promise<number> {
  return scope.evaluate((root) => {
    let min = Infinity;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const el = walker.currentNode.parentElement!;
      if (!walker.currentNode.textContent?.trim() || !el.checkVisibility() || el.closest(".sr-only")) continue;
      min = Math.min(min, parseFloat(getComputedStyle(el).fontSize));
    }
    return min;
  });
}

test("notion picker: tree by parent, pick a parent, search, paste a link, save roots, edit", async ({ page }) => {
  const { form, picker } = await openPicker(page);
  await expect(form.getByText("Only pages you shared with Product Oracle in Notion appear here")).toBeVisible();
  await expect(form.getByRole("link", { name: "Share more in Notion" })).toHaveAttribute("target", "_blank");
  // No ids textarea for Notion.
  await expect(form.locator("textarea")).toHaveCount(0);
  await expect(form.getByRole("button", { name: "Add source" })).toBeDisabled();

  // Top-level shared items first; children sit under their parent with a count.
  const tree = picker.getByRole("tree", { name: "Shared Notion pages" });
  const top = tree.locator(":scope > li");
  await expect(top).toHaveCount(4);
  await expect(top.nth(0)).toHaveAccessibleName("Product handbook");
  await expect(top.nth(3)).toHaveAccessibleName("Team notes");
  const handbook = tree.getByRole("treeitem", { name: "Product handbook" });
  await expect(handbook.getByTestId("notion-page").first()).toContainText("6 sub-pages");
  await expect(tree.getByRole("treeitem", { name: "Roadmap" })).toHaveCount(0);

  // A child picked first is folded into its parent when the parent is picked, with a note;
  // the counter counts the pages that will be read (a pick and its known sub-pages).
  const count = picker.getByTestId("notion-picked-count");
  await handbook.getByRole("button", { name: "Expand Product handbook" }).click();
  await tree.getByRole("checkbox", { name: "Roadmap", exact: true }).check();
  await expect(count).toHaveText("2 pages to read");
  await expect(picker.getByTestId("notion-absorbed")).toHaveCount(0);
  await tree.getByRole("checkbox", { name: "Product handbook", exact: true }).check();
  await expect(count).toHaveText("7 pages to read");
  await expect(picker.getByTestId("notion-absorbed")).toHaveText("Roadmap is now included with Product handbook");
  await expect(picker.getByRole("list", { name: "Picked pages" }).getByRole("listitem")).toHaveText(["Product handbook"]);
  const roadmap = tree.getByRole("checkbox", { name: "Roadmap", exact: true });
  await expect(roadmap).toBeChecked();
  await expect(roadmap).toBeDisabled();
  await expect(tree.getByRole("treeitem", { name: "Roadmap" }).getByText("Included").first()).toBeVisible();
  await tree.getByRole("button", { name: "Expand Feature requests" }).click();
  await expect(tree.getByRole("checkbox", { name: "Dark mode", exact: true })).toBeDisabled();

  // Search: a flat list with each result's parent; a descendant of a pick shows as included.
  await picker.getByLabel("Search Notion pages").fill("interview");
  const hits = picker.getByTestId("notion-page");
  await expect(hits).toHaveCount(3);
  await expect(hits.nth(0)).toContainText("in Research");
  await picker.getByRole("checkbox", { name: /^Customer interviews/ }).check();
  await expect(picker.getByTestId("notion-absorbed")).toHaveCount(0);
  await expect(picker.getByRole("checkbox", { name: /^Interview: Acme/ })).toBeDisabled();
  await expect(count).toHaveText("10 pages to read");
  await picker.getByLabel("Search Notion pages").fill("");
  await expect(top).toHaveCount(4);

  // Paste a link: a page URL or an id.
  const link = picker.getByLabel("Paste a link");
  await link.fill("https://www.notion.so/example/Handbook");
  await picker.getByRole("button", { name: "Add", exact: true }).click();
  await expect(picker.getByRole("alert")).toHaveText("Not a Notion page link or id");
  await link.fill(`https://www.notion.so/example/Engineering-onboarding-${ONBOARDING.replaceAll("-", "")}?pvs=4`);
  await link.press("Enter");
  await expect(count).toHaveText("11 pages to read");
  await expect(picker.getByRole("list", { name: "Picked pages" })).toContainText("Engineering onboarding");

  // Saving writes { roots: [ids] }, the key the connector reads.
  await form.getByLabel("Name").fill("Handbook");
  await form.getByRole("button", { name: "Add source" }).click();
  const row = page.getByRole("listitem", { name: "Handbook" });
  await expect(row.getByTestId("source-picks")).toHaveText("Product handbook, Customer interviews, Engineering onboarding");
  expect(await savedConfig(page, "Handbook")).toEqual({
    roots: [HANDBOOK, RESEARCH_INTERVIEWS, ONBOARDING],
    labels: { [HANDBOOK]: "Product handbook", [RESEARCH_INTERVIEWS]: "Customer interviews", [ONBOARDING]: "Engineering onboarding" },
  });

  // Editing reopens the picker with the picks.
  await row.getByRole("button", { name: "More actions for Handbook" }).click();
  await row.getByRole("menuitem", { name: "Edit pages" }).click();
  const editor = row.getByTestId("notion-picker");
  await expect(editor.getByTestId("notion-picked-count")).toHaveText("11 pages to read");
  await expect(editor.getByRole("checkbox", { name: "Product handbook", exact: true })).toBeChecked();
  await editor.getByRole("button", { name: "Remove Engineering onboarding" }).click();
  await expect(editor.getByRole("checkbox", { name: "Engineering onboarding", exact: true })).not.toBeChecked();
  await row.getByRole("button", { name: "Save pages" }).click();
  await expect(row.getByRole("status")).toHaveText("Pages saved.");
  await expect(row.getByTestId("source-picks")).toHaveText("Product handbook, Customer interviews");
  expect(await savedConfig(page, "Handbook")).toEqual({
    roots: [HANDBOOK, RESEARCH_INTERVIEWS],
    labels: { [HANDBOOK]: "Product handbook", [RESEARCH_INTERVIEWS]: "Customer interviews" },
  });
});

test("notion picker: load more only appends, never moving rows already shown", async ({ page }) => {
  await page.addInitScript((scenario) => localStorage.setItem("po-mock-scenario", scenario), NOTION_PAGED_SCENARIO);
  const { picker } = await openPicker(page);
  const tree = picker.getByRole("tree", { name: "Shared Notion pages" });
  const top = tree.locator(":scope > li");
  const before = ["Product handbook", "Customer interviews", "Pricing survey", "Team notes"];
  await expect(top).toHaveCount(4);
  for (const [i, name] of before.entries()) await expect(top.nth(i)).toHaveAccessibleName(name);
  // A child shown before its parent stays where it was; picking the parent includes it.
  await picker.getByRole("checkbox", { name: "Customer interviews", exact: true }).check();
  await expect(picker.getByTestId("notion-picked-count")).toHaveText("3 pages to read");

  await picker.getByRole("button", { name: "Load more" }).click();
  await expect(picker.getByRole("button", { name: "Load more" })).toHaveCount(0);
  await expect(top).toHaveCount(6);
  for (const [i, name] of [...before, "Engineering onboarding", "Research"].entries()) {
    await expect(top.nth(i)).toHaveAccessibleName(name);
  }
  await picker.getByRole("checkbox", { name: "Research", exact: true }).check();
  await expect(picker.getByTestId("notion-absorbed")).toHaveText("Customer interviews is now included with Research");
  await expect(picker.getByRole("checkbox", { name: "Customer interviews", exact: true })).toBeDisabled();
  await expect(picker.getByRole("checkbox", { name: "Pricing survey", exact: true })).toBeDisabled();
  await expect(picker.getByTestId("notion-picked-count")).toHaveText("5 pages to read");
  await expect(top.nth(1)).toHaveAccessibleName("Customer interviews");
});

test("notion picker: loads icons only over https from Notion's hosts, without a referrer", async ({ page }) => {
  const fetched: string[] = [];
  await page.route("https://www.notion.so/icons/**", (route) => {
    fetched.push(route.request().url());
    return route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" rx="3" fill="#6b7a90"/></svg>',
    });
  });
  await page.route("**/tracker.example.com/**", (route) => {
    fetched.push(route.request().url());
    return route.abort();
  });
  const { picker } = await openPicker(page);
  const tree = picker.getByRole("tree", { name: "Shared Notion pages" });
  await tree.getByRole("button", { name: "Expand Research" }).click();
  await tree.getByRole("button", { name: "Expand Customer interviews" }).click();

  const icon = (title: string) => tree.getByRole("treeitem", { name: title }).getByTestId("notion-page").first().locator("img");
  // A Notion-hosted icon loads, with no referrer.
  await expect(icon("Pricing survey")).toHaveAttribute("src", "https://www.notion.so/icons/chart-line_gray.svg");
  await expect(icon("Pricing survey")).toHaveAttribute("referrerpolicy", "no-referrer");
  // A tracking pixel and a plain-http icon get the default glyph and are never requested.
  await expect(tree.getByRole("treeitem", { name: "Interview: Globex" })).toBeVisible();
  await expect(icon("Interview: Globex")).toHaveCount(0);
  await expect(icon("Interview: Acme")).toHaveCount(0);
  await expect(tree.getByRole("treeitem", { name: "Interview: Globex" })).not.toContainText("tracker.example.com");
  await expect.poll(() => fetched).toEqual(["https://www.notion.so/icons/chart-line_gray.svg"]);
});

test("notion picker: a source whose Notion connection is gone asks to reconnect, with nothing to edit", async ({
  page,
}) => {
  const { form, picker } = await openPicker(page);
  await picker.getByRole("checkbox", { name: "Product handbook", exact: true }).check();
  await form.getByLabel("Name").fill("Handbook");
  await form.getByRole("button", { name: "Add source" }).click();
  await expect(page.getByRole("listitem", { name: "Handbook" }).getByTestId("source-picks")).toHaveText("Product handbook");

  // The connection is removed (sources keep a null connection_id).
  await page.evaluate((key) => {
    const db = JSON.parse(localStorage.getItem(key)!);
    for (const s of db.sources) if (s.name === "Handbook") s.connection_id = null;
    localStorage.setItem(key, JSON.stringify(db));
  }, SOURCES_STORAGE_KEY);
  await page.reload();
  const row = page.getByRole("listitem", { name: "Handbook" });
  await row.getByRole("button", { name: "More actions for Handbook" }).click();
  await row.getByRole("menuitem", { name: "Edit pages" }).click();
  const reconnect = row.getByTestId("notion-reconnect");
  await expect(reconnect).toContainText("Reconnect Notion to change pages.");
  await expect(reconnect).toContainText("It keeps its 1 picked page; changing them needs a Notion connection.");
  await expect(reconnect.getByRole("link", { name: "Go to Connections" })).toHaveAttribute("href", "/settings/connections");
  await expect(row.locator("textarea, input")).toHaveCount(0);
  await expect(row.getByRole("button", { name: "Save pages" })).toHaveCount(0);
  expect(await smallestText(reconnect)).toBeGreaterThanOrEqual(13);
  expect(await savedConfig(page, "Handbook")).toEqual({ roots: [HANDBOOK], labels: { [HANDBOOK]: "Product handbook" } });

  const shots = process.env.SWARM_ARTIFACTS_DIR ? `${process.env.SWARM_ARTIFACTS_DIR}/screens/after` : null;
  if (shots) {
    await page.setViewportSize({ width: 1440, height: 900 });
    await reconnect.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${shots}/notion-reconnect-1440-light.png` });
    await page.emulateMedia({ colorScheme: "dark" });
    await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
    await page.screenshot({ path: `${shots}/notion-reconnect-1440-dark.png` });
    await page.emulateMedia({ colorScheme: "light" });
    await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));
    await page.setViewportSize({ width: 390, height: 844 });
    await reconnect.evaluate((el) => window.scrollBy(0, el.getBoundingClientRect().top - 120));
    await page.screenshot({ path: `${shots}/notion-reconnect-390-light.png` });
  }
});

test("notion picker: a rate limit shows a retry message", async ({ page }) => {
  const { picker } = await openPicker(page);
  await picker.getByLabel("Search Notion pages").fill("slow");
  await expect(picker.getByRole("alert")).toContainText("Notion is limiting requests right now; try again in 20 seconds");
  await expect(picker.getByRole("button", { name: "Retry" })).toBeVisible();
});

test("notion picker: readable text, light and dark, and a stacked phone layout", async ({ page }) => {
  const shots = process.env.SWARM_ARTIFACTS_DIR ? `${process.env.SWARM_ARTIFACTS_DIR}/screens/after` : null;
  await page.setViewportSize({ width: 1440, height: 900 });
  const { picker } = await openPicker(page);
  const handbook = picker.getByRole("treeitem", { name: "Product handbook" });
  await handbook.getByRole("button", { name: "Expand Product handbook" }).click();
  await picker.getByRole("checkbox", { name: "Product handbook", exact: true }).check();
  await picker.getByRole("checkbox", { name: "Research", exact: true }).check();
  expect(await smallestText(picker)).toBeGreaterThanOrEqual(13);
  await picker.getByLabel("Paste a link").scrollIntoViewIfNeeded();
  if (shots) await page.screenshot({ path: `${shots}/notion-picker-1440-light.png` });

  await page.emulateMedia({ colorScheme: "dark" });
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
  if (shots) await page.screenshot({ path: `${shots}/notion-picker-1440-dark.png` });

  await page.emulateMedia({ colorScheme: "light" });
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));
  await page.setViewportSize({ width: 390, height: 844 });
  await picker.scrollIntoViewIfNeeded();
  expect(await smallestText(picker)).toBeGreaterThanOrEqual(13);
  // Nothing overflows the phone's width; the paste-a-link row stacks.
  const box = (await picker.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  const label = (await picker.getByText("Paste a link", { exact: true }).boundingBox())!;
  const input = (await picker.getByLabel("Paste a link").boundingBox())!;
  expect(input.y).toBeGreaterThan(label.y + label.height - 1);
  // Clear of the phone's top bar and bottom tab bar.
  await picker.evaluate((el) => window.scrollBy(0, el.getBoundingClientRect().top - 90));
  if (shots) await page.screenshot({ path: `${shots}/notion-picker-390-light.png` });
});
