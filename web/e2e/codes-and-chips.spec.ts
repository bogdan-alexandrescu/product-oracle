import { expect, test, type Page } from "./test";

import { login } from "./helpers";

/*
 * codes-and-chips: a goal whose title carries no code reads once, with no code chip; a
 * proposal's reason never shows a code without its name.
 * protects = the goal's name is not drawn twice, once in a mono code chip; a source's own
 * requirement number reads with where it comes from;
 * fails_when = the chip falls back to the title, or the reason shows "FR-06" bare;
 * no_claim = how a goal with a code is drawn (baseline-goals.spec.ts, named-codes.spec.ts).
 */

async function openBaseline(page: Page) {
  await login(page);
  await page.goto("/baseline");
  await expect(page.getByRole("heading", { level: 1, name: "Baseline" })).toBeVisible();
}

test("Add item: a goal with no code reads once, with no code chip", async ({ page }) => {
  await openBaseline(page);
  await page.getByRole("button", { name: "Add item" }).click();
  const form = page.getByRole("dialog", { name: "Add an item" });
  await form.getByLabel("Kind").selectOption("feature");
  const served = form.getByRole("group", { name: "Goals it serves" });
  await expect(served.getByLabel("Raise activation")).toBeVisible();
  // The name once: the row's label, never a code chip holding it too.
  await expect(served.getByText("Raise activation", { exact: true })).toHaveCount(1);
  await expect(served.getByText("Grow paid conversion", { exact: true })).toHaveCount(1);
  await expect(served.locator(".font-mono")).toHaveCount(0);
});

test("Proposals: a source's own requirement number reads with where it comes from", async ({ page }) => {
  await openBaseline(page);
  await page.getByRole("tab", { name: /Proposals/ }).click();
  const darkMode = page.getByTestId("proposal").filter({ hasText: "Dark mode" });
  await expect(darkMode).toContainText("Mentioned as next up in the planning call, under FR-06 (from the sources of Baseline to PRD).");
});
