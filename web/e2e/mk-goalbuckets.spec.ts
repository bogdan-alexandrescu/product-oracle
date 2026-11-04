// MOCK-HOOK: the whole file. mk-goalbuckets review 2: the goal-bucket mock-ups on a phone keep the
// lifted card inside the screen, the note with Undo above the tab bar, and every milestone chip names
// its milestone; in dark the resting grips and unpicked "most" radios are quieter than the picked one.
import { login } from "./helpers";
import { expect, test, type Page } from "./test";

async function open(page: Page, q: string, phone = true, signIn = true) {
  await page.setViewportSize(phone ? { width: 390, height: 844 } : { width: 1440, height: 900 });
  if (signIn) await login(page);
  await page.goto(`/simple/priorities?tab=buckets&${q}`);
  await expect(page.locator("section[data-mockup]")).toBeVisible();
  await page.evaluate(() => (document.documentElement.dataset.theme = "dark"));
}

test("the lifted card stays inside a 390 px phone, below the goal's measure line", async ({ page }) => {
  await open(page, "gb3=a&phase=mid");
  const card = page.locator('li[data-testid=plan-goal][data-goal="Lower support load"]');
  const ghost = card.getByTestId("drag-ghost");
  await ghost.scrollIntoViewIfNeeded();
  const g = (await ghost.boundingBox())!;
  expect(g.x).toBeGreaterThanOrEqual(0);
  expect(g.x + g.width).toBeLessThanOrEqual(390);
  await expect(ghost).toContainText("3 wk");
  const measure = (await card.getByText(/Support chats per 100 riders/).boundingBox())!;
  expect(g.y).toBeGreaterThanOrEqual(measure.y + measure.height);
});

test("on a phone the note with Undo sits above the tab bar, and the last bucket clears it", async ({ page }) => {
  await open(page, "gb1=d&phase=result");
  const note = page.locator("[data-mk-toast]");
  await page.getByTestId("add-goal").scrollIntoViewIfNeeded();
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await expect(note.getByRole("button", { name: "Undo" })).toBeInViewport();
  const n = (await note.boundingBox())!;
  const tabs = (await page.getByRole("navigation", { name: "Simple" }).last().boundingBox())!;
  expect(n.y + n.height).toBeLessThanOrEqual(tabs.y);
  const add = (await page.getByTestId("add-goal").boundingBox())!;
  expect(add.y + add.height).toBeLessThanOrEqual(n.y);
});

test("every milestone chip names its milestone", async ({ page }) => {
  await open(page, "gb3=b&phase=rest", false);
  const chips = page.getByTestId("plan-chip");
  expect(await chips.count()).toBeGreaterThan(0);
  for (const t of await chips.allInnerTexts()) expect(t).toMatch(/^M\d\s+(Ride ready|Fleet care|Winter launch)$/);
});

test("in dark, resting grips and unpicked radios are quieter than the picked one", async ({ page }) => {
  const lum = (c: string) => {
    const [r, g, b] = c.match(/\d+(\.\d+)?/g)!.map(Number);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  await open(page, "gb3=a&phase=rest");
  const grip = await page.locator('[title="Drag to another goal"]').first().evaluate((e) => getComputedStyle(e).color);
  const text = await page.getByTestId("plan-feature-name").first().evaluate((e) => getComputedStyle(e).color);
  expect(lum(grip)).toBeLessThan(lum(text));
  await open(page, "gb3=d&phase=open", true, false);
  const radios = page.getByRole("dialog").locator("input[type=radio]");
  const picked = await radios.and(page.locator(":checked")).first().evaluate((e) => getComputedStyle(e).borderTopColor);
  const unpicked = await radios.and(page.locator(":not(:checked)")).first().evaluate((e) => getComputedStyle(e).borderTopColor);
  expect(picked).not.toEqual(unpicked);
  expect(lum(unpicked)).toBeLessThan(lum(await page.getByRole("dialog").evaluate((e) => getComputedStyle(e).color)));
});
