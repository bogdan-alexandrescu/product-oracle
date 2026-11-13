import { expect, test, type Page } from "./test";

import { login } from "./helpers";

/*
 * Detailed visual QA, Nov 12, 2026 (pass A), findings 6 and 17, on a PRD version's Roadmap tab
 * (Checkout redesign PRD v2, seeded in lib/api/mock/draft-roadmap.ts: Cart review is the
 * Ground Truth feature F-41; Guest checkout, Shipping step and Saved addresses name no feature;
 * v1's One-tap wallet pay was dropped). Driven through the UI on the mock API; invented data only.
 */

const DESKTOP = { width: 1440, height: 900 };

// Next keeps recently visited routes mounted (hidden): only the visible page's elements.
const visible = (page: Page, testId: string) =>
  page.getByTestId(testId).filter({ visible: true });
const row = (page: Page, key: string) =>
  page
    .locator(`[data-testid="roadmap-item-row"][data-key="${key}"]`)
    .filter({ visible: true });
const rows = (page: Page) =>
  page
    .locator(
      '[data-testid="roadmap-item-row"], [data-testid="roadmap-item-ghost"]',
    )
    .filter({ visible: true });
const chip = (page: Page, name: RegExp) =>
  visible(page, "items-filter").getByRole("button", { name });

async function openRoadmap(page: Page) {
  await login(page);
  await page.goto("/documents/checkout-redesign/v/2");
  await visible(page, "version-tab-roadmap").click();
  await expect(page).toHaveURL(/\/documents\/checkout-redesign\/v\/2\/roadmap/);
  await expect(visible(page, "draft-roadmap-status")).toHaveAttribute(
    "data-status",
    "ready",
  );
}

test.use({ viewport: DESKTOP });

test("#6: each roadmap item shows its feature code before its name, and one with none is flagged Not in the Ground Truth", async ({
  page,
}) => {
  await openRoadmap(page);
  await chip(page, /^All/).click();
  const cart = row(page, "cart-review");
  await expect(cart).toContainText("F-41 Cart review shows the full price");
  await expect(cart.getByTestId("not-in-ground-truth")).toHaveCount(0);
  for (const key of ["guest-checkout", "shipping-step", "saved-addresses"]) {
    await expect(row(page, key).getByTestId("not-in-ground-truth")).toHaveText(
      "Not in the Ground Truth",
    );
  }
  // Saved addresses keeps its check problem beside the flag.
  await expect(
    row(page, "saved-addresses").getByTestId("draft-roadmap-chips"),
  ).toHaveText("Date unverified");

  // The item's panel names it the same way.
  await cart.click();
  await expect(visible(page, "roadmap-item-inspector")).toContainText(
    "F-41 Cart review shows the full price",
  );
});

test("#17: with Changed picked, the chip, the note and the rows agree", async ({
  page,
}) => {
  await openRoadmap(page);
  const changed = chip(page, /^Changed/);
  await expect(changed).toHaveAttribute("aria-pressed", "true");
  const count = Number(
    ((await changed.textContent()) ?? "").match(/(\d+)/)?.[1],
  );
  expect(count).toBeGreaterThan(0);
  // The dropped item's struck row is one of the changes the chip counts.
  await expect(visible(page, "roadmap-item-ghost")).toHaveCount(1);
  await expect(rows(page)).toHaveCount(count);
  const note = visible(page, "items-filter-note");
  if (await note.count())
    await expect(note).toContainText(`Showing ${count} of`);
  else await expect(note).toHaveCount(0);
  await expect(page.getByText(/Showing 3 of 4 items/)).toHaveCount(0);
});
