import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";
import { expect, test, type Locator, type Page } from "./test";

/*
 * Two milestones on one day share one diamond with their count on the axis. The count read
 * "2 on Nov 20" in a dark chip about 80 px wide right of the diamond: at 3 months and 6 months
 * it covered the next milestone's diamond a week later, so a person could neither see nor click
 * it. Now it is a small badge with the count alone on the diamond's top-right corner, its names
 * in its tooltip, clear of every other diamond. Mock scenario "simple-prd-milestones" (invented
 * goals and people): its own "M1 First alert within a day" is moved to Nov 20 and a second one
 * added that day, a week before the PRD's hollow "M1 Rules in beta" on Nov 27.
 */

test.use({ viewport: { width: 1440, height: 900 } });

const card = (page: Page) => page.getByTestId("ms-card");

async function twoOnNov20(page: Page) {
  await page.context().addInitScript(([key, value]) => localStorage.setItem(key, value), [MOCK_SCENARIO_KEY, "simple-prd-milestones"] as const);
  await login(page);
  await page.goto("/simple/roadmap");
  await expect(page.getByTestId("simple-roadmap")).toBeVisible();
  await page.getByTestId("ms-label").filter({ hasText: "M1 First alert within a day" }).click();
  await card(page).getByLabel("Date").fill("2026-11-20");
  await card(page).getByTestId("ms-save").click();
  await expect(card(page)).toBeHidden();
  // A click on the time axis, on a part of it in sight, opens a new one.
  const axis = page.getByTestId("ms-axis").first();
  await axis.evaluate((el) => window.scrollBy(0, el.getBoundingClientRect().top - 300));
  const box = (await axis.boundingBox())!;
  const seen = await axis.evaluate((el) => {
    let sc = el.parentElement;
    while (sc && !/auto|scroll/.test(getComputedStyle(sc).overflowX)) sc = sc.parentElement;
    const r = (sc ?? document.body).getBoundingClientRect();
    return { left: Math.max(r.left, el.getBoundingClientRect().left), right: r.right };
  });
  // About two weeks after today (it starts 60 px in), clear of every diamond and the today tag.
  const at = { x: seen.left + 150, y: box.y + box.height / 2 };
  await page.mouse.move(at.x, at.y);
  await page.mouse.click(at.x, at.y);
  await card(page).getByLabel("Name").fill("Setup checks for new teams");
  await card(page).getByLabel("Date").fill("2026-11-20");
  await card(page).getByLabel("Goal").selectOption({ index: 1 });
  await card(page).getByTestId("ms-save").click();
  await expect(card(page)).toBeHidden();
}

const overlaps = (a: { x: number; y: number; width: number; height: number }, b: typeof a) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

async function boxOf(l: Locator) {
  await expect(l).toBeVisible();
  return (await l.boundingBox())!;
}

for (const [zoom, name] of [
  ["3m", "3 months"],
  ["6m", "6 months"],
] as const) {
  test(`${name}: the same-day count never covers the next diamond, which opens on a click`, async ({ page }) => {
    await twoOnNov20(page);
    await page.getByTestId(`zoom-${zoom}`).click();
    const badge = page.getByTestId("ms-same-day");
    const next = page.locator('[data-testid="ms-prd-diamond"][title^="M1 Rules in beta"]');
    const b = await boxOf(badge);
    const d = await boxOf(next);
    // A week after it, to the right.
    expect(d.x).toBeGreaterThan(b.x);
    expect(overlaps(b, d)).toBe(false);
    // The badge sits on its own diamond's corner.
    const own = await boxOf(page.locator('[data-testid="ms-diamond"][title$="Nov 20, 2026"]'));
    expect(b.x).toBeGreaterThan(own.x);
    expect(b.x).toBeLessThan(own.x + own.width);
    // Its count alone in sight (a screen reader also hears the day), the names of both in its tooltip.
    expect(await badge.evaluate((e) => e.firstChild?.textContent)).toBe("2");
    expect(b.width).toBeLessThanOrEqual(20);
    await expect(badge).toHaveAttribute("title", /^2 milestones on Nov 20: .*M1 First alert within a day.*Setup checks for new teams|^2 milestones on Nov 20: .*Setup checks for new teams.*M1 First alert within a day/);
    await next.click();
    await expect(page.getByTestId("ms-prd-card")).toBeVisible();
    await expect(page.getByTestId("ms-prd-card")).toContainText("From the PRD Usage alerts");
  });
}
