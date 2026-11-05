import { expect, test, type Locator, type Page } from "./test";

import { MOCK_FAIL_ONCE_KEY, MOCK_ROLE_KEY, MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";

/**
 * build-goal-order-control: Simple Home's goal row has Change order for owners and approvers.
 * The cards turn into a numbered row with a grip to drag and left / right arrows; Save order
 * keeps it on every page (a toast with Undo), Cancel leaves it. A small grey number, 1 to n,
 * sits before every goal's name on Home, the Roadmap's goal cards and lane headers, and
 * Baseline's goal table. The "simple-home" mock scenario's invented goals.
 */

async function start(page: Page, role?: "viewer") {
  await page.context().addInitScript(([key]) => localStorage.setItem(key, "simple-home"), [MOCK_SCENARIO_KEY]);
  if (role) await page.context().addInitScript(([key, r]) => localStorage.setItem(key, r), [MOCK_ROLE_KEY, role] as const);
  await login(page);
  await page.goto("/simple");
  await expect(page.getByTestId("home-goal").first()).toBeVisible();
}

/** The goal names in `list`, each without its number. */
async function names(list: Locator): Promise<string[]> {
  return (await list.allInnerTexts()).map((t) => t.replace(/^\s*\d+\s*/, "").trim());
}

/** Each card's number and name in `cards`, as "1 Grow retention". */
async function numbered(cards: Locator, name: string): Promise<string[]> {
  const out: string[] = [];
  for (const card of await cards.all()) out.push(`${await card.getByTestId("order-num").first().innerText()} ${(await card.getByTestId(name).first().innerText()).replace(/^\s*\d+\s*/, "").trim()}`);
  return out;
}

const homeNames = (page: Page) => names(page.getByTestId("home-goal-link"));
const editNames = (page: Page) => names(page.getByTestId("goal-order-card").locator("b"));
const thirdFirst = (n: string[]) => [n[2], n[0], n[1], ...n.slice(3)];
const asNumbered = (n: string[]) => n.map((x, i) => `${i + 1} ${x}`);

async function saveOrder(page: Page) {
  await page.getByTestId("goal-order-save").click();
  await expect(page.getByText("Goal order saved. Every page shows the new order.")).toBeVisible();
  await expect(page.getByTestId("goal-order-edit")).toHaveCount(0);
}

/** Roadmap's goal cards and Baseline's goal rows carry the numbers in `want`'s order. */
async function everyPageShows(page: Page, want: string[], phone: boolean) {
  await page.goto("/simple/roadmap");
  const cards = page.getByTestId("goal-counters").getByTestId("goal-counter");
  await expect(cards.first()).toBeVisible();
  const onCards = (await names(cards.locator("p:first-child"))).filter((n) => want.includes(n));
  expect(onCards).toEqual(want.filter((n) => onCards.includes(n)));
  for (const card of await cards.all()) {
    const name = (await names(card.locator("p:first-child")))[0];
    if (want.includes(name)) await expect(card.getByTestId("order-num")).toHaveText(String(want.indexOf(name) + 1));
  }
  // The lane headers lead with the same number: the Timeline's (the Roadmap's first view; a
  // phone's Timeline is a list with no lanes), then the Gantt's.
  if (!phone) {
    const lane = page.getByTestId("timeline-lane").filter({ hasText: want[0] }).first();
    await expect(lane).toBeVisible();
    await expect(lane.getByTestId("order-num")).toHaveText("1");
  }
  await page.getByRole("button", { name: "Gantt", exact: true }).click();
  const group = page.getByTestId("chart-group").filter({ hasText: want[0] }).first();
  await expect(group).toBeVisible();
  await expect(group.getByTestId("order-num")).toHaveText("1");

  await page.goto("/baseline");
  await expect(page.getByRole("heading", { level: 1, name: "Desired state" })).toBeVisible();
  for (const [i, name] of want.entries()) {
    const row = page.locator('[data-testid^="goal-"]').filter({ has: page.getByRole("button", { name, exact: true }) }).first();
    await expect(row.getByTestId("order-num")).toHaveText(String(i + 1));
  }
}

for (const [label, viewport] of [
  ["desktop", { width: 1440, height: 900 }],
  ["phone", { width: 390, height: 844 }],
] as const) {
  test.describe(`goal order control (${label})`, () => {
    test.use({ viewport });

    test("an owner drags the third goal to first, saves, and Undo puts it back", async ({ page }) => {
      test.setTimeout(120_000);
      await start(page);
      const before = await homeNames(page);
      expect(before.length).toBeGreaterThanOrEqual(3);
      expect(await numbered(page.getByTestId("home-goal"), "home-goal-link")).toEqual(asNumbered(before));

      await page.getByRole("button", { name: "Change order" }).click();
      await expect(page.getByText("Drag a goal, or use its arrows. The order shows on every page once saved.")).toBeVisible();
      expect(await editNames(page)).toEqual(before);
      const cards = page.getByTestId("goal-order-card");
      // On a phone the cards stack: the row's top in view, so the first and third cards both show.
      await page.getByTestId("goal-order-edit").evaluate((e) => e.scrollIntoView({ block: "start" }));
      const from = (await cards.nth(2).getByTestId("goal-order-grip").boundingBox())!;
      await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
      await page.mouse.down();
      const to = (await cards.nth(0).boundingBox())!;
      await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 12 });
      await expect(cards.nth(0).locator("b")).toHaveText(before[2]);
      await page.mouse.up();
      expect(await editNames(page)).toEqual(thirdFirst(before));
      await saveOrder(page);
      await expect.poll(() => homeNames(page)).toEqual(thirdFirst(before));
      expect(await numbered(page.getByTestId("home-goal"), "home-goal-link")).toEqual(asNumbered(thirdFirst(before)));

      await page.getByRole("button", { name: "Undo" }).click();
      await expect.poll(() => homeNames(page)).toEqual(before);
      await page.reload();
      await expect.poll(() => homeNames(page)).toEqual(before);
    });

    test("an owner moves the third goal to first with its arrows, and every page shows the new order", async ({ page }) => {
      test.setTimeout(120_000);
      await start(page);
      const before = await homeNames(page);

      // Cancel leaves the order as it was.
      await page.getByRole("button", { name: "Change order" }).click();
      await page.getByRole("button", { name: `Move ${before[2]} left` }).click();
      await page.getByRole("button", { name: "Cancel" }).click();
      await expect(page.getByTestId("goal-order-edit")).toHaveCount(0);
      expect(await homeNames(page)).toEqual(before);

      // The arrows from the keyboard: the moved card keeps the focus.
      await page.getByRole("button", { name: "Change order" }).click();
      await expect(page.getByRole("button", { name: `Move ${before[0]} left` })).toBeDisabled();
      await page.getByRole("button", { name: `Move ${before[2]} left` }).focus();
      await page.keyboard.press("Enter");
      await page.keyboard.press("Enter");
      expect(await editNames(page)).toEqual(thirdFirst(before));
      await expect(page.getByRole("button", { name: `Move ${before[2]} left` })).toBeDisabled();
      await saveOrder(page);
      await expect.poll(() => homeNames(page)).toEqual(thirdFirst(before));

      await everyPageShows(page, thirdFirst(before), label === "phone");
    });

    test("a save that fails partway leaves the order as it was", async ({ page }) => {
      test.setTimeout(120_000);
      await start(page);
      const before = await homeNames(page);

      await page.getByRole("button", { name: "Change order" }).click();
      // The third goal is written first and succeeds; the first goal's write then fails.
      const firstId = await page.getByTestId("goal-order-card").nth(0).getAttribute("data-goal-id");
      await page.evaluate(([key, id]) => localStorage.setItem(key, `PATCH /v1/baseline/entities/${id}`), [MOCK_FAIL_ONCE_KEY, firstId] as const);
      await page.getByRole("button", { name: `Move ${before[2]} left` }).click();
      await page.getByRole("button", { name: `Move ${before[2]} left` }).click();
      expect(await editNames(page)).toEqual(thirdFirst(before));
      await page.getByTestId("goal-order-save").click();
      // The save ends (the button is back) with no saved toast.
      await expect(page.getByTestId("goal-order-save")).toBeEnabled();
      await expect(page.getByText("Goal order saved. Every page shows the new order.")).toHaveCount(0);

      await page.reload();
      await expect(page.getByTestId("home-goal").first()).toBeVisible();
      await expect.poll(() => homeNames(page)).toEqual(before);
      expect(await numbered(page.getByTestId("home-goal"), "home-goal-link")).toEqual(asNumbered(before));
    });

    test("a viewer sees the numbered row with no Change order", async ({ page }) => {
      await start(page, "viewer");
      const shown = await homeNames(page);
      expect(await numbered(page.getByTestId("home-goal"), "home-goal-link")).toEqual(asNumbered(shown));
      await expect(page.getByRole("button", { name: "Change order" })).toHaveCount(0);
    });
  });
}
