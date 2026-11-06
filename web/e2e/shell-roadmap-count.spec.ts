import { login } from "./helpers";
import { expect, test, type Page } from "./test";

/*
 * shell-roadmap-count: the Simple side menu's Roadmap count is the Roadmap's Needs a decision
 * count, the suggested features it lists included, so the menu, the button and the sum of the
 * tiles are one number. Adding a suggested feature (or rejecting one) moves the menu and the
 * button together, and every other page shows the same number.
 *
 * fails_when: the menu's count leaves out the suggested features, or stays after one is sent
 * or decided, or differs from the button on any page.
 */

test.use({ viewport: { width: 1440, height: 900 } });

const badge = (page: Page) => page.getByTestId("simple-nav-roadmap-count").first();
const tray = (page: Page) => page.getByTestId("decision-tray");
const button = (page: Page) => page.getByTestId("needs-decision");

async function openRoadmap(page: Page) {
  await login(page);
  await page.goto("/simple/roadmap");
  await expect(page.getByTestId("simple-roadmap")).toBeVisible();
  await expect(badge(page)).toBeVisible();
}

/** The button's number ("Needs a decision · 23"). */
async function buttonCount(page: Page): Promise<number> {
  return Number(/·\s*(\d+)/.exec(await button(page).innerText())?.[1] ?? NaN);
}

/** The tiles in the open panel, added up, and the Suggested features tile alone. */
async function tiles(page: Page): Promise<{ sum: number; suggested: number }> {
  await button(page).click();
  const all = tray(page).getByTestId("tray-counter");
  await expect(all).toHaveCount(5);
  let sum = 0;
  for (const b of await all.locator("b").all()) sum += Number(await b.innerText());
  const suggested = Number(await all.filter({ hasText: "Suggested features" }).locator("b").innerText());
  await tray(page).getByRole("button", { name: "Close" }).click();
  await expect(tray(page)).toHaveCount(0);
  return { sum, suggested };
}

async function badgeCount(page: Page): Promise<number> {
  return Number(await badge(page).innerText());
}

/** The menu's number, the button's and the tiles' sum are one. */
async function expectOne(page: Page): Promise<{ n: number; suggested: number }> {
  const { sum, suggested } = await tiles(page);
  await expect(button(page)).toContainText(`· ${sum}`);
  await expect(badge(page)).toHaveText(String(sum));
  expect(await badgeCount(page)).toBe(await buttonCount(page));
  return { n: sum, suggested };
}

test("the side menu's Roadmap count is the Needs a decision count, its suggested features included", async ({ page }) => {
  await openRoadmap(page);
  const { n, suggested } = await expectOne(page);
  expect(suggested).toBeGreaterThan(0);
  // The menu says each part, the suggested features too.
  await expect(badge(page)).toHaveAttribute("title", new RegExp(`^${n} on the roadmap waiting on you: .*, ${suggested} suggested ${suggested === 1 ? "feature" : "features"}, .*`));
});

test("sending a suggested feature moves the menu and the button at once, and every page shows it", async ({ page }) => {
  await openRoadmap(page);
  const before = await expectOne(page);

  // Suggest a feature for a goal, as the owner.
  await page.getByTestId("goal-counter-suggestions").first().click();
  const drawer = page.getByTestId("goal-panel");
  await expect(drawer).toBeVisible();
  if (await drawer.getByTestId("suggest-form-open").count()) await drawer.getByTestId("suggest-form-open").click();
  const form = drawer.getByTestId("suggest-form");
  await form.getByLabel("Feature name").fill("Shared alert notes");
  await form.getByLabel("What it does, and for whom").fill("Leads leave a note on an alert so the next person on call knows what was tried");
  await form.getByRole("button", { name: "Send suggestion" }).click();
  await expect(drawer.locator('[data-testid="person-suggestion"][data-title="Shared alert notes"]')).toBeVisible();

  // The menu moves with no reload, and the button agrees.
  await expect(badge(page)).toHaveText(String(before.n + 1));
  await expect(button(page)).toContainText(`· ${before.n + 1}`);
  await page.keyboard.press("Escape");
  await expect(drawer).toHaveCount(0);
  const added = await expectOne(page);
  expect(added.n).toBe(before.n + 1);
  expect(added.suggested).toBe(before.suggested + 1);

  // Every other page shows the same number.
  for (const path of ["/simple", "/simple/priorities", "/simple/decisions", "/simple/one-pagers"]) {
    await page.goto(path);
    await expect(badge(page)).toHaveText(String(added.n));
  }

  // Deciding it (rejecting it) moves both back.
  await page.goto("/simple/roadmap");
  await expect(page.getByTestId("simple-roadmap")).toBeVisible();
  await button(page).click();
  const mine = tray(page).getByTestId("tray-suggested").getByTestId("person-suggestion").filter({ hasText: "Shared alert notes" });
  await mine.getByRole("button", { name: "Reject" }).click();
  await page.getByRole("dialog", { name: "Reject Shared alert notes" }).getByRole("button", { name: "Reject" }).click();
  await expect(badge(page)).toHaveText(String(before.n));
  await expect(button(page)).toContainText(`· ${before.n}`);
  await page.keyboard.press("Escape");
  const after = await expectOne(page);
  expect(after).toEqual(before);
  await page.goto("/simple");
  await expect(badge(page)).toHaveText(String(before.n));
});
