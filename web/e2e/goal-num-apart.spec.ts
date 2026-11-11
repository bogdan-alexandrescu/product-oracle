import { expect, test, type Locator, type Page } from "./test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";

/**
 * A goal's small grey number reads apart from its name in the page's text and to screen
 * readers ("1 · Name", never "1Name"), on Home's goal cards, the Roadmap's goal cards and
 * the chart's goal band headers. The "simple-home" mock scenario's invented goals.
 */

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** `el`'s text leads with `n`, a "·" and then `name`. */
async function readsApart(el: Locator, n: number, name: string) {
  const text = (await el.innerText()).replace(/\s+/g, " ").trim();
  expect(text).toMatch(new RegExp(`^${n} · ${escape(name)}`));
}

async function start(page: Page) {
  await page.context().addInitScript(([key]) => localStorage.setItem(key, "simple-home"), [MOCK_SCENARIO_KEY]);
  await login(page);
  await page.goto("/simple");
  await expect(page.getByTestId("home-goal").first()).toBeVisible();
}

test("a goal's number reads apart from its name on Home, the Roadmap's cards and its band headers", async ({ page }) => {
  await start(page);
  const first = (await page.getByTestId("home-goal-link").first().innerText()).trim();
  const card = page.getByTestId("home-goal").filter({ has: page.getByTestId("home-goal-link").filter({ hasText: first }) }).first();
  await readsApart(card.getByTestId("order-num").locator(".."), 1, first);

  await page.goto("/simple/roadmap");
  const counter = page.getByTestId("goal-counters").getByTestId("goal-counter").filter({ hasText: first }).first();
  await expect(counter).toBeVisible();
  await readsApart(counter, 1, first);

  await page.getByRole("button", { name: "Gantt", exact: true }).click();
  await page.getByTestId("group-goal").click();
  await expect(page.getByTestId("group-goal")).toHaveAttribute("aria-pressed", "true");
  const band = page.getByTestId("chart-group").filter({ hasText: first }).first();
  await expect(band).toBeVisible();
  await readsApart(band, 1, first);
});
