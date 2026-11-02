import { expect, test, type Page } from "./test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";

/**
 * vqa-run-review: visual QA of the Engineering check as picked (EC1 b "List and reading pane",
 * EC2 b "Beside the verdict"), on the mock's "eng-check-shop" scenario, desktop and phone.
 *
 * Test cards:
 * - "list rows as dense as the frame": protects=a list row with no verdict yet is as tall as
 *   its words (Not decided sets no taller line than the chips beside it), so nine rows fit
 *   the list as in the picked frame; fails_when=the verdict cell adds a line taller than its
 *   words and every undecided row grows.
 * - "list ends at the bar": protects=on a desktop the list runs down to the decision bar's top
 *   edge, as in the picked frame, and never under it, at rest and scrolled, at 1440x900,
 *   1512x945 and 1920x1080 (whether its rows fill the room or not);
 *   fails_when=a gap above the bar cuts the last row short, or the list stops short of the bar
 *   when its rows are shorter than the window.
 * - "answered in its card" (EC2 b): protects=an answered question keeps its card, the same
 *   border and padding as an open one, with the tick, the question, the answer, who gave it
 *   and Change inside, and no answer box, desktop and phone; fails_when=the answered question
 *   loses its card and sits bare between the open ones.
 */

const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };

async function openCheck(page: Page) {
  await page.addInitScript(([key, s]) => localStorage.setItem(key, s), [MOCK_SCENARIO_KEY, "eng-check-shop"]);
  await login(page, "commenter@example.com");
  await page.goto("/inbox");
  const inboxRow = page.getByTestId("inbox-checkpoints").locator("tr[data-row]").filter({ hasText: "Engineering check" }).filter({ visible: true });
  await inboxRow.getByRole("link", { name: "Review" }).first().click();
  await expect(page.getByTestId("brief-row")).toHaveCount(9);
}

for (const [device, viewport] of [
  ["desktop", DESKTOP],
  ["phone", PHONE],
] as const) {
  test(`${device}: list rows as dense as the frame, Not decided no taller than its words`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await openCheck(page);
    // Sample data has no questions: its second line is only the verdict, Not decided.
    const verdict = page.locator('[data-testid="brief-row"][data-feature="f.sample-data"]').getByTestId("brief-verdict");
    await expect(verdict).toHaveText("Not decided");
    const cell = (await verdict.boundingBox())!;
    const words = (await verdict.getByText("Not decided").boundingBox())!;
    expect(Math.abs(cell.height - words.height), "the verdict cell is as tall as its words").toBeLessThan(0.5);
  });
}

// The list's height must not hang on the window or on how tall its rows come out (fonts): at
// 1512x945 and 1920x1080 nine rows are shorter than the room, and the list still ends at the bar.
for (const viewport of [DESKTOP, { width: 1512, height: 945 }, { width: 1920, height: 1080 }]) {
test(`desktop ${viewport.width}x${viewport.height}: the list runs down to the bar as in the frame, never under it`, async ({ page }) => {
  await page.setViewportSize(viewport);
  await openCheck(page);
  const list = (await page.getByRole("region", { name: "Features" }).boundingBox())!;
  const bar = (await page.getByTestId("decision-bar").boundingBox())!;
  expect(list.y + list.height, "the list ends at the bar's top edge").toBeGreaterThanOrEqual(bar.y - 1);
  expect(list.y + list.height, "the list never runs under the bar").toBeLessThanOrEqual(bar.y + 1);
  // Scrolled as a person would, the list sticks and still never runs under the bar.
  await page.mouse.move(900, 400);
  await page.mouse.wheel(0, 300);
  await expect.poll(async () => page.evaluate(() => scrollY)).toBeGreaterThan(0);
  const l2 = (await page.getByRole("region", { name: "Features" }).boundingBox())!;
  const b2 = (await page.getByTestId("decision-bar").boundingBox())!;
  // At the page's very end the grid stops one page gap (16px) above the bar: the list may stop
  // there, no higher.
  expect(l2.y + l2.height, "the list still runs down to the bar").toBeGreaterThanOrEqual(b2.y - 17);
  expect(l2.y + l2.height).toBeLessThanOrEqual(b2.y + 1);
});
}

for (const [device, viewport] of [
  ["desktop", DESKTOP],
  ["phone", PHONE],
] as const) {
  test(`${device}: an answered question keeps its card, as open ones do, with no answer box`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await openCheck(page);
    await page.locator('[data-testid="brief-row"][data-feature="f.returns-portal"]').getByRole("button").click();
    const pane = page.getByTestId("brief-inspector");
    const questions = pane.getByTestId("brief-question");
    const regions = "Does the shipping provider's returns endpoint work in every region we ship to?";
    await pane.getByRole("textbox", { name: `Answer: ${regions}` }).fill("Yes in 11 of our 14 regions; the other 3 fall back to the address slip.");
    await questions.first().getByRole("button", { name: "Answer", exact: true }).click();
    const answered = questions.first();
    await expect(answered).toHaveAttribute("data-answered", "true");
    await expect(answered.getByRole("textbox")).toHaveCount(0);
    await expect(answered.getByTestId("answer")).toContainText("Yes in 11 of our 14 regions");
    const card = (l: typeof answered) => l.evaluate((e) => { const c = getComputedStyle(e); return [c.borderTopWidth, c.borderTopStyle, c.paddingTop, c.paddingLeft, c.borderTopLeftRadius]; });
    // The same card as the open question below it.
    expect(await card(answered)).toEqual(await card(questions.nth(1)));
    expect((await card(answered))[0]).toBe("1px");
  });
}
