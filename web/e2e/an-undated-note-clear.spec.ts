import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { THEME_KEY } from "../lib/theme";
import { ADMIN, login } from "./helpers";
import { expect, test, type Page } from "./test";

/*
 * Train AN's merge of main, fix 1 (review minor 8). Card undated-note-clear: protects = with no
 * dated plan (the mock's invented "goal-buckets-undated" scenario), on a phone, a move whose goal
 * title would sit under the fixed note scrolls it clear by a little, as the dated plan's buckets
 * do; fails_when = a goal title is left under the note.
 */

const PHONE = { width: 390, height: 844 };

const bucket = (page: Page, goal: string) =>
  page.locator('[data-testid="goal-bucket"]').filter({ has: page.getByRole("heading", { name: goal, exact: true }) });
const note = (page: Page) => page.getByTestId("bucket-note");
const scrollY = (page: Page) => page.evaluate(() => Math.round(window.scrollY));

const titlesUnder = async (page: Page) => {
  const n = (await note(page).boundingBox())!;
  const under: string[] = [];
  for (const title of await page.locator('[data-testid="goal-bucket"] h3').all()) {
    const t = await title.boundingBox();
    if (t && t.y < n.y + n.height && t.y + t.height > n.y) under.push((await title.textContent()) ?? "");
  }
  return under;
};

/** Wheels the page (as a person) until `target`'s top is at about `y` on screen. */
async function wheelTo(page: Page, target: ReturnType<Page["locator"]>, y: number) {
  await page.mouse.move(200, 300);
  for (let i = 0; i < 4; i++) {
    const d = (await target.boundingBox())!.y - y;
    if (Math.abs(d) < 2) return;
    const before = await scrollY(page);
    await page.mouse.wheel(0, d);
    await expect.poll(() => scrollY(page)).not.toBe(before);
  }
}

test("with no dated plan, a move whose goal title would sit under the note scrolls it clear by a little", async ({ page }) => {
  await page.setViewportSize(PHONE);
  await page.context().addInitScript(
    ([key, value, themeKey]) => {
      localStorage.setItem(key, value);
      localStorage.setItem(themeKey, "light");
    },
    [MOCK_SCENARIO_KEY, "goal-buckets-undated", THEME_KEY] as const,
  );
  await login(page, ADMIN.email);
  await page.goto("/simple/priorities?tab=buckets");
  await expect(page.getByTestId("buckets-intro")).toBeVisible();
  const grip = bucket(page, "Reliability").locator('[data-code="F-03"]').getByTestId("feature-grip");
  await grip.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("bucket-live")).toContainText("Picked up");
  await page.keyboard.press("ArrowDown");
  await expect(bucket(page, "Growth")).toHaveAttribute("data-drop", "");
  // Bring Growth's title down to where the note will show, then drop.
  const title = bucket(page, "Growth").locator("h3");
  await wheelTo(page, title, PHONE.height - 110);
  const y = await scrollY(page);
  await page.keyboard.press("Enter");
  await expect(note(page)).toContainText("to Growth");
  expect(await note(page).evaluate((e) => getComputedStyle(e).position)).toBe("fixed");
  await expect.poll(() => titlesUnder(page)).toEqual([]);
  // A nudge, not a jump: the title is still on screen above the note.
  await expect(title).toBeInViewport();
  const moved = (await scrollY(page)) - y;
  expect(moved).toBeGreaterThanOrEqual(0);
  expect(moved).toBeLessThan(200);
});
