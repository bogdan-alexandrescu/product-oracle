import { expect, test, type Page } from "./test";

import { login } from "./helpers";

/*
 * Third QA pass on Company › Decisions, driven through the UI on the default mock scenario.
 * The mock seeds five judgement calls: D-1 "Publish Checkout redesign PRD v2" (recorded when a
 * version was published), D-5 "Ship usage caps before anomaly detection" (proposed by
 * Commenter, Approver is its approver, "Caps first" is Oracle's pick). Each test names the
 * finding it protects.
 */

const APPROVER = "approver@example.com";
const VIEWER = "viewer@example.com";
const CAPS = "Ship usage caps before anomaly detection";
const PUBLISH = "Publish Checkout redesign PRD v2";

const rows = (page: Page) => page.getByTestId("decision-row");
const row = (page: Page, text: string) => rows(page).filter({ hasText: text });
const inspector = (page: Page) => page.getByTestId("decision-inspector").filter({ visible: true });
const group = (page: Page, name: string) => page.getByTestId("decision-filters").getByRole("group", { name, exact: true });

async function openCaps(page: Page, email?: string) {
  await login(page, email);
  await page.goto("/company/decisions?state=all");
  await row(page, CAPS).click();
  await expect(inspector(page)).toContainText(CAPS);
}

test.describe("desktop", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  for (const scheme of ["light", "dark"] as const) {
    test(`qa-company-5: Propose decision's placeholders read as dim examples, never as filled in (${scheme})`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await login(page);
      await page.goto("/company/decisions?state=all");
      await page.getByRole("button", { name: "Propose decision" }).click();
      const dialog = page.getByRole("dialog", { name: "Propose decision" });
      const title = dialog.getByRole("textbox", { name: /^Decision/ });
      await expect(title).toHaveAttribute("placeholder", /^e\.g\. /);
      await expect(dialog.getByRole("textbox", { name: /^Question/ })).toHaveAttribute("placeholder", /^e\.g\. /);
      await expect(dialog.getByLabel("Option 1", { exact: true })).toHaveAttribute("placeholder", /^e\.g\. /);
      // No placeholder is a real decision's title.
      const placeholders = await dialog.locator("[placeholder]").evaluateAll((els) => els.map((e) => e.getAttribute("placeholder") ?? ""));
      expect(placeholders.some((p) => /usage caps/i.test(p))).toBe(false);
      // The field's text is regular weight, not the label's semibold (that made the hint read as a value).
      expect(await title.evaluate((el) => getComputedStyle(el).fontWeight)).toBe("400");

      await dialog.getByRole("button", { name: "Propose", exact: true }).click();
      await expect(dialog.getByText("Write the decision in one sentence")).toBeVisible();
      await expect(title).toHaveValue("");
      await expect(title).toHaveAttribute("aria-invalid", "true");
      await expect(title).toHaveAttribute("placeholder", /^e\.g\. /);
    });
  }

  test("qa-company-25: Ask Oracle for options says what it added and keeps the badge top right on every card", async ({ page }) => {
    await openCaps(page);
    await inspector(page).getByRole("button", { name: "Ask Oracle for options" }).click();
    const note = inspector(page).getByTestId("decision-options-note");
    await expect(note).toHaveText("Oracle added 2 options and now recommends “Take the smallest reversible step”.");
    const cards = inspector(page).getByTestId("decision-option");
    await expect(cards).toHaveCount(4);
    const badged = cards.filter({ has: page.getByText("Oracle recommends", { exact: true }) });
    await expect(badged).toHaveCount(1);
    await expect(badged).toContainText("Take the smallest reversible step");
    // Every card's badge sits on the label's first line, at the card's right edge.
    for (const card of await cards.all()) {
      const badge = card.getByText("Oracle recommends", { exact: true });
      if ((await badge.count()) === 0) continue;
      const label = card.locator("span.font-semibold").first();
      const [b, l, c] = await Promise.all([badge.boundingBox(), label.boundingBox(), card.boundingBox()]);
      expect(Math.abs(b!.y - l!.y)).toBeLessThan(6);
      expect(c!.x + c!.width - (b!.x + b!.width)).toBeLessThan(20);
    }
  });

  test("qa-company-25: the seeded recommendation's badge sits top right too", async ({ page }) => {
    await openCaps(page);
    const card = inspector(page).getByTestId("decision-option").filter({ hasText: "Caps first" });
    const badge = card.getByText("Oracle recommends", { exact: true });
    const [b, c] = await Promise.all([badge.boundingBox(), card.boundingBox()]);
    expect(c!.x + c!.width - (b!.x + b!.width)).toBeLessThan(20);
  });

  test("qa-company-26: an option's Pros, Cons and Cost if wrong are set off from what they say", async ({ page }) => {
    await openCaps(page);
    const card = inspector(page).getByTestId("decision-option").filter({ hasText: "Caps first" });
    await expect(card).toContainText("Pros: One sprint");
    await expect(card).toContainText("Cons: No early warning");
    await expect(card).toContainText("Cost if wrong: A month of noisy alerts");
  });

  test("qa-company-27: a search that matches nothing reads No decisions match “zzzz”.", async ({ page }) => {
    await login(page);
    await page.goto("/company/decisions?state=all");
    await expect(rows(page).first()).toBeVisible();
    const search = page.getByLabel("Search decisions");
    await search.fill("zzzz");
    await search.press("Enter");
    const empty = page.getByTestId("decisions-empty");
    await expect(empty.locator("p").first()).toHaveText("No decisions match “zzzz”.");
    await expect(empty).not.toContainText("Search:");
  });

  test("qa-company-28: Kind, State and From are all chips on a desktop", async ({ page }) => {
    await login(page);
    await page.goto("/company/decisions?state=all");
    const filters = page.getByTestId("decision-filters");
    await expect(group(page, "Kind")).toBeVisible();
    await expect(group(page, "State")).toBeVisible();
    await expect(group(page, "From")).toBeVisible();
    await expect(filters.getByRole("combobox")).toHaveCount(0);
    await expect(group(page, "From").getByRole("button", { name: "Anywhere" })).toHaveAttribute("aria-pressed", "true");
    await group(page, "Kind").getByRole("button", { name: /^All kinds/ }).click();
    await group(page, "From").getByRole("button", { name: "Pushback overrides" }).click();
    await expect(page).toHaveURL(/from=pushback_override/);
    await expect(group(page, "From").getByRole("button", { name: "Pushback overrides" })).toHaveAttribute("aria-pressed", "true");
    await expect(rows(page)).toHaveCount(1);
    await group(page, "From").getByRole("button", { name: "Anywhere" }).click();
    await expect(page).not.toHaveURL(/from=/);
  });

  test("qa-company-29: Reassign opens with no approver picked, never the current one, and waits for a pick", async ({ page }) => {
    await openCaps(page);
    await inspector(page).getByTestId("decision-actions").getByRole("button", { name: "Reassign", exact: true }).click();
    const form = inspector(page).getByRole("form", { name: "Reassign" });
    const pick = form.getByLabel("New approver");
    await expect(pick).toHaveValue("");
    await expect(pick.locator("option", { hasText: APPROVER })).toHaveCount(0);
    const submit = form.getByRole("button", { name: "Reassign", exact: true });
    await expect(submit).toBeDisabled();
    await pick.selectOption({ label: "Admin · admin@example.com" });
    await expect(submit).toBeEnabled();
    await form.getByLabel("Reason").fill("Approver is away this week");
    await submit.click();
    await expect(form).toHaveCount(0);
    await expect(inspector(page).getByTestId("decision-actions")).toBeVisible();
  });

  test("qa-company-30: a viewer never sees Needs me, even from a link", async ({ page }) => {
    await login(page, VIEWER);
    await page.goto("/company/decisions?state=needs_me");
    await expect(page).toHaveURL(/\/company\/decisions/);
    await expect(group(page, "State").getByRole("button", { name: /^Any state/ })).toHaveAttribute("aria-pressed", "true");
    await expect(group(page, "State").getByRole("button", { name: /^Needs me/ })).toHaveCount(0);
    await expect(row(page, CAPS)).toBeVisible();
  });

  test("qa-company-30: an approver still has Needs me", async ({ page }) => {
    await login(page, APPROVER);
    await page.goto("/company/decisions");
    await expect(group(page, "State").getByRole("button", { name: /^Needs me/ })).toHaveAttribute("aria-pressed", "true");
  });

  test("qa-company-31: where a decision came from is a line of meta, not a chip", async ({ page }) => {
    await openCaps(page);
    await expect(inspector(page)).not.toContainText("Recorded by hand");
    await expect(inspector(page).getByTestId("decision-origin")).toHaveText("Added by Commenter");
    await row(page, PUBLISH).click();
    await expect(inspector(page)).toContainText(PUBLISH);
    await expect(inspector(page).getByTestId("decision-origin")).toHaveText("Recorded when a version was published");
    await expect(inspector(page)).not.toContainText("A published version");
  });
});

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("qa-company-46: Propose decision is a full-width sheet with one scrollbar", async ({ page }) => {
    await login(page);
    await page.goto("/company/decisions?state=all");
    await expect(rows(page).first()).toBeVisible();
    await page.getByRole("button", { name: "Propose decision" }).click();
    const dialog = page.getByRole("dialog", { name: "Propose decision" });
    await expect(dialog).toBeVisible();
    // The page under it does not scroll: no page scrollbar beside the dialog's own.
    const page_ = await page.evaluate(() => ({
      overflow: getComputedStyle(document.documentElement).overflow,
      client: document.documentElement.clientWidth,
      inner: window.innerWidth,
    }));
    expect(page_.overflow).toBe("hidden");
    expect(page_.client).toBe(page_.inner);
    const box = (await dialog.boundingBox())!;
    expect(box.x).toBeLessThanOrEqual(1);
    // At most the dialog's own scrollbar to its right.
    expect(390 - (box.x + box.width)).toBeLessThanOrEqual(16);
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toHaveCount(0);
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).overflow)).not.toBe("hidden");
  });
});
