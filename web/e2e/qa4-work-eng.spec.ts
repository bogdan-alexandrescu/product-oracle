import { expect, test, type Page } from "./test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";

/**
 * QA round 4, the engineering review screens (/runs/<id>/review/<checkpoint>): the Engineering
 * dates (eng-dates) and the Engineering check (eng-check), opened from the Inbox by the named
 * engineering lead, on the mock layer, driven as a person would.
 *
 * - qa4-work-47: a date's basis reads in plain words ("Estimate: shipping step"), never the key.
 * - qa4-work-48: the Next/Later group says why it has no dates, with no spec reference.
 * - qa4-work-49: the PRD's title and the section's words, never their slugs.
 * - qa4-work-50: a row that reads No date offers "Edit reason", and the More menu stays on its line.
 * - qa4-work-51: the chosen Accept shows as pressed.
 * - qa4-work-53: a feature shows its name only, never its key.
 * - qa4-work-54: a brief without a code map says so in plain words.
 * - qa4-work-55: Ask the architect is a button, not grey text.
 */

const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };

const withScenario = (page: Page, scenario: string) => page.addInitScript(([key, s]) => localStorage.setItem(key, s), [MOCK_SCENARIO_KEY, scenario]);
const dateRow = (page: Page, key: string) => page.locator(`[data-testid="date-row"][data-item="${key}"]`);
const briefRow = (page: Page, key: string) => page.locator(`[data-testid="brief-row"][data-feature="${key}"]`);

async function openFromInbox(page: Page, scenario: "eng-dates" | "eng-check", label: string, rows: string, count: number) {
  await withScenario(page, scenario);
  await login(page, "commenter@example.com");
  await page.goto("/inbox");
  const inboxRow = page.getByTestId("inbox-checkpoints").locator("tr[data-row]").filter({ hasText: label });
  await inboxRow.getByRole("link", { name: "Review" }).click();
  await expect(page).toHaveURL(/\/runs\/[0-9a-f-]+\/review\/[0-9a-f-]+$/);
  await expect(page.getByTestId(rows)).toHaveCount(count);
}
const openDates = (page: Page) => openFromInbox(page, "eng-dates", "Engineering dates", "date-row", 4);
const openCheck = (page: Page) => openFromInbox(page, "eng-check", "Engineering check", "brief-row", 3);

for (const [name, size] of [
  ["desktop", DESKTOP],
  ["phone", PHONE],
] as const) {
  test(`dates words (${name}): bases, the PRD and its sections read in plain words, and Next and Later say why they have no dates`, async ({ page }) => {
    // protects=qa4-work-47, 48, 49; fails_when=a basis key (est-shipping-step), the PRD slug, a section key or "O4 Roadmap shape" shows.
    await page.setViewportSize(size);
    await openDates(page);
    await expect(page.getByTestId("dates-prd")).toHaveText(/^The Now items of Usage alerts PRD v\d+$/);
    await expect(dateRow(page, "shipping-step").getByTestId("date-proposed")).toHaveText("Nov 30 · Estimate: shipping step");
    await expect(dateRow(page, "saved-addresses").getByTestId("date-proposed")).toHaveText("Dec 11 · Capacity plan: Q4 checkout");
    await expect(dateRow(page, "shipping-step")).toContainText("PRD section: Shipping");
    await expect(dateRow(page, "price-early")).toContainText("PRD section: Pricing");
    const table = page.getByRole("region", { name: "Now items" });
    for (const key of ["est-shipping-step", "est-price-early", "cap-q4-checkout", "usage-alerts", "PRD section shipping"]) await expect(table).not.toContainText(key);
    await expect(page.getByTestId("dates-others").locator("summary")).toHaveText("Next 2 · Later 1 (Next and Later items have no dates)");
  });

  test(`dates row buttons (${name}): a No date row offers Edit reason with the More menu on its line`, async ({ page }) => {
    // protects=qa4-work-50; fails_when=a row tagged No date also offers a No date button, Edit reason opens empty, or More drops to a line of its own.
    await page.setViewportSize(size);
    await openDates(page);
    const cart = dateRow(page, "cart-review");
    await expect(cart.getByTestId("date-decision")).toHaveText("No date");
    const group = cart.getByRole("group", { name: "Date: Cart review step" });
    await expect(group.getByRole("button", { name: "No date", exact: true })).toHaveCount(0);
    const edit = group.getByRole("button", { name: "Edit reason" });
    const more = group.getByRole("button", { name: "More for Cart review step" });
    const a = await edit.boundingBox();
    const b = await more.boundingBox();
    expect(a && b && Math.abs(a.y + a.height / 2 - (b.y + b.height / 2)) < 4 && b.x > a.x).toBeTruthy();
    await edit.click();
    const dialog = page.getByTestId("date-none");
    await expect(dialog.getByRole("textbox", { name: "Reason" })).toHaveValue("Waits on the provider's sandbox");
    await dialog.getByRole("button", { name: "Cancel" }).click();
  });
}

test("dates: after No date the button reads Edit reason, pre-filled with the saved reason", async ({ page }) => {
  // protects=qa4-work-50 on a dated row; fails_when=the row keeps a No date button beside its No date tag.
  await page.setViewportSize(DESKTOP);
  await openDates(page);
  const price = dateRow(page, "price-early");
  await price.getByRole("button", { name: "No date", exact: true }).click();
  const dialog = page.getByTestId("date-none");
  await dialog.getByRole("textbox", { name: "Reason" }).fill("Waits on the pricing service rewrite");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(price.getByTestId("date-decision")).toHaveText("No date");
  await expect(price.getByRole("button", { name: "No date", exact: true })).toHaveCount(0);
  await price.getByRole("button", { name: "Edit reason" }).click();
  await expect(dialog.getByRole("textbox", { name: "Reason" })).toHaveValue("Waits on the pricing service rewrite");
});

test("dates: Accept shows as pressed once chosen", async ({ page }) => {
  // protects=qa4-work-51; fails_when=the Accept button looks the same before and after the choice.
  await page.setViewportSize(DESKTOP);
  await openDates(page);
  const shipping = dateRow(page, "shipping-step");
  const accept = shipping.getByRole("button", { name: "Accept", exact: true });
  await expect(accept).toHaveAttribute("aria-pressed", "false");
  await accept.click();
  await expect(shipping.getByTestId("date-decision")).toHaveText("Accepted");
  await expect(accept).toHaveAttribute("aria-pressed", "true");
  await expect(accept).toHaveAttribute("data-variant", "solid");
  await expect(shipping.getByRole("button", { name: "Change", exact: true })).toHaveAttribute("aria-pressed", "false");
});

test("dates: Ask the architect in the panel is a button like the others", async ({ page }) => {
  // protects=qa4-work-55 on the Engineering dates; fails_when=Ask the architect is a ghost (grey text) button.
  await page.setViewportSize(DESKTOP);
  await openDates(page);
  await dateRow(page, "saved-addresses").getByRole("button").first().click();
  const panel = page.getByTestId("dates-inspector");
  await expect(panel).toContainText("Dec 11 · Capacity plan: Q4 checkout");
  await expect(panel.getByRole("button", { name: "Ask the architect" })).toHaveAttribute("data-variant", "secondary");
});

for (const [name, size] of [
  ["desktop", DESKTOP],
  ["phone", PHONE],
] as const) {
  test(`check (${name}): features show their names only, never their keys`, async ({ page }) => {
    // protects=qa4-work-53; fails_when=a feature key (f.guided-setup) shows under or beside its name.
    await page.setViewportSize(size);
    await openCheck(page);
    await expect(briefRow(page, "f.guided-setup").getByRole("button").first()).toHaveText("Guided setup");
    await expect(briefRow(page, "f.sample-data").getByRole("button").first()).toHaveText("Sample data");
    const table = page.getByRole("region", { name: "Features" });
    for (const key of ["f.guided-setup", "f.sample-data", "f.saved-carts"]) await expect(table).not.toContainText(key);
  });
}

test("check: no code map reads in plain words, the panel names what a feature depends on, and Ask the architect is a button", async ({ page }) => {
  // protects=qa4-work-53 (Depends on), 54, 55; fails_when="No code map" shows, Depends on names a key, or Ask the architect is a ghost button.
  await page.setViewportSize(DESKTOP);
  await openCheck(page);
  const guess = "Oracle could not read the code, so this approach is a guess";
  await expect(briefRow(page, "f.guided-setup").getByTestId("brief-reasons")).toContainText(guess);
  await expect(page.getByRole("region", { name: "Features" })).not.toContainText("No code map");
  await briefRow(page, "f.saved-carts").getByRole("button").first().click();
  const panel = page.getByTestId("brief-inspector");
  await expect(panel).toHaveAccessibleName("Brief: Saved carts");
  await expect(panel).toContainText(guess);
  await expect(panel).not.toContainText("No code map");
  await expect(panel).toContainText("Depends on Guided setup");
  await expect(panel).not.toContainText("f.guided-setup");
  await expect(panel.getByRole("button", { name: "Ask the architect" })).toHaveAttribute("data-variant", "secondary");
});
