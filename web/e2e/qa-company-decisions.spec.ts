import { expect, test, type Page } from "./test";

import { login } from "./helpers";

/*
 * QA findings on Company › Decisions (Detailed), driven through the UI on the mock layer.
 * The mock seeds five judgement calls: D-1 "Publish Checkout redesign PRD v2" (the owner
 * approved it; Oracle wrote the record), D-4 "Price the team plan per seat" (decided, its
 * review has come), D-5 "Ship usage caps before anomaly detection" (proposed, waits on the
 * approver), and two more the owner decided.
 */

const APPROVER = "approver@example.com";
const CAPS = "Ship usage caps before anomaly detection";
const PRICED = "Price the team plan per seat";
const PUBLISH = "Publish Checkout redesign PRD v2";

const rows = (page: Page) => page.getByTestId("decision-row");
const row = (page: Page, text: string) => rows(page).filter({ hasText: text });
const inspector = (page: Page) => page.getByTestId("decision-inspector").filter({ visible: true });
const group = (page: Page, name: string) => page.getByTestId("decision-filters").getByRole("group", { name, exact: true });
/** An inspector row (label, then value) by its label. */
const peopleRow = (page: Page, label: string) =>
  inspector(page)
    .locator("div.min-h-8 > span.truncate")
    .filter({ hasText: new RegExp(`^${label}$`) })
    .first()
    .locator("..");

// qa-company-18: each filter row names its group, and each "everything" chip says what it covers.
test("filters: Kind and State groups are labelled and end in All kinds and Any state", async ({ page }) => {
  await login(page);
  await page.goto("/company/decisions");
  const kind = group(page, "Kind");
  const state = group(page, "State");
  await expect(kind.getByRole("button", { name: /^All kinds/ })).toBeVisible();
  await expect(state.getByRole("button", { name: /^Any state/ })).toBeVisible();
  await expect(page.getByTestId("decision-filters").getByRole("button", { name: "All", exact: true })).toHaveCount(0);
  await expect(page.getByTestId("decision-filters").getByText("Kind", { exact: true })).toBeVisible();
  await expect(page.getByTestId("decision-filters").getByText("State", { exact: true })).toBeVisible();
});

// qa-company-19: Decided lists decided rows only; a decision whose review has come is under Review due.
test("Decided lists only decided rows, never a Review due one", async ({ page }) => {
  await login(page, APPROVER);
  await page.goto("/company/decisions");
  await group(page, "State")
    .getByRole("button", { name: /^Decided/ })
    .click();
  await expect(page).toHaveURL(/state=decided/);
  await expect(rows(page).first()).toBeVisible();
  await expect(row(page, PRICED)).toHaveCount(0);
  await expect(rows(page).filter({ hasText: "Review due" })).toHaveCount(0);
  await group(page, "State")
    .getByRole("button", { name: /^Review due/ })
    .click();
  await expect(row(page, PRICED)).toBeVisible();
});

// qa-company-20: a filtered-to-nothing list says which filter hides the rows, and clears them.
test("filtered to nothing: says which filter hides rows, keeps the total, Clear filters brings them back", async ({ page }) => {
  await login(page);
  await page.goto("/company/decisions?state=all");
  await expect(rows(page).first()).toBeVisible();
  const search = page.getByLabel("Search decisions");
  await search.fill("nothing matches this");
  await search.press("Enter");
  const empty = page.getByTestId("decisions-empty");
  await expect(empty).toContainText("No decisions match");
  await expect(empty).toContainText("No decisions match “nothing matches this”.");
  await expect(empty).not.toContainText("No decisions here");
  // The header keeps the total: "0 of 5", never a bare 0.
  await expect(page.getByTestId("panel-count").first()).toHaveText(/^0 of \d+\+?$/);
  await empty.getByRole("button", { name: "Clear filters" }).click();
  await expect(rows(page).first()).toBeVisible();
  await expect(row(page, CAPS)).toBeVisible();
});

// qa-company-13: an empty Needs me says what it counts and where other approvals wait.
test("an empty Needs me explains what it counts and points to the Inbox", async ({ page }) => {
  await login(page);
  await page.goto("/company/decisions?state=needs_me");
  const empty = page.getByTestId("decisions-needs-me-empty");
  await expect(empty).toContainText("Nothing waits on you here");
  await expect(empty).toContainText("proposals you are the approver of");
  await expect(empty).toContainText("review date has come");
  await expect(empty.getByRole("link", { name: "Inbox" })).toHaveAttribute("href", "/inbox");
});

// qa-company-14, qa-company-51: an action's form comes into view with the cursor in its
// first field; Withdraw is styled as the destructive action, Edit and Reassign as outlines.
test("Edit, Reassign and Withdraw scroll their form into view and focus its first field", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 640 });
  await login(page);
  await page.goto("/company/decisions?state=all");
  await row(page, CAPS).click();
  const actions = inspector(page).getByTestId("decision-actions");
  await expect(actions.getByRole("button", { name: "Edit", exact: true })).toHaveAttribute("data-variant", "secondary");
  await expect(actions.getByRole("button", { name: "Reassign", exact: true })).toHaveAttribute("data-variant", "secondary");
  await expect(actions.getByRole("button", { name: "Withdraw", exact: true })).toHaveAttribute("data-variant", "danger");

  await actions.getByRole("button", { name: "Edit", exact: true }).click();
  const edit = inspector(page).getByRole("form", { name: "Edit decision" });
  const title = edit.getByLabel("Decision", { exact: true });
  await expect(title).toBeFocused();
  await expect(title).toBeInViewport();
  await edit.getByRole("button", { name: "Cancel" }).click();

  await actions.getByRole("button", { name: "Reassign", exact: true }).click();
  const reassign = inspector(page).getByRole("form", { name: "Reassign" });
  await expect(reassign.getByLabel("New approver")).toBeFocused();
  await expect(reassign.getByLabel("New approver")).toBeInViewport();
  await reassign.getByRole("button", { name: "Cancel" }).click();

  await actions.getByRole("button", { name: "Withdraw", exact: true }).click();
  const withdraw = inspector(page).getByRole("form", { name: "Withdraw" });
  await expect(withdraw.getByLabel("Reason")).toBeFocused();
  await expect(withdraw.getByLabel("Reason")).toBeInViewport();
  await expect(withdraw.getByRole("button", { name: "Withdraw" })).toHaveAttribute("data-variant", "danger");
});

// qa-company-15: Propose with a field missing marks that field, brings it into view, focuses it
// and puts the note under it.
test("Propose decision: a missing field is marked invalid, focused, and its note sits by it", async ({ page }) => {
  await login(page);
  await page.goto("/company/decisions?state=all");
  await page.getByRole("button", { name: "Propose decision" }).click();
  const dialog = page.getByRole("dialog", { name: "Propose decision" });
  const propose = dialog.getByRole("button", { name: "Propose", exact: true });

  await propose.click();
  const title = dialog.getByRole("textbox", { name: /^Decision/ });
  await expect(title).toHaveAttribute("aria-invalid", "true");
  await expect(title).toBeFocused();
  await expect(title).toHaveAccessibleDescription("Write the decision in one sentence");

  await title.fill("Offer annual billing at launch");
  await expect(title).not.toHaveAttribute("aria-invalid", "true");
  await propose.click();
  const first = dialog.getByLabel("Option 1", { exact: true });
  await expect(first).toHaveAttribute("aria-invalid", "true");
  await expect(first).toBeFocused();
  await expect(first).toHaveAccessibleDescription("Add at least two options");

  await first.fill("Annual at launch");
  await dialog.getByLabel("Option 2", { exact: true }).fill("Monthly only");
  await propose.click();
  const approver = dialog.getByLabel("Approver", { exact: true });
  await expect(approver).toHaveAttribute("aria-invalid", "true");
  await expect(approver).toBeFocused();
  await expect(approver).toBeInViewport();
  await expect(approver).toHaveAccessibleDescription("Name the approver");
  // One note at a time, next to its field: the others are gone.
  await expect(dialog.getByText("Write the decision in one sentence")).toHaveCount(0);
  await expect(dialog.getByText("Add at least two options")).toHaveCount(0);
});

// qa-company-28: people read by name; the email is the second part, never the name.
test("people are named: the approver menu and the inspector's People read names", async ({ page }) => {
  await login(page);
  await page.goto("/company/decisions?state=all");
  await row(page, CAPS).click();
  await expect(peopleRow(page, "Approver")).toContainText("Approver");
  await expect(peopleRow(page, "Approver")).not.toContainText("@");
  await expect(peopleRow(page, "Contributors")).toContainText("Commenter");
  await expect(peopleRow(page, "Contributors")).not.toContainText("@");

  await page.getByRole("button", { name: "Propose decision" }).click();
  const dialog = page.getByRole("dialog", { name: "Propose decision" });
  await expect(dialog.getByLabel("Approver", { exact: true }).locator("option", { hasText: APPROVER })).toHaveText(`Approver · ${APPROVER}`);
  await expect(dialog.getByRole("group", { name: "Contributors" })).toContainText("Commenter");
});

// prod-3, qa-company-22: a decision the owner took is driven by the owner, its About names the
// document, and its dates read "Sep 28, 2026".
test("a decision the owner took: Driver is the owner, About names the document, dates read Mon D, YYYY", async ({ page }) => {
  await login(page);
  await page.goto("/company/decisions?state=all");
  await row(page, PUBLISH).click();
  await expect(inspector(page)).toContainText(PUBLISH);
  await expect(peopleRow(page, "Driver")).toContainText("Admin");
  await expect(peopleRow(page, "Driver")).not.toContainText("Oracle");
  await expect(
    inspector(page).getByRole("link", {
      name: "Checkout redesign PRD",
      exact: true,
    }),
  ).toHaveAttribute("href", "/documents/checkout-redesign");
  await expect(inspector(page)).not.toContainText("checkout-redesign");
  await expect(peopleRow(page, "Decided")).toHaveText(/[A-Z][a-z]{2} \d{1,2}, \d{4}$/);
  await expect(inspector(page)).not.toContainText(/\d{1,2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sept?|Oct|Nov|Dec) \d{4}/);
  await expect(row(page, PUBLISH)).toContainText(/[A-Z][a-z]{2} \d{1,2}, \d{4}/);
});

// qa-company-21: a long title wraps in full, never cut mid-word.
test("titles wrap in full instead of being cut", async ({ page }) => {
  await login(page);
  await page.goto("/company/decisions?state=all");
  const long = "Keep the reviewer's call over Oracle's pushback on Team onboarding PRD";
  const title = row(page, long).getByText(long, { exact: true });
  await expect(title).toBeVisible();
  const cut = await title.evaluate((el) => el.scrollWidth > el.clientWidth + 1 || getComputedStyle(el).textOverflow === "ellipsis");
  expect(cut).toBe(false);
});

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  // qa-company-35, qa-shell-36: menus instead of rows of pills; a full-width search reading "Search".
  test("filters are menus and the search is full width", async ({ page }) => {
    await login(page);
    await page.goto("/company/decisions?state=all");
    const filters = page.getByTestId("decision-filters");
    await expect(filters.getByRole("combobox", { name: "Kind" })).toBeVisible();
    await expect(filters.getByRole("combobox", { name: "State" })).toBeVisible();
    await expect(filters.getByRole("group", { name: "State", exact: true })).toHaveCount(0);
    await expect(filters.getByRole("button", { name: /^Any state/ })).toHaveCount(0);
    await filters.getByRole("combobox", { name: "State" }).selectOption({ label: "Proposed" });
    await expect(page).toHaveURL(/state=proposed/);
    await expect(row(page, CAPS)).toBeVisible();

    const search = filters.getByLabel("Search decisions");
    await expect(search).toHaveAttribute("placeholder", "Search");
    const [box, panel] = await Promise.all([search.boundingBox(), filters.boundingBox()]);
    expect(box!.width).toBeGreaterThan(panel!.width - 40);
    const [sw, cw] = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
    expect(sw).toBeLessThanOrEqual(cw);
  });

  // qa-company-15 on a phone: the missing field is brought into view in the dialog.
  test("Propose: the missing approver is scrolled to and focused", async ({ page }) => {
    await login(page);
    await page.goto("/company/decisions?state=all");
    await page.getByRole("button", { name: "Propose decision" }).click();
    const dialog = page.getByRole("dialog", { name: "Propose decision" });
    await dialog.getByRole("textbox", { name: /^Decision/ }).fill("Offer annual billing at launch");
    await dialog.getByLabel("Option 1", { exact: true }).fill("Annual at launch");
    await dialog.getByLabel("Option 2", { exact: true }).fill("Monthly only");
    await dialog.getByRole("button", { name: "Propose", exact: true }).click();
    const approver = dialog.getByLabel("Approver", { exact: true });
    await expect(approver).toBeFocused();
    await expect(approver).toBeInViewport();
    await expect(approver).toHaveAttribute("aria-invalid", "true");
  });
});
