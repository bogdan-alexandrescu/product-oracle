import { expect, test, type Page } from "./test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";

/*
 * QA pass 4 on the run review page, /runs/<id>/review/<checkpoint> (qa-work-1, 6, 9, 11 to 17),
 * driven through the UI on the mock's "feature-set" scenario: the Saved addresses PRD run
 * waiting at its feature set (Bulk address edit depends on the left-out Shared address book
 * export and serves no goal; Saved addresses is new and serves a goal not in the baseline).
 */

const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };

async function seeded(page: Page) {
  await page.addInitScript(([key, value]) => localStorage.setItem(key, value), [MOCK_SCENARIO_KEY, "feature-set"] as const);
  await login(page);
}

/** Runs › Saved addresses PRD › Review feature set, as a person goes there. */
async function openReview(page: Page) {
  await page.goto("/runs");
  await page.locator('[data-testid="run-row"][data-document="saved-addresses"]').filter({ visible: true }).getByRole("link").first().click();
  await expect(page).toHaveURL(/\/runs\/[0-9a-f-]+$/);
  await page.getByTestId("segment-feature_set").getByRole("link", { name: "Review feature set" }).click();
  await expect(page).toHaveURL(/\/runs\/[0-9a-f-]+\/review\/[0-9a-f-]+/);
  await expect(page.getByTestId("scope-row").first()).toBeVisible();
}

const row = (page: Page, title: string) => page.getByTestId("scope-row").filter({ has: page.getByTestId("feature-title").filter({ hasText: new RegExp(`^${title}$`) }) });
const inspector = (page: Page) => page.getByTestId("scope-inspector").filter({ visible: true });
const bar = (page: Page) => page.getByTestId("decision-bar");

test.describe("desktop", () => {
  test.use({ viewport: DESKTOP });

  test("qa-work-1: Send back confirms what goes to the agents and the run counts the entries sent", async ({ page }) => {
    await seeded(page);
    await openReview(page);
    await row(page, "Saved addresses").getByRole("button", { name: "Include", exact: true }).click();
    await expect(row(page, "Saved addresses").getByTestId("row-done")).toContainText("✓ Included");
    await row(page, "Bulk address edit").getByRole("button", { name: "Include dependency" }).click();
    await expect(bar(page).getByTestId("staged-chip")).toHaveCount(2);

    await bar(page).getByRole("button", { name: "Send back to agents" }).click();
    const sheet = page.getByTestId("sheet-send-back");
    await expect(sheet).toBeVisible();
    await expect(sheet).toContainText("The agents get 1 change: Shared address book export: included.");
    await expect(sheet).toContainText("Not sent: Saved addresses: included");
    await expect(sheet.getByTestId("send-back-note")).toContainText("No note to the agents");
    // Cancel sends nothing.
    await sheet.getByRole("button", { name: "Cancel" }).click();
    await expect(sheet).toBeHidden();
    await expect(page).toHaveURL(/\/review\//);

    await bar(page).getByRole("button", { name: "Send back to agents" }).click();
    await sheet.getByRole("button", { name: "Send back", exact: true }).click();
    await expect(page).toHaveURL(/\/runs\/[0-9a-f-]+$/);
    await expect(page.getByTestId("sent-review").first()).toContainText("Sent back · 1 entry");
  });

  test("qa-work-6: a review of a missing run shows Run not found, never the id", async ({ page }) => {
    await seeded(page);
    const id = "7a11c0de-dead-4000-8000-00000000beef";
    await page.goto(`/runs/${id}/review/00000000-0000-4000-8000-000000000000`);
    const panel = page.getByTestId("run-not-found");
    await expect(panel).toBeVisible();
    await expect(page.getByRole("heading", { level: 1, name: "Run not found" })).toBeVisible();
    await expect(panel).toContainText("This run doesn't exist or was deleted.");
    await expect(page.locator("main")).not.toContainText(id);
    await page.getByRole("link", { name: "Back to Runs" }).click();
    await expect(page).toHaveURL(/\/runs$/);
  });

  test("qa-work-9: the inspector offers the feature's decision once, in one vocabulary", async ({ page }) => {
    await seeded(page);
    await openReview(page);
    await row(page, "Saved addresses").getByTestId("feature-title").click();
    const card = inspector(page).getByTestId("reason-new_feature");
    await expect(card).toBeVisible();
    for (const name of ["Include", "Keep", "Leave out"]) await expect(card.getByRole("button", { name, exact: true })).toHaveCount(0);
    const decision = inspector(page).getByRole("group", { name: "Decision" });
    for (const name of ["Include", "Leave out", "Defer to a later PRD"]) await expect(decision.getByRole("button", { name, exact: true })).toBeVisible();
    await expect(inspector(page).getByRole("button", { name: "Keep", exact: true })).toHaveCount(0);
    await decision.getByRole("button", { name: "Include", exact: true }).click();
    await expect(row(page, "Saved addresses").getByTestId("row-done")).toContainText("✓ Included");
    await expect(bar(page).getByTestId("staged-chip").filter({ hasText: "Saved addresses: included" })).toBeVisible();
    await expect(decision.getByRole("button", { name: "Include", exact: true })).toHaveAttribute("aria-pressed", "true");
  });

  test("qa-work-11: a long goal name ends in an ellipsis with the full name on hover", async ({ page }) => {
    await seeded(page);
    await openReview(page);
    const chip = row(page, "Saved addresses").getByTestId("goal-chip");
    await expect(chip).toHaveAttribute("title", "A goal not in the baseline");
    const fits = await chip.evaluate((el) => {
      const text = el.querySelector("span") as HTMLElement;
      const cell = el.parentElement!.getBoundingClientRect();
      const box = el.getBoundingClientRect();
      return { ellipsis: getComputedStyle(text).textOverflow === "ellipsis", inside: box.right <= cell.right + 1 };
    });
    expect(fits).toEqual({ ellipsis: true, inside: true });
  });

  test("qa-work-12: the dependency fix is a short one-line button; the reason chip names the dependency", async ({ page }) => {
    await seeded(page);
    await openReview(page);
    const bulk = row(page, "Bulk address edit");
    await expect(bulk.getByTestId("row-reasons")).toContainText("Depends on Shared address book export, left out");
    const fix = bulk.getByTestId("your-call").getByRole("button", { name: "Include dependency" });
    await expect(fix).toHaveAttribute("title", "Include Shared address book export");
    const buttons = bulk.getByTestId("your-call").getByRole("button");
    for (const b of await buttons.all()) {
      const one = await b.evaluate((el) => ({ fits: el.scrollWidth <= el.clientWidth + 1, nowrap: getComputedStyle(el).whiteSpace === "nowrap", h: el.getBoundingClientRect().height }));
      expect(one.fits).toBe(true);
      expect(one.nowrap).toBe(true);
      expect(one.h).toBeLessThanOrEqual(40);
    }
  });

  test("qa-work-13: a handled row stays under its heading, its ✓ on the row", async ({ page }) => {
    await seeded(page);
    await openReview(page);
    const group = page.getByRole("rowgroup", { name: "A goal not in the baseline" });
    await expect(group.getByTestId("feature-title").filter({ hasText: /^Saved addresses$/ })).toBeVisible();
    await row(page, "Saved addresses").getByRole("button", { name: "Include", exact: true }).click();
    await expect(group.getByTestId("row-done")).toContainText("✓ Included");
    await expect(page.getByRole("rowgroup", { name: /^Nothing/ })).toHaveCount(0);

    await page.getByRole("group", { name: "Group by" }).getByRole("button", { name: "Reason" }).click();
    const byReason = page.getByRole("rowgroup", { name: "New, not in the baseline" });
    await expect(byReason.getByTestId("feature-title").filter({ hasText: /^Saved addresses$/ })).toBeVisible();
    await expect(byReason.getByTestId("row-done")).toContainText("✓ Included");
    await expect(page.getByRole("rowgroup", { name: /^Nothing/ })).toHaveCount(0);
  });

  test("qa-work-14: including a dependency says why it needs you; Approve counts the staged list", async ({ page }) => {
    await seeded(page);
    await openReview(page);
    await row(page, "Saved addresses").getByRole("button", { name: "Include", exact: true }).click();
    await row(page, "Bulk address edit").getByRole("button", { name: "Include dependency" }).click();
    await expect(bar(page).getByTestId("tally-brought-back")).toContainText("Shared address book export is included now and needs you: no confirmed goal");
    await expect(bar(page).getByTestId("staged-chip")).toHaveCount(2);
    await expect(bar(page).getByRole("button", { name: "Approve with 2 edits" })).toBeVisible();
  });

  test("qa-work-15: a row with no goal shows one chip for it", async ({ page }) => {
    await seeded(page);
    await openReview(page);
    const bulk = row(page, "Bulk address edit");
    await expect(bulk.getByTestId("row-reasons")).toContainText("No confirmed goal");
    await expect(bulk).not.toContainText("No goal");
  });

  test("qa-work-16: headers and the proposal read as words", async ({ page }) => {
    await seeded(page);
    await openReview(page);
    await expect(page.getByRole("columnheader", { name: "Confidence", exact: true })).toHaveText("Confidence");
    await expect(page.getByRole("columnheader", { name: "Requirements", exact: true })).toHaveText("Requirements");
    await row(page, "Saved addresses").getByTestId("feature-title").click();
    await expect(inspector(page)).toContainText("Oracle proposes: Include");
    await expect(page.locator("main")).not.toContainText("Proposed: include");
  });

  test("qa-work-17: the review's way back is the run page's arrow link, to the run", async ({ page }) => {
    await seeded(page);
    await openReview(page);
    const runUrl = page.url().replace(/\/review\/.*$/, "");
    const back = page.getByTestId("run-name");
    await expect(back).toHaveText("Saved addresses PRD · Baseline to PRD");
    await expect(back.locator("svg")).toHaveCount(1);
    await expect(page.locator("main")).not.toContainText("Runs /");
    await back.click();
    await expect(page).toHaveURL(runUrl);
  });
});

test.describe("phone", () => {
  test.use({ viewport: PHONE });

  test("qa-work-6: Run not found on a phone", async ({ page }) => {
    await seeded(page);
    await page.goto("/runs/7a11c0de-dead-4000-8000-00000000beef/review/00000000-0000-4000-8000-000000000000");
    await expect(page.getByTestId("run-not-found")).toBeVisible();
    await expect(page.locator("main")).not.toContainText("7a11c0de");
  });

  test("qa-work-12/17: the dependency fix fits the card on one line and the back link wraps inside the page", async ({ page }) => {
    await seeded(page);
    await openReview(page);
    const fix = row(page, "Bulk address edit").getByRole("button", { name: "Include dependency" });
    await expect(fix).toBeVisible();
    expect(await fix.evaluate((el) => el.scrollWidth <= el.clientWidth + 1 && el.getBoundingClientRect().right <= window.innerWidth)).toBe(true);
    const back = page.getByTestId("run-name");
    await expect(back).toBeVisible();
    expect(await back.evaluate((el) => el.getBoundingClientRect().right <= window.innerWidth)).toBe(true);
  });

  test("qa-work-1: on a phone, Send back from the decide sheet confirms first", async ({ page }) => {
    await seeded(page);
    await openReview(page);
    await row(page, "Bulk address edit").getByRole("button", { name: "Include dependency" }).click();
    await expect(bar(page).getByRole("button")).toContainText("1 change");
    await bar(page).getByRole("button").click();
    await page.getByTestId("sheet-decide").getByRole("button", { name: "Send back to agents" }).click();
    const sheet = page.getByTestId("sheet-send-back");
    await expect(sheet).toContainText("The agents get 1 change: Shared address book export: included.");
    await sheet.getByRole("button", { name: "Send back", exact: true }).click();
    await expect(page).toHaveURL(/\/runs\/[0-9a-f-]+$/);
    await expect(page.getByTestId("sent-review").first()).toContainText("Sent back · 1 entry");
  });
});
