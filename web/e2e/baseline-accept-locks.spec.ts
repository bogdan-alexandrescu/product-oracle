import { expect, test } from "./test";

import { login } from "./helpers";

// Owner, 2026-10-25: accepting a Ground Truth proposal keeps locking the item, and the
// product says so before and after the click: the item is then locked against Oracle's
// changes until a person unlocks it.

const LOCKED = "locked against Oracle's changes until a person unlocks it";

test("the Proposals tab says Accept locks the item against Oracle's changes until a person unlocks it", async ({ page }) => {
  await login(page);
  await page.goto("/ground-truth?tab=proposals");
  const proposals = page.getByTestId("proposal");
  await expect(proposals.first()).toBeVisible();
  // The rule is on Accept (its title), not a standing paragraph (visual QA Nov 14).
  await expect(page.getByText(LOCKED).filter({ visible: true })).toHaveCount(0);
  const accept = proposals.filter({ hasText: "Guided setup" }).getByRole("button", { name: "Accept" });
  await expect(accept).toHaveAttribute("title", new RegExp(LOCKED));
  await accept.click();
  await expect(page.getByRole("status")).toContainText(LOCKED);
});
