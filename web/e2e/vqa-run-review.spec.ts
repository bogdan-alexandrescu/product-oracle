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
