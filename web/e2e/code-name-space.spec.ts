import { login, openRoadmapItem } from "./helpers";
import { expect, test, type Locator, type Page } from "./test";

/*
 * BR (PR 1517 review): a feature's code and its name read as code, space, name ("F-06 Weekly
 * alert digest"), never "F-06Weekly alert digest", for screen readers, copy and search. Each
 * page reads the text (textContent) around the code chip, on the mock's invented data, at 1440;
 * each check is soft, so a page's later places are read too.
 *
 * Test card: protects = a real space between the code chip and the name on every page that
 * shows both; fails_when = the gap is a CSS margin only; no_claim = features with no code.
 */

test.use({ viewport: { width: 1440, height: 900 } });

const DIGEST = "F-06 Weekly alert digest";

async function tap(l: Locator) {
  await l.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await l.click();
}

/** The words the code chip sits in (its parent's textContent), spaces folded. */
async function reads(chipIn: Locator, code: string): Promise<string> {
  const chip = chipIn.locator(".simple-code", { hasText: code }).first();
  await expect(chip).toBeVisible();
  return chip.locator("xpath=..").evaluate((el) => (el.textContent ?? "").replace(/\s+/g, " ").trim());
}

const panel = (page: Page) => page.getByTestId("floating-card");

test("Decisions' Waiting for you reads 'F-06 Weekly alert digest'", async ({ page }) => {
  await login(page);
  await page.goto("/simple/decisions");
  const row = page.getByTestId("simple-page").getByTestId("waiting-item").and(page.locator('[data-kind="broken_link"]')).filter({ hasText: "Weekly alert digest" });
  expect.soft(await reads(row.first(), "F-06")).toContain(DIGEST);
});

test("Home's broken link and Walk me through it read 'F-06 Weekly alert digest'", async ({ page }) => {
  await login(page);
  await page.goto("/simple");
  const name = page.getByTestId("simple-page").getByRole("button", { name: /Weekly alert digest/ }).filter({ has: page.locator(".simple-code") });
  expect.soft(await reads(name.first(), "F-06")).toBe(DIGEST);
  await tap(page.getByRole("button", { name: "Walk me through it" }));
  const step = page.locator('[data-testid="walk-step"][data-kind="broken_link"]');
  await expect(step).toBeVisible();
  expect.soft(await reads(step.getByTestId("walk-step-title"), "F-06")).toBe(DIGEST);
});

test("the Inbox's Dates rows read 'F-03 Health log'", async ({ page }) => {
  await login(page);
  await page.goto("/simple/inbox");
  const name = page.getByTestId("feature-name").filter({ hasText: "Health log" });
  expect.soft(await reads(name.first(), "F-03")).toBe("F-03 Health log");
});

test("the feature panel's name, a dependency and Part of read code, space, name", async ({ page }) => {
  await login(page);
  await page.goto("/simple/roadmap");
  await expect(page.getByTestId("simple-roadmap")).toBeVisible();
  await openRoadmapItem(page, "alert-digest");
  expect.soft(await reads(panel(page).getByTestId("card-name"), "F-06")).toBe(DIGEST);
  await page.keyboard.press("Escape");
  await expect(panel(page)).toHaveCount(0);

  // A dependency on F-06 (_fields Named).
  await openRoadmapItem(page, "setup-checklist");
  await tap(panel(page).getByRole("button", { name: "Add a dependency" }));
  await panel(page).getByLabel("Feature it depends on").selectOption({ label: DIGEST });
  await tap(panel(page).getByRole("button", { name: "Save" }));
  expect.soft(await reads(panel(page).getByTestId("card-depends-row"), "F-06")).toBe(DIGEST);

  await page.keyboard.press("Escape");
  await expect(panel(page)).toHaveCount(0);

  // Mobile alert push made a part of F-06 (the card's FeatureLink).
  await openRoadmapItem(page, "alert-mobile");
  await tap(panel(page).getByRole("button", { name: "More actions" }));
  await tap(panel(page).getByRole("menuitem", { name: "Part of…" }));
  const form = panel(page).getByTestId("card-parent-edit");
  const option = form.getByLabel("Part of").locator("option").filter({ hasText: "Weekly alert digest" });
  await form.getByLabel("Part of").selectOption({ label: (await option.first().textContent())!.trim() });
  await tap(form.getByRole("button", { name: "Save", exact: true }));
  expect.soft(await reads(panel(page).getByTestId("card-part-of"), "F-06")).toBe(DIGEST);
});

test("the Usage alerts one-pager's Timeline strip reads 'F-06 Weekly alert digest'", async ({ page }) => {
  await login(page);
  await page.goto("/simple/prds/usage-alerts");
  const item = page.getByTestId("plan-strip-item-open").filter({ hasText: "Weekly alert digest" });
  expect.soft(await reads(item.first(), "F-06")).toBe(DIGEST);
});

test("a review's Roadmap step reads 'F-06 Weekly alert digest'", async ({ page }) => {
  await login(page);
  await page.goto("/simple/meetings");
  await expect(page.getByRole("region", { name: "Upcoming" })).toBeVisible();
  await tap(page.getByRole("button", { name: /^Start review/ }).first());
  const s = page.getByRole("dialog", { name: "Start a review" });
  await s.getByLabel("PRD").selectOption({ label: "Usage alerts PRD" });
  await s.getByRole("checkbox", { name: "Theo Brandt" }).check();
  await tap(s.getByRole("button", { name: "Start", exact: true }));
  await expect(page.getByRole("heading", { name: "Review: Usage alerts PRD" })).toBeVisible();
  await tap(page.getByRole("navigation", { name: "Steps" }).getByRole("button", { name: "2 Roadmap" }));
  expect.soft(await reads(page.locator('li[data-item="alert-digest"]'), "F-06")).toBe(DIGEST);
});

test("the Goal map's Add a feature list reads 'F-06 Weekly alert digest'", async ({ page }) => {
  await login(page);
  await page.goto("/simple/goals");
  const gate = page.getByTestId("gm-strip-milestone").first();
  await gate.hover();
  await gate.getByRole("button", { name: /^More for / }).click();
  await page.getByRole("menuitem", { name: "Add a feature" }).click();
  const ed = page.getByTestId("gm-editor");
  await ed.getByLabel("Feature").fill("F-06");
  const pick = ed.getByTestId("gm-attach-list").getByRole("button").filter({ hasText: "Weekly alert digest" });
  expect.soft(await reads(pick.first(), "F-06")).toBe(DIGEST);
});
