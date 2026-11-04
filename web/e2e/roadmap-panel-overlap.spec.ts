import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { THEME_KEY } from "../lib/theme";
import { login } from "./helpers";
import { expect, test, type Locator, type Page } from "./test";

/*
 * roadmap-panel-overlap: on Simple > Roadmap an open item's panel always sits over the chart.
 * The owner's Nov 3 screenshot: with an item's panel open (Outcome, Owner, Dates, Depends on,
 * its warnings, Why and the "Talk about this item" column) the Timeline's bars, their date
 * words and the today line painted on top of it. Here, in each view (Timeline, Gantt,
 * Now/Next/Later, Waterfall), desktop and phone, light and dark, the panel opens over a busy
 * chart and, at its title, its Dates row, its warnings and the talk's message box, the
 * element on top (elementFromPoint) is the panel's own.
 */

const DESKTOP = { viewport: { width: 1440, height: 900 } };
const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true };
const VIEWS = ["timeline", "gantt", "board", "waterfall"] as const;
type View = (typeof VIEWS)[number];

async function open(page: Page, scheme: "light" | "dark") {
  await page.context().addInitScript(
    ([key, value, themeKey, theme]) => {
      localStorage.setItem(key, value);
      localStorage.setItem(themeKey, theme);
    },
    [MOCK_SCENARIO_KEY, "default", THEME_KEY, scheme] as const,
  );
  await page.emulateMedia({ colorScheme: scheme });
  await login(page);
  await page.goto("/simple/roadmap");
  await expect(page.getByTestId("simple-chart")).toBeVisible();
}

/** An item with a broken link, so its panel carries warnings: the first in the Timeline's list of them. */
async function flagged(page: Page): Promise<string> {
  const row = page.getByTestId("conflict").first();
  await expect(row).toBeVisible();
  return (await row.getAttribute("data-item"))!;
}

function itemIn(page: Page, view: View, key: string): Locator {
  if (view === "timeline") return page.locator(`[data-item="${key}"]`).getByTestId("timeline-bar").first();
  if (view === "board") return page.locator(`[data-testid="board-card"][data-item="${key}"]`);
  return page.locator(`[data-testid="bar"][data-item="${key}"]`).first();
}

/** True when the element on top at the middle of `part` belongs to the open item's panel. */
async function onTop(card: Locator, part: Locator): Promise<boolean> {
  await part.evaluate((el) => el.scrollIntoView({ block: "nearest" }));
  return part.evaluate((el) => {
    const panel = el.closest('[data-testid="floating-card"]')!;
    const r = el.getBoundingClientRect();
    const xs = [r.left + 4, r.left + r.width / 2, r.right - 4];
    const y = r.top + Math.min(r.height / 2, 10);
    return xs.every((x) => {
      const hit = document.elementFromPoint(x, y);
      return !!hit && panel.contains(hit);
    });
  });
}

async function check(page: Page, view: View, phone: boolean) {
  await page.getByTestId(`format-${view}`).click();
  await expect(page.getByTestId(view === "board" ? "board" : "simple-chart").first()).toBeVisible();
  // Back on the Timeline, the busy chart's broken links name the item; in the others, it is the same item.
  const key = await (async () => {
    if (view !== "timeline") await page.getByTestId("format-timeline").click();
    const k = await flagged(page);
    if (view !== "timeline") await page.getByTestId(`format-${view}`).click();
    return k;
  })();
  const target = itemIn(page, view, key);
  await target.evaluate((el) => el.scrollIntoView({ block: "center", inline: "center" }));
  await target.click();
  const card = page.getByTestId("floating-card");
  await expect(card).toBeVisible();
  const parts: [string, Locator][] = [
    ["title", card.getByRole("heading", { level: 2 })],
    ["Dates row", card.getByTestId("card-dates")],
    ["warnings", card.getByTestId("card-flags")],
  ];
  for (const [name, part] of parts) {
    await expect(part, `${view}: the panel shows its ${name}`).toBeVisible();
    expect(await onTop(card, part), `${view}: the panel's ${name} is on top of the chart`).toBe(true);
  }
  if (phone) await card.getByRole("tab", { name: "Talk to Oracle" }).click();
  else await card.getByRole("button", { name: "Talk to Oracle" }).click();
  await expect(card).toHaveAttribute("data-talk", "true");
  const box = card.getByTestId("item-talk").getByRole("textbox", { name: "Message Oracle" });
  await expect(box).toBeVisible();
  if (!phone) {
    for (const [name, part] of parts) expect(await onTop(card, part), `${view}, talk open: the panel's ${name} is on top`).toBe(true);
  }
  expect(await onTop(card, box), `${view}: the talk's message box is on top of the chart`).toBe(true);
  await page.keyboard.press("Escape");
  await expect(card).toBeHidden();
}

for (const [device, use, phone] of [
  ["desktop", DESKTOP, false],
  ["phone", PHONE, true],
] as const) {
  test.describe(device, () => {
    test.use(use);
    for (const scheme of ["light", "dark"] as const) {
      test(`an open item's panel sits over the chart in every view (${scheme})`, async ({ page }) => {
        await open(page, scheme);
        for (const view of VIEWS) await check(page, view, phone);
      });
    }
  });
}
