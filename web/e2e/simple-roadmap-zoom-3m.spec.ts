import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { THEME_KEY } from "../lib/theme";
import { login } from "./helpers";
import { expect, test, type Page } from "./test";

/*
 * The owner (Nov 4): "on the roadmap we also need to see the next 3 months not just the next
 * 6. add a button for that". The Timeline's Show control leads with 3 months: the next three
 * months from today, weeks marked; 6 months stays the default. Driven against the mock's
 * invented data, with the mock clock pinned at Oct 22, 2026.
 */

const DESKTOP = { viewport: { width: 1440, height: 900 } };

async function open(page: Page) {
  await page.context().addInitScript(
    ([key, themeKey]) => {
      localStorage.setItem(key, "");
      localStorage.setItem(themeKey, "light");
    },
    [MOCK_SCENARIO_KEY, THEME_KEY] as const,
  );
  await login(page);
  await page.goto("/simple/roadmap");
  await expect(page.getByTestId("zoom-timeline")).toBeVisible();
}

/** The month labels whose left edge sits inside the chart's view, in order. */
async function monthsInView(page: Page) {
  const scroll = page.getByTestId("timeline-scroll");
  const head = (await page.getByTestId("timeline-names-head").boundingBox())!;
  const view = (await scroll.boundingBox())!;
  const out: string[] = [];
  for (const m of await page.getByTestId("timeline-month").all()) {
    const b = await m.boundingBox();
    if (b && b.x >= head.x + head.width - 1 && b.x < view.x + view.width) out.push((await m.innerText()).trim());
  }
  return out;
}

test.describe("desktop", () => {
  test.use(DESKTOP);

  test("3 months leads the Show buttons, 6 months stays the default", async ({ page }) => {
    await open(page);
    const show = page.getByRole("group", { name: "Show" });
    await expect(show.getByRole("button")).toHaveText(["3 months", "6 months", "1 year", "All 3 years"]);
    await expect(page.getByTestId("zoom-6m")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("zoom-3m")).toHaveAttribute("aria-pressed", "false");
  });

  test("3 months shows Oct to Jan with weeks marked, and an item starting soon in sight", async ({ page }) => {
    await open(page);
    // 6 months reaches well past January.
    await expect.poll(() => monthsInView(page)).toContain("Mar");

    await page.getByRole("button", { name: "3 months", exact: true }).click();
    await expect(page.getByTestId("zoom-3m")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("zoom-6m")).toHaveAttribute("aria-pressed", "false");
    // About three months from today: from October (with its year) to January, no further.
    await expect.poll(() => monthsInView(page)).toEqual(["Oct 2026", "Nov", "Dec", "Jan"]);

    // Weeks are marked, each one wide enough to read.
    const weeks = page.getByTestId("timeline-week");
    await expect(weeks.first()).toBeAttached();
    const a = (await weeks.nth(0).boundingBox())!;
    const b = (await weeks.nth(1).boundingBox())!;
    expect(b.x - a.x).toBeGreaterThan(60);

    // Today is in sight, and so is an item that starts within the next three months.
    const view = (await page.getByTestId("timeline-scroll").boundingBox())!;
    const today = (await page.getByTestId("today-line").boundingBox())!;
    expect(today.x).toBeGreaterThan(view.x);
    expect(today.x).toBeLessThan(view.x + view.width);
    const bar = page.locator('[data-testid="timeline-row"][data-item="alert-digest"]').getByTestId("timeline-bar");
    await expect(bar).toBeInViewport();
    const bb = (await bar.boundingBox())!;
    expect(bb.x).toBeGreaterThan(today.x);
    expect(bb.x).toBeLessThan(view.x + view.width);
    await expect(page.getByRole("button", { name: "Back to today" })).toBeVisible();
  });

  test("switching through all four keeps the pick and brings today back in sight", async ({ page }) => {
    await open(page);
    const scroll = page.getByTestId("timeline-scroll");
    for (const z of ["3m", "6m", "1y", "all", "3m"]) {
      await page.getByTestId(`zoom-${z}`).click();
      for (const o of ["3m", "6m", "1y", "all"])
        await expect(page.getByTestId(`zoom-${o}`)).toHaveAttribute("aria-pressed", String(o === z));
      const view = (await scroll.boundingBox())!;
      const today = (await page.getByTestId("today-line").boundingBox())!;
      expect(today.x).toBeGreaterThan(view.x);
      expect(today.x).toBeLessThan(view.x + view.width);
    }
    // Weeks are marked only at 3 months.
    await page.getByTestId("zoom-6m").click();
    await expect(page.getByTestId("timeline-week")).toHaveCount(0);
  });
});
