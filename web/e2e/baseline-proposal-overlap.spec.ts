import { expect, test, type Page } from "@playwright/test";

import { login } from "./helpers";

// #268: the "proposal-overlap" scenario adds two run proposals on Saved carts that both set
// its milestone (lib/api/mock/baseline.ts addOverlappingProposals).
const FIRST = "Slice a ships in M2.";
const SECOND = "Moved below the line after sizing.";

async function openProposals(page: Page) {
  await page.addInitScript(() => localStorage.setItem("po-mock-scenario", "proposal-overlap"));
  await login(page);
  await page.goto("/baseline");
  await expect(page.getByRole("heading", { level: 1, name: "Baseline" })).toBeVisible();
  await page.getByRole("tab", { name: /Proposals/ }).click();
  await expect(page.getByTestId("proposal").filter({ hasText: SECOND })).toBeVisible();
}

/** Accepts the first proposal; the second's card then flags the overlap and Accept warns. */
async function acceptFirstThenOpenWarning(page: Page) {
  const rows = page.getByTestId("proposal");
  const second = rows.filter({ hasText: SECOND });
  await expect(second.getByTestId("overlap-chip")).toHaveCount(0);
  await rows.filter({ hasText: FIRST }).getByRole("button", { name: "Accept" }).click();
  await expect(page.getByRole("status")).toContainText("Proposal accepted");
  await expect(second.getByTestId("overlap-chip")).toHaveText("Changes what you just accepted");

  await second.getByRole("button", { name: "Accept" }).click();
  const warning = second.getByRole("group", { name: "This would undo a change" });
  await expect(warning).toContainText(/This would undo a change you accepted (less than a minute|\d+ min) ago\./);
  const field = warning.getByTestId("overlap-milestone");
  await expect(field.getByTestId("overlap-now")).toHaveText("milestone now: M2");
  await expect(field.getByTestId("overlap-proposed")).toHaveText("this proposal: Below the line");
  await expect(warning.getByRole("button", { name: "Reject" })).toBeVisible();
  return warning;
}

async function savedCarts(page: Page) {
  await page.getByRole("tab", { name: /Graph/ }).click();
  await page.getByTestId("feature-f.saved-carts").getByRole("button", { name: "Saved carts" }).click();
  return page.getByRole("dialog", { name: "Saved carts" });
}

/**
 * protects: a proposal that would undo what a sibling just set warns first (#268, design A).
 * fails_when: the chip is missing, Accept applies at once, the warning lacks either value, or
 * "Skip milestone, apply the rest" overwrites the milestone or leaves the other field unapplied.
 * no_claim: edges; the entity drawer (it has no Accept).
 */
test("baseline: skip the overlapping field and apply the rest", async ({ page }) => {
  await openProposals(page);
  const warning = await acceptFirstThenOpenWarning(page);
  await warning.getByRole("button", { name: "Skip milestone, apply the rest" }).click();
  await expect(page.getByRole("status")).toContainText("Proposal accepted without milestone");
  await expect(page.getByTestId("proposal").filter({ hasText: SECOND })).toHaveCount(0);
  const d = await savedCarts(page);
  await expect(d.locator('[data-attr="milestone"]')).toHaveText("M2");
  await expect(d.locator('[data-attr="effort"]')).toHaveText("XL");
});

test("baseline: apply anyway overwrites the field", async ({ page }) => {
  await openProposals(page);
  const warning = await acceptFirstThenOpenWarning(page);
  await warning.getByRole("button", { name: "Apply anyway" }).click();
  await expect(page.getByRole("status")).toContainText("Proposal accepted");
  const d = await savedCarts(page);
  await expect(d.locator('[data-attr="milestone"]')).toHaveText("Below the line");
  await expect(d.locator('[data-attr="effort"]')).toHaveText("XL");
});

/**
 * protects: the warning on a phone.
 * fails_when: at 390 px the page scrolls sideways or a warning button is out of view.
 */
test("baseline: the overlap warning wraps on a phone", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openProposals(page);
  const warning = await acceptFirstThenOpenWarning(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  for (const name of ["Skip milestone, apply the rest", "Apply anyway", "Reject"]) {
    const button = warning.getByRole("button", { name });
    await button.scrollIntoViewIfNeeded();
    await expect(button).toBeInViewport({ ratio: 1 });
  }
});

/**
 * protects: each card on an entry with other open proposals links to them (#268, first Done-when item).
 * fails_when: the link is missing or miscounted, clicking it does not scroll to and highlight the
 * sibling card, or the link stays once the sibling is decided.
 */
test("baseline: a card links to the other open proposal on its entry", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 400 });
  await openProposals(page);
  const rows = page.getByTestId("proposal");
  const first = rows.filter({ hasText: FIRST });
  const second = rows.filter({ hasText: SECOND });
  await expect(second.getByRole("button", { name: "1 other open proposal on this entry" })).toBeVisible();
  await expect(second).not.toHaveAttribute("data-highlighted", "true");
  await first.getByRole("button", { name: "1 other open proposal on this entry" }).click();
  await expect(second).toHaveAttribute("data-highlighted", "true");
  await expect(second).toBeInViewport();
  await expect(first).not.toHaveAttribute("data-highlighted", "true");

  await first.getByRole("button", { name: "Accept" }).click();
  await expect(page.getByRole("status")).toContainText("Proposal accepted");
  await expect(second.getByRole("button", { name: /other open proposal/ })).toHaveCount(0);
});
