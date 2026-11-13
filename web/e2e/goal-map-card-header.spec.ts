import { GM_TRACKS_HEADS5_SCENARIO, GM_TRACKS_HEADS_SCENARIO } from "../lib/api/mock/goal-map-tracks";
import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";
import { expect, test, type Locator, type Page } from "./test";

/*
 * Goal map, each goal card's header row (target, status, (i) and ⋯), driven through the UI against
 * the mock ("goal-map-tracks-heads": invented goals with every status and long targets, and its
 * five-goal twin). At every width each part stays inside its own card, nothing overlaps, the ⋯ stays
 * at the top right off the goal's name line and a click on it opens the goal's menu.
 *
 * protects: a wide pill (Not measured) or a long target (money, a number with a long unit) pushing
 *   the (i) past the card's border and the ⋯ down onto the name line, or off the rightmost card.
 * fails_when: any header part leaves its card, overlaps another or the name, or the ⋯ cannot be clicked;
 *   or a header that fits is not the picked one-row frame (status, target and ⋯ centred on one line,
 *   a 24px row: the name at the card's top + 1px border + 12px padding + 24 + 4px gap).
 * no_claim: the menu's items or what they do (goal-map-tracks-grid covers them).
 */

/** fits: the widths its header is one row at (target, status, (i) and ⋯ side by side). */
type Goal = { name: string; target: string; status: string; fits?: number[] };

const FOUR: Goal[] = [
  { name: "Booked demos per rep per day", target: "40", status: "Met", fits: [1920, 1512] },
  { name: "Recovered card payments per month", target: "$250,000", status: "At risk", fits: [1920] },
  { name: "Activations per team per week", target: "1,200 shops signed up each week", status: "Not measured" },
  { name: "Revenue per day", target: "$12,000", status: "On track", fits: [1920] },
];
const FIVE: Goal[] = [...FOUR, { name: "Referrals from happy customers", target: "1,500 referred teams per month", status: "On track" }];

const WIDTHS = [1920, 1512, 1280, 390];

type Box = { x: number; y: number; width: number; height: number };
const inside = (a: Box, b: Box) => a.x >= b.x - 0.5 && a.y >= b.y - 0.5 && a.x + a.width <= b.x + b.width + 0.5 && a.y + a.height <= b.y + b.height + 0.5;
const meet = (a: Box, b: Box) => a.x < b.x + b.width - 0.5 && b.x < a.x + a.width - 0.5 && a.y < b.y + b.height - 0.5 && b.y < a.y + a.height - 0.5;

/** Its boxes as drawn: one per line a wrapped text takes (its bounding box would also cover the gaps beside it). */
async function boxes(el: Locator): Promise<Box[]> {
  await expect(el).toBeVisible();
  return el.evaluate((e) => [...e.getClientRects()].filter((r) => r.width > 0).map((r) => ({ x: r.x, y: r.y, width: r.width, height: r.height })));
}

/** What a click at its centre lands on is it (nothing drawn over it). */
async function clickable(el: Locator) {
  await el.scrollIntoViewIfNeeded();
  const hit = await el.evaluate((e) => {
    const r = e.getBoundingClientRect();
    const at = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return !!at && e.contains(at);
  });
  expect(hit).toBe(true);
}

async function open(page: Page, scenario: string, width: number) {
  await page.setViewportSize({ width, height: 900 });
  await page.addInitScript(([k, v]) => localStorage.setItem(k, v), [MOCK_SCENARIO_KEY, scenario] as const);
  await login(page);
  await page.goto("/simple/goals");
  await expect(page.getByTestId("gm-grid")).toBeVisible();
}

async function checkHeaders(page: Page, goals: Goal[], width: number) {
  await expect(page.getByTestId("gm-goal")).toHaveCount(goals.length);
  for (const g of goals) {
    const at = `${width}px, ${g.name}`;
    const card = page.getByTestId("gm-goal").filter({ has: page.locator(`[title="${g.name}"]`) });
    const parts = {
      target: card.getByText(g.target, { exact: true }),
      status: card.getByText(g.status, { exact: true }),
      info: card.getByRole("button", { name: `About ${g.name}`, exact: true }),
      more: card.getByRole("button", { name: `More for ${g.name}` }),
    };
    const [c] = await boxes(card);
    const [n] = await boxes(card.locator(`[title="${g.name}"]`));
    const drawn: Record<string, Box[]> = {};
    for (const [k, el] of Object.entries(parts)) drawn[k] = await boxes(el);
    for (const [k, bs] of Object.entries(drawn))
      for (const b of bs) {
        expect(inside(b, c), `${at}: its ${k} inside its card`).toBe(true);
        expect(meet(b, n), `${at}: its ${k} off its name line`).toBe(false);
      }
    const keys = Object.keys(drawn);
    for (const [i, a] of keys.entries())
      for (const b of keys.slice(i + 1)) expect(drawn[a].some((x) => drawn[b].some((y) => meet(x, y))), `${at}: its ${a} and ${b} apart`).toBe(false);
    // The (i) and ⋯ keep the top right: side by side on the target's first line, the ⋯ last.
    const [info] = drawn.info;
    const [more] = drawn.more;
    const [first] = drawn.target;
    expect(Math.abs(info.y + info.height / 2 - (more.y + more.height / 2)), `${at}: (i) beside ⋯`).toBeLessThan(4);
    expect(more.x, `${at}: ⋯ right of (i)`).toBeGreaterThan(info.x);
    expect(more.y, `${at}: ⋯ at the top`).toBeLessThan(first.y + 16);
    if (g.fits?.includes(width)) {
      const mid = (b: Box) => b.y + b.height / 2;
      const [status] = drawn.status;
      expect(Math.abs(mid(status) - mid(first)), `${at}: status centred on the target`).toBeLessThanOrEqual(2);
      expect(Math.abs(mid(status) - mid(more)), `${at}: status centred on the ⋯`).toBeLessThanOrEqual(2);
      expect(Math.abs(n.y - (c.y + 1 + 12 + 24 + 4)), `${at}: one 24px header row above the name`).toBeLessThanOrEqual(1);
    }
    await clickable(parts.info);
    await clickable(parts.more);
    await parts.more.click();
    await expect(page.getByRole("menu").getByRole("menuitem", { name: "Rename" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toHaveCount(0);
  }
}

test.describe("Goal map: goal card header", () => {
  for (const width of WIDTHS) {
    test(`four goals at ${width}px: target, status, (i) and ⋯ stay in their card and the ⋯ opens the menu`, async ({ page }) => {
      await open(page, GM_TRACKS_HEADS_SCENARIO, width);
      await checkHeaders(page, FOUR, width);
    });
    test(`five goals at ${width}px: target, status, (i) and ⋯ stay in their card and the ⋯ opens the menu`, async ({ page }) => {
      await open(page, GM_TRACKS_HEADS5_SCENARIO, width);
      await checkHeaders(page, FIVE, width);
    });
  }
});
