import { MOCK_SLOW_KEY, MOCK_SLOW_MS_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";
import { expect, test } from "./test";

/**
 * A visual QA of production found Simple Home, Decisions and Meetings off in four ways. Driven
 * through the UI on the mock's invented data (lib/api/mock), desktop and phone.
 *
 * Card inbox-agrees: protects = an "Add predictions" row in the Inbox's Needs you (Plan ›
 * Outcomes) waits on Home too, in "Also waiting for you" with its Open link, and on Decisions'
 * "Waiting for you"; fails_when = Home says nothing waits while the Inbox shows it;
 * no_claim = the API's list (pytest test_simple_waiting_read_budget.py).
 *
 * Card waiting-prompt: protects = with the waiting list and the decisions list both slow, the
 * rail's read of the list is shared by Decisions' "Waiting for you" once it arrives, so the
 * section shows its rows without a second wait; fails_when = it sits on "Loading what waits on
 * you…" while a second read of the list is made.
 *
 * Card unique-codes: protects = every decision on the Decisions list reads with a code unique
 * in the list (the decision's D- number, upper case) beside its name; fails_when = a PRD's own
 * per-run code (Q8) shows, which repeats across PRDs' runs.
 *
 * Card info-tips: protects = the explanation lines of Meetings and Decisions sit behind an (i)
 * beside the heading; fails_when = they show under the heading.
 */

for (const phone of [false, true]) {
  test.describe(phone ? "phone" : "desktop", () => {
    test.use({ viewport: phone ? { width: 390, height: 844 } : { width: 1440, height: 900 } });

    test("inbox-agrees: Add predictions waits on Home and Decisions as in the Inbox", async ({ page }) => {
      await page.addInitScript(() => localStorage.setItem("po-mock-scenario", "outcomes"));
      await login(page);
      await page.goto("/inbox");
      await expect(page.getByTestId("inbox-needs").getByTestId("outcome-need").filter({ hasText: /^Add predictions · / }).first()).toBeVisible();
      await page.goto("/simple");
      const row = page.getByTestId("home-also-waiting").getByRole("listitem", { name: /^Inbox: Add predictions · .* · 1 item$/ });
      await expect(row).toBeVisible();
      await expect(page.getByText("Nothing waits on you today.")).toHaveCount(0);
      await expect(row.getByRole("link", { name: "Open" })).toHaveAttribute("href", /^\/plan\/outcomes\?outcome=/);
      await page.goto("/simple/decisions");
      await expect(page.getByTestId("questions-mine").getByRole("listitem", { name: /^Inbox: Add predictions · / })).toBeVisible();
    });

    test("waiting-prompt: Decisions' Waiting for you shows its rows without a second wait", async ({ page }) => {
      await page.addInitScript(
        ([key, msKey]) => {
          localStorage.setItem(key, "/v1/simple/decisions*");
          localStorage.setItem(msKey, "3000");
        },
        [MOCK_SLOW_KEY, MOCK_SLOW_MS_KEY],
      );
      await login(page);
      await page.goto("/simple/decisions");
      const mine = page.getByTestId("questions-mine");
      await expect(mine).toBeVisible({ timeout: 10_000 });
      // The rail's read answered with the page's own list: its rows (the run stops, dates, ...)
      // show with no second 3 s wait for it.
      await expect(mine.getByTestId("waiting-item").first()).toBeVisible({ timeout: 1_500 });
      await expect(mine.getByText("Loading what waits on you…")).toHaveCount(0);
    });

    test("unique-codes: every decision on the list has a code unique in the list, upper case, beside its name", async ({ page }) => {
      await login(page);
      await page.goto("/simple/decisions");
      await expect(page.getByTestId("questions-mine").getByTestId("question-row").first()).toBeVisible();
      await expect(page.getByTestId("decision-row").first()).toBeVisible();
      const codes = await page.getByTestId("simple-page").locator("[data-testid=question-code], [data-testid=decision-code]").filter({ visible: true }).allTextContents();
      expect(codes.length).toBeGreaterThan(3);
      for (const c of codes) expect(c.trim()).toMatch(/^D-\d+$/);
      expect(new Set(codes.map((c) => c.trim())).size).toBe(codes.length);
      // The name stays beside the code; the PRD's own code is in the chip's tooltip.
      const first = page.getByTestId("questions-mine").getByTestId("question-row").first();
      await expect(first.getByTestId("question-code")).toHaveAttribute("title", / Q\d+$/);
      await expect(first.getByTestId("question-open").or(first.locator("b")).first()).not.toBeEmpty();
    });

    test("info-tips: Meetings' and Decisions' explanations sit behind the (i) beside the heading", async ({ page }) => {
      await login(page);
      await page.goto("/simple/meetings");
      const meetings = page.getByText("Start a review of a PRD, join the one that is on, and read past minutes.");
      await expect(page.getByTestId("page-info")).toBeVisible();
      await expect(meetings).toBeHidden();
      await page.getByTestId("page-info").click();
      await expect(meetings).toBeVisible();
      await expect(page.getByRole("tooltip")).toContainText("Times are in Pacific Time (Los Angeles).");

      await page.goto("/simple/decisions");
      const decisions = page.getByText(/^What waits for you, soonest first\./);
      await expect(page.getByTestId("page-info")).toBeVisible();
      await expect(decisions).toBeHidden();
      await page.getByTestId("page-info").click();
      await expect(decisions).toBeVisible();
      await expect(page.getByRole("tooltip")).toContainText("Dates are in Pacific Time (Los Angeles).");
    });
  });
}
