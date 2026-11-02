import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";
import { expect, test, type Page } from "./test";

/**
 * build-rundecide RD1 a "A Runs group": Simple › Decisions lists a run's stops in a Runs card
 * after the meetings, one block per run; each stop is a row with its outcome, the note, the
 * person's name and role, and the day. A stop sent back and then approved is one row that opens
 * to show both steps. Driven through the UI on the mock's invented data
 * (lib/api/mock/runs.ts seedRunDecisions), desktop and phone.
 *
 * Card decisions-runs: protects = the Runs card comes after the meetings and before "Outside
 * meetings", its run block reads "Usage alerts plan · Usage alerts PRD · 5 decisions", each stop
 * row names who decided it with their role and day, never "approved by an owner"; "Show what
 * happened" opens the sent-back step and "Hide what happened" folds it; four runs are four
 * blocks; fails_when = the card is missing, a stop is split in two or loses its name, note or
 * day; no_claim = the run's own page (run-decisions.spec.ts).
 *
 * Card run-dates-changed: protects = a Dates stop approved after the approver changed one date
 * reads "Dates: approved with one date changed"; a Dates stop with no date changed still reads
 * "Dates: approved"; fails_when = the dates the approval changed are not counted; no_claim = how
 * the dates are changed at the stop (eng-dates.spec.ts).
 */

async function open(page: Page, scenario: string) {
  await page.addInitScript(([key, s]) => localStorage.setItem(key, s), [MOCK_SCENARIO_KEY, scenario] as const);
  await login(page);
  await page.goto("/simple/decisions");
}

for (const phone of [false, true]) {
  test.describe(phone ? "phone" : "desktop", () => {
    test.use({ viewport: phone ? { width: 390, height: 844 } : { width: 1440, height: 900 } });

    test("a run's stops are one block in the Runs card, after the meetings", async ({ page }) => {
      await open(page, "run-decisions");
      const runs = page.getByRole("region", { name: "Runs" });
      await expect(runs.getByRole("heading", { name: "Runs" })).toBeVisible();
      await expect(runs).toContainText("Stops people approved while Oracle drafted a plan");
      // After the meetings, before the decisions taken outside them.
      const order = await page.locator("section.simple-card").evaluateAll((xs) => xs.map((x) => x.getAttribute("aria-label")));
      expect(order.indexOf("Runs")).toBeGreaterThan(order.indexOf("Review: Usage alerts"));
      expect(order.indexOf("Runs")).toBeLessThan(order.indexOf("Outside meetings"));

      const block = runs.getByTestId("decisions-run");
      await expect(block).toHaveCount(1);
      await expect(block.getByRole("heading", { level: 3 })).toHaveText("Usage alerts plan · Usage alerts PRD · 5 decisions");
      const rows = block.getByTestId("run-stop-row");
      await expect(rows).toHaveCount(5);
      await expect(rows.nth(0)).toContainText("Feature set: approved");
      await expect(rows.nth(0)).toContainText("Keep the weekly digest; leave text messages for later. · Avery Stone (owner) · Tue Oct 20");
      await expect(rows.nth(1)).toContainText("Engineering check: approved after a change");
      await expect(rows.nth(1)).toContainText("Quiet hours now follow each workspace's time zone. · Priya Raman (approver) · Thu Oct 22");
      await expect(rows.nth(2)).toContainText("Order: approved");
      await expect(rows.nth(2)).toContainText("Avery Stone (owner) · Thu Oct 22");
      await expect(rows.nth(3)).toContainText("PRD review: approved");
      await expect(rows.nth(3)).toContainText("Good to build from version 3. · Priya Raman (approver) · Mon Oct 26");
      await expect(rows.nth(4)).toContainText("Dates: approved with one date changed");
      await expect(rows.nth(4)).toContainText("Weekly alert digest moved from Nov 20 to Dec 4. · Avery Stone (owner) · Tue Oct 27");
      await expect(runs).not.toContainText("approved by an owner");

      // The sent-back stop opens to its two steps, then folds again.
      const check = rows.nth(1);
      await check.getByRole("button", { name: "Sent back once, then approved. Show what happened" }).click();
      const steps = check.getByRole("list", { name: "What happened" });
      await expect(steps).toContainText("Sent back by Priya Raman · Wed Oct 21");
      await expect(steps).toContainText("“Quiet hours need a time zone per workspace, not one for the company.”");
      await expect(steps).toContainText("Approved by Priya Raman · Thu Oct 22");
      await expect(steps.getByRole("link", { name: "Open Usage alerts PRD" })).toHaveAttribute("href", "/simple/one-pagers/usage-alerts");
      await check.getByRole("button", { name: "Hide what happened" }).click();
      await expect(steps).toHaveCount(0);
      await expect(check.getByRole("button", { name: /Show what happened/ })).toBeVisible();
      if (phone) {
        const box = await runs.boundingBox();
        expect(box!.width).toBeLessThanOrEqual(390);
      }
    });

    test("a Dates stop approved after a date edit says how many dates changed", async ({ page }) => {
      await open(page, "run-decisions-many");
      const runs = page.getByRole("region", { name: "Runs" });
      const usage = runs.getByTestId("decisions-run").filter({ hasText: "Usage alerts plan" });
      const changed = usage.getByTestId("run-stop-row").filter({ hasText: "Dates:" });
      await expect(changed.locator("b")).toHaveText("Dates: approved with one date changed");
      await expect(changed).toContainText("Weekly alert digest moved from Nov 20 to Dec 4. · Avery Stone (owner) · Tue Oct 27");
      // A Dates stop whose dates were taken as proposed reads as before.
      const carts = runs.getByTestId("decisions-run").filter({ hasText: "Saved carts plan" });
      await expect(carts.getByTestId("run-stop-row").filter({ hasText: "Dates:" }).locator("b")).toHaveText("Dates: approved");
      // Only the dates stop counts date edits.
      await expect(runs.getByText(/date changed|dates changed/)).toHaveCount(1);
      if (phone) {
        const box = await changed.boundingBox();
        expect(box!.x + box!.width).toBeLessThanOrEqual(390);
      }
    });

    test("many runs: one block each", async ({ page }) => {
      await open(page, "run-decisions-many");
      const runs = page.getByRole("region", { name: "Runs" });
      const blocks = runs.getByTestId("decisions-run");
      await expect(blocks).toHaveCount(4);
      await expect(blocks.getByRole("heading", { level: 3 })).toHaveText([
        "Checkout redesign plan · Checkout redesign PRD · 4 decisions",
        "Team workspaces plan · Team workspaces PRD · 3 decisions",
        "Usage alerts plan · Usage alerts PRD · 5 decisions",
        "Saved carts plan · Saved carts PRD · 5 decisions",
      ]);
      await expect(runs.getByTestId("run-stop-row")).toHaveCount(17);
      // The meetings above keep their place.
      await expect(page.locator("section.simple-card").first()).not.toHaveAttribute("aria-label", "Runs");
    });
  });
}
