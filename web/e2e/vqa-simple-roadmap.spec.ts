import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { THEME_KEY } from "../lib/theme";
import { login } from "./helpers";
import { expect, test, type Page } from "./test";

/*
 * Visual QA of the Simple roadmap as picked (QR1 A, "Zoom around today"): the Timeline's
 * month labels never peek out from under the names column, as the picked frames show.
 */

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

/** Each month label the person can see a piece of, with how much of it the names column hides. */
const labels = (page: Page) =>
  page.getByTestId("timeline-scroll").evaluate((sc) => {
    const edge =
      sc.getBoundingClientRect().left +
      (sc.querySelector<HTMLElement>("[data-testid='timeline-names-head']")
        ?.offsetWidth ?? 0);
    return Array.from(
      sc.querySelectorAll<HTMLElement>("[data-testid='timeline-month']"),
    )
      .map((s) => ({
        text: s.textContent ?? "",
        left: s.getBoundingClientRect().left,
        right: s.getBoundingClientRect().right,
        edge,
      }))
      .filter((l) => l.right > l.edge);
  });

for (const width of [1440, 1512]) {
  test(`QR1 A at ${width}: no month label is cut off by the names column, at rest or scrolled`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await open(page);
    const timeline = page.getByTestId("zoom-timeline");
    await expect(
      timeline.getByTestId("timeline-month").filter({ hasText: "Nov 2026" }),
    ).toBeVisible();
    for (const l of await labels(page))
      expect(
        l.left,
        `${l.text} starts under the names column`,
      ).toBeGreaterThanOrEqual(l.edge - 1);
    // Scrolled sideways into the year after: the first month in sight still shows whole, with its year.
    await page
      .getByTestId("timeline-scroll")
      .evaluate((el) => (el.scrollLeft += 900));
    await expect
      .poll(async () => (await labels(page))[0]?.text)
      .toMatch(/\d{4}$/);
    for (const l of await labels(page))
      expect(
        l.left,
        `${l.text} starts under the names column`,
      ).toBeGreaterThanOrEqual(l.edge - 1);
    await page.getByRole("button", { name: "Back to today" }).click();
    await expect
      .poll(async () => (await labels(page)).every((l) => l.left >= l.edge - 1))
      .toBe(true);
  });
}

test("QR1 A: scrolled just past a month's start, that month keeps its label at the view's left", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page);
  const scroll = page.getByTestId("timeline-scroll");
  // Scroll so the second month in sight starts 12 px left of the view.
  const target = await scroll.evaluate((sc) => {
    const second = sc.querySelectorAll<HTMLElement>(
      "[data-testid='timeline-month']",
    )[1];
    sc.scrollLeft = parseFloat(second.style.left) - 4 + 12;
    return (second.textContent ?? "").slice(0, 3);
  });
  await expect
    .poll(async () => (await labels(page))[0]?.text)
    .toMatch(new RegExp(`^${target} \\d{4}$`));
  const shown = await labels(page);
  expect(shown[0].left).toBeGreaterThanOrEqual(shown[0].edge - 1);
  expect(shown[0].left - shown[0].edge).toBeLessThan(20);
  // The pinned label never runs into the next month's.
  for (let i = 1; i < shown.length; i++)
    expect(shown[i].left).toBeGreaterThan(shown[i - 1].right);
});
