import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";
import { expect, test, type Page } from "./test";

/**
 * walkb-priorities: Simple › Priorities as a production walk found it. On a phone (390 wide)
 * a long milestone name kept each ranked row's details on one line and the page scrolled
 * sideways; a drop landed by how far the row was dragged, not on the row under the pointer;
 * and the details under a title sat left on some rows and right on others. The
 * "simple-priorities-long-milestones" scenario is the default company with long milestone
 * names (lib/api/mock/server.ts).
 */

const PHONE = { width: 390, height: 844 };

async function open(page: Page, scenario: string | null): Promise<void> {
  if (scenario) await page.context().addInitScript(([key, value]) => localStorage.setItem(key, value), [MOCK_SCENARIO_KEY, scenario] as const);
  await login(page, "admin@example.com");
  await page.goto("/simple/priorities");
  await expect(page.getByTestId("prio-row").first()).toBeVisible();
}

const row = (page: Page, i: number) => page.getByTestId("prio-row").nth(i);

/** Drags row `from`'s handle and lets go `dy` px below the top of row `to` (a person's finger lands anywhere on a row). */
async function dropOn(page: Page, from: number, to: number, dy: number): Promise<void> {
  const handle = row(page, from).getByRole("button", { name: /^Drag .* to reorder$/ });
  await handle.evaluate((e) => e.scrollIntoView({ block: "center" }));
  const a = (await handle.boundingBox())!;
  const b = (await row(page, to).boundingBox())!;
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(a.x + a.width / 2, b.y + dy, { steps: 12 });
  await page.mouse.up();
}

async function moveTo(page: Page, from: number, to: number, dy: (h: number) => number): Promise<void> {
  const title = (await row(page, from).getByTestId("prio-title").textContent())!;
  const rank = (await row(page, to).getByTestId("prio-rank").textContent())!.trim();
  const h = (await row(page, to).boundingBox())!.height;
  await dropOn(page, from, to, dy(h));
  const dialog = page.getByRole("dialog", { name: /^Why move / });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Reason").fill("A customer call this week");
  await dialog.getByRole("button", { name: "Move", exact: true }).click();
  await expect(page.getByText(new RegExp(`^Moved ${title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}.* to rank ${rank}$`))).toBeVisible();
}

for (const phone of [false, true]) {
  test.describe(phone ? "phone" : "desktop", () => {
    test.beforeEach(async ({ page }) => {
      if (phone) await page.setViewportSize(PHONE);
    });

    test("a drop lands on the row under the pointer, near its top or its bottom, down or up", async ({ page }) => {
      await open(page, null);
      // Down, the pointer just inside the top of the row two below.
      await moveTo(page, 0, 2, () => 6);
      // Up, the pointer just inside the top of the first row.
      await moveTo(page, 3, 0, () => 6);
      // Down, the pointer just inside the bottom of the row three below.
      await moveTo(page, 1, 4, (h) => h - 6);
    });
  });
}

test("on a phone long milestone names wrap inside each card and the page does not scroll sideways", async ({ page }) => {
  await page.setViewportSize(PHONE);
  await open(page, "simple-priorities-long-milestones");
  const milestone = page.getByText(/^Milestone M1 · /).first();
  await expect(milestone).toContainText("Milestone M1 · Guided setup ready for the first paying teams");
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(PHONE.width);
  for (const r of await page.getByTestId("prio-row").all()) {
    const box = (await r.boundingBox())!;
    expect(box.x + box.width).toBeLessThanOrEqual(PHONE.width);
    // Nothing in the card is clipped: its content fits its own width.
    expect(await r.evaluate((e) => e.scrollWidth <= e.clientWidth)).toBe(true);
  }
  const m = (await milestone.boundingBox())!;
  expect(m.x + m.width).toBeLessThanOrEqual(PHONE.width);
});

/** At a width where some rows' details wrap under the title (a tablet, 810 wide), every row's start at the same left edge. */
test("the details under each title start at the same left edge on every row", async ({ page }) => {
  await page.setViewportSize({ width: 810, height: 1080 });
  await open(page, null);
  const rows = page.getByTestId("prio-row");
  const n = await rows.count();
  const starts: number[] = [];
  for (let i = 0; i < n; i++) {
    const [box, title, details] = await Promise.all([rows.nth(i).boundingBox(), rows.nth(i).getByTestId("prio-title").boundingBox(), rows.nth(i).getByTestId("prio-details").boundingBox()]);
    // Details on a line of their own, under the title.
    if (details!.y >= title!.y + title!.height - 1) starts.push(Math.round(details!.x - box!.x));
  }
  expect(starts.length).toBeGreaterThan(1);
  expect(new Set(starts).size, `the details start at ${starts.join(", ")} px`).toBe(1);
});
