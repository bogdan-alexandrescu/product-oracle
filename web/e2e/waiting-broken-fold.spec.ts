import { login } from "./helpers";
import { expect, test } from "./test";

/**
 * simple-home-qa-nov12 #3: a feature with two broken links (its start and its end) waits as ONE
 * row, as Home's broken-links card groups them; its Fix the link lists both breaks, each with
 * its own fixes. Driven through the UI on the mock's invented roadmap.
 *
 * Card broken-fold: protects = Decisions' "Waiting for you" shows one "Broken link · Weekly alert
 * digest" row, whose Fix the link lists both breaks; fixing one leaves the row with the other;
 * fails_when = the feature shows as two rows that look the same, each with its own Fix the link.
 */
test.use({ viewport: { width: 1440, height: 900 } });

test("A feature with two broken links waits as one row whose Fix the link lists both", async ({ page }) => {
  await login(page);
  await page.goto("/simple/decisions");
  const mine = page.getByTestId("questions-mine");
  const rows = mine.getByTestId("waiting-item").filter({ hasText: "Weekly alert digest" }).and(page.locator('[data-kind="broken_link"]'));
  await expect(rows.first()).toBeVisible();
  await expect(rows).toHaveCount(1);
  const row = rows.first();
  await row.getByRole("button", { name: "Fix the link" }).click();
  const breaks = row.getByTestId("waiting-fixes");
  await expect(breaks).toHaveCount(2);
  for (const b of await breaks.all()) await expect(b.getByRole("button", { name: "Accept as risk" })).toBeVisible();

  // Fixing one break leaves the row with the other.
  const first = breaks.first();
  await first.getByRole("button", { name: "Accept as risk" }).click();
  await first.getByRole("textbox", { name: "Why the risk is acceptable" }).fill("The digest can wait for the next release");
  await first.getByRole("button", { name: "Accept as risk" }).click();
  await expect(rows).toHaveCount(1);
  await expect(rows.first().getByRole("button", { name: "Fix the link" })).toBeVisible();
});
