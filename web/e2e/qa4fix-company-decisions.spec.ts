import { expect, test, type Page } from "./test";

import { login, signOut } from "./helpers";

/*
 * Fourth QA pass on Company › Decisions (Detailed), driven through the UI on the default mock
 * scenario. The mock seeds judgement calls only (no checkpoint decisions): D-4 "Price the team
 * plan per seat" (decided, Approver is its approver) and D-5 "Ship usage caps before anomaly
 * detection" (proposed by Commenter for Approver). Admin, the default sign-in, is an owner.
 * Each test names the finding it protects.
 */

const APPROVER = "approver@example.com";
const COMMENTER = "commenter@example.com";
const CAPS = "Ship usage caps before anomaly detection";
const PRICED = "Price the team plan per seat";

const rows = (page: Page) => page.getByTestId("decision-row");
const row = (page: Page, text: string) => rows(page).filter({ hasText: text });
const inspector = (page: Page) => page.getByTestId("decision-inspector").filter({ visible: true });
const actions = (page: Page) => inspector(page).getByTestId("decision-actions");
const group = (page: Page, name: string) => page.getByTestId("decision-filters").getByRole("group", { name, exact: true });

async function openPropose(page: Page) {
  await page.goto("/company/decisions?state=all");
  await page.getByRole("button", { name: "Propose decision" }).click();
  return page.getByRole("dialog", { name: "Propose decision" });
}

test.describe("desktop", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("qa4-company-8: Propose decision offers no Remove at two options, only above two", async ({ page }) => {
    await login(page);
    const dialog = await openPropose(page);
    await expect(dialog.getByLabel("Option 2", { exact: true })).toBeVisible();
    await expect(dialog.getByRole("button", { name: /^Remove option/ })).toHaveCount(0);

    await dialog.getByRole("button", { name: "Add option" }).click();
    await expect(dialog.getByLabel("Option 3", { exact: true })).toBeVisible();
    await expect(dialog.getByRole("button", { name: /^Remove option/ })).toHaveCount(3);

    await dialog.getByRole("button", { name: "Remove option 3" }).click();
    await expect(dialog.getByLabel("Option 3", { exact: true })).toHaveCount(0);
    await expect(dialog.getByRole("button", { name: /^Remove option/ })).toHaveCount(0);
  });

  test("qa4-company-9: Propose on an empty form marks every missing field at once", async ({ page }) => {
    await login(page);
    const dialog = await openPropose(page);
    await dialog.getByRole("button", { name: "Propose", exact: true }).click();
    const title = dialog.getByRole("textbox", { name: /^Decision/ });
    const option = dialog.getByLabel("Option 1", { exact: true });
    const approver = dialog.getByLabel("Approver", { exact: true });
    await expect(title).toHaveAttribute("aria-invalid", "true");
    await expect(option).toHaveAttribute("aria-invalid", "true");
    await expect(approver).toHaveAttribute("aria-invalid", "true");
    await expect(dialog.getByText("Write the decision in one sentence")).toBeVisible();
    await expect(dialog.getByText("Add at least two options")).toBeVisible();
    await expect(dialog.getByText("Name the approver")).toBeVisible();
    // The cursor goes to the first one.
    await expect(title).toBeFocused();
  });

  test("qa4-company-10: each option card's examples go with its own label", async ({ page }) => {
    await login(page);
    const dialog = await openPropose(page);
    await expect(dialog.getByLabel("Option 1", { exact: true })).toHaveAttribute("placeholder", "e.g. Annual at launch");
    await expect(dialog.getByLabel("Option 1 summary")).toHaveAttribute("placeholder", "Summary, e.g. Yearly plans from the first day");
    await expect(dialog.getByLabel("Option 2", { exact: true })).toHaveAttribute("placeholder", "e.g. Monthly only");
    await expect(dialog.getByLabel("Option 2 summary")).toHaveAttribute("placeholder", "Summary, e.g. Billed each month");
    const cost1 = await dialog.getByLabel("Option 1 cost if wrong").getAttribute("placeholder");
    const cost2 = await dialog.getByLabel("Option 2 cost if wrong").getAttribute("placeholder");
    expect(cost2).not.toBe(cost1);
  });

  test("qa4-company-12: Withdraw and Reassign each show one button by that name; the submit says what it does", async ({ page }) => {
    await login(page);
    await page.goto("/company/decisions?state=all");
    await row(page, CAPS).click();
    await expect(inspector(page)).toContainText(CAPS);

    await actions(page).getByRole("button", { name: "Withdraw", exact: true }).click();
    const withdraw = inspector(page).getByRole("form", { name: "Withdraw" });
    await expect(withdraw.getByRole("button", { name: /^Withdraw D-\d+$/ })).toBeVisible();
    await expect(inspector(page).getByRole("button", { name: "Withdraw", exact: true })).toHaveCount(1);
    await withdraw.getByRole("button", { name: "Cancel" }).click();
    await expect(withdraw).toHaveCount(0);

    await actions(page).getByRole("button", { name: "Reassign", exact: true }).click();
    const reassign = inspector(page).getByRole("form", { name: "Reassign" });
    await expect(reassign.getByRole("button", { name: "Reassign to the new approver" })).toBeDisabled();
    await expect(inspector(page).getByRole("button", { name: "Reassign", exact: true })).toHaveCount(1);
    await reassign.getByLabel("New approver").selectOption({ label: "Admin · admin@example.com" });
    await expect(reassign.getByRole("button", { name: "Reassign to Admin" })).toBeEnabled();
    await expect(inspector(page).getByRole("button", { name: "Reassign", exact: true })).toHaveCount(1);
  });

  test("qa4-company-15: the filter chips keep their place whether or not a decision is open", async ({ page }) => {
    await login(page);
    await page.goto("/company/decisions?state=all");
    await expect(inspector(page)).toBeVisible();
    const filters = page.getByTestId("decision-filters");
    const from = group(page, "From");
    const before = { filters: await filters.boundingBox(), from: await from.boundingBox() };

    await group(page, "Kind")
      .getByRole("button", { name: /^Checkpoints/ })
      .click();
    await expect(page.getByTestId("decisions-empty")).toBeVisible();
    await expect(inspector(page)).toHaveCount(0);
    await expect(page.getByTestId("decision-inspector-empty")).toBeVisible();
    const after = { filters: await filters.boundingBox(), from: await from.boundingBox() };
    expect(after.filters!.width).toBeCloseTo(before.filters!.width, 0);
    expect(after.from!.height).toBeCloseTo(before.from!.height, 0);

    await group(page, "Kind")
      .getByRole("button", { name: /^Judgement calls/ })
      .click();
    await expect(inspector(page)).toBeVisible();
    expect((await filters.boundingBox())!.width).toBeCloseTo(before.filters!.width, 0);
  });

  test("qa4-company-16: an empty Checkpoints list says a waiting checkpoint is in the Inbox", async ({ page }) => {
    await login(page);
    await page.goto("/company/decisions?state=all");
    await group(page, "Kind")
      .getByRole("button", { name: /^Checkpoints/ })
      .click();
    const empty = page.getByTestId("decisions-empty");
    await expect(empty).toContainText("No checkpoint decisions.");
    await expect(empty).toContainText("A run checkpoint shows here once it is approved or sent back; one still waiting is in the Inbox.");
    await empty.getByRole("link", { name: "Inbox" }).click();
    await expect(page).toHaveURL(/\/inbox/);
  });

  test("qa4-company-17: the review action on a decided decision says it reviews the outcome", async ({ page }) => {
    await login(page, APPROVER);
    await page.goto("/company/decisions?state=all");
    await row(page, PRICED).click();
    await expect(inspector(page)).toContainText(PRICED);
    await expect(actions(page).getByRole("button", { name: "Review", exact: true })).toHaveCount(0);
    await actions(page).getByRole("button", { name: "Review the outcome" }).click();
    await expect(inspector(page).getByRole("form", { name: "Review" })).toBeVisible();
  });

  test("qa4-company-18: a commenter who cannot edit a proposal sees no Edit", async ({ page }) => {
    const title = "Offer annual billing at launch";
    // Admin proposes a decision for Approver.
    await login(page);
    const dialog = await openPropose(page);
    await dialog.getByLabel("Decision", { exact: true }).fill(title);
    await dialog.getByLabel("Option 1", { exact: true }).fill("Annual at launch");
    await dialog.getByLabel("Option 2", { exact: true }).fill("Monthly only");
    await dialog.getByLabel("Approver", { exact: true }).selectOption({ label: `Approver · ${APPROVER}` });
    await dialog.getByRole("button", { name: "Propose", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(row(page, title)).toContainText("Proposed");

    // A commenter signs in on the same browser and opens it.
    await signOut(page);
    const other = page;
    await login(other, COMMENTER);
    await other.goto("/company/decisions?state=all");
    await row(other, title).click();
    await expect(inspector(other)).toContainText(title);
    await expect(inspector(other).getByRole("button", { name: "Edit", exact: true })).toHaveCount(0);
    await expect(inspector(other)).not.toContainText("Only its creator");
    // Their own proposal still offers Edit.
    await row(other, CAPS).click();
    await expect(inspector(other)).toContainText(CAPS);
    await expect(inspector(other).getByRole("button", { name: "Edit", exact: true })).toBeVisible();
  });
});
