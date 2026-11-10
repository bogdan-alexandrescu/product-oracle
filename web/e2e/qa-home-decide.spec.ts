import { MOCK_SCENARIO_KEY } from "../lib/api/mock/ids";
import { MOCK_EMPTY_FEEDBACK_KEY, MOCK_SLOW_KEY, MOCK_SLOW_MS_KEY } from "../lib/api/mock/server";
import { REPEATED_CODES_SCENARIO } from "../lib/api/mock/simple-meetings";
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
 * Card inbox-more: protects = an Inbox row Home does not draw itself (open feedback, for an
 * approver) counts on Home as on the rail and the Inbox: Home reads "A thing in your Inbox waits on you." and
 * one row "1 more in your Inbox" that opens Simple's Inbox, the rail's Inbox count reads 1 and the
 * Inbox says 1 waiting; fails_when = Home says "Nothing waits on you today." while the rail and
 * the Inbox count it.
 *
 * Card waiting-prompt: protects = with the waiting list and the decisions list both slow, the
 * rail's read of the list is shared by Decisions' "Waiting for you" once it arrives, so the
 * section shows its rows without a second wait; fails_when = it sits on "Loading what waits on
 * you…" while a second read of the list is made.
 *
 * Card unique-codes: protects = every decision on the Decisions list reads with a code unique
 * in the list, upper case, beside its name: a PRD's per-run code another decision shares (Q5 and
 * another run's q5) reads as the decision's D- number, its PRD and code in the tooltip; two
 * different decisions with one code and one title read two D- numbers; fails_when = two rows
 * read Q5 or Q9, or q5, or a decided row's tooltip leaves its PRD out.
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

    test("inbox-more: open feedback counts on Home as on the rail and the Inbox", async ({ page }) => {
      await page.addInitScript(
        ([key, value, feedback]) => {
          localStorage.setItem(key, value);
          localStorage.setItem(feedback, "1");
        },
        [MOCK_SCENARIO_KEY, "empty", MOCK_EMPTY_FEEDBACK_KEY] as const,
      );
      await login(page);
      await page.goto("/simple/inbox");
      await expect(page.getByText("1 waiting", { exact: true })).toBeVisible();
      await page.goto("/simple");
      const sentence = page.getByTestId("simple-page").getByTestId("home-sentence");
      await expect(sentence).toHaveText("A thing in your Inbox waits on you.");
      await expect(page.getByText("Nothing waits on you today.")).toHaveCount(0);
      const more = page.getByTestId("home-also-waiting").getByTestId("home-inbox-more");
      await expect(more).toHaveText(/^1 more in your Inbox\s*Open$/);
      if (!phone) await expect(page.getByTestId("simple-nav-inbox-count")).toHaveText("1");
      await more.getByRole("link", { name: "Open" }).click();
      await expect(page).toHaveURL(/\/simple\/inbox$/);
      await expect(page.getByText("1 waiting", { exact: true })).toBeVisible();
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
      // Guided setup's open Q5 and another PRD's run's decided q5 on one list.
      await page.addInitScript((k) => localStorage.setItem("po-mock-scenario", k), REPEATED_CODES_SCENARIO);
      await login(page);
      await page.goto("/simple/decisions");
      await expect(page.getByTestId("questions-mine").getByTestId("question-row").first()).toBeVisible();
      await expect(page.getByTestId("decision-row").filter({ hasText: "Trial length for new teams" })).toBeVisible();
      const codes = (await page.getByTestId("simple-page").locator("[data-testid=question-code], [data-testid=decision-code]").filter({ visible: true }).allTextContents()).map((c) => c.trim());
      expect(codes.length).toBeGreaterThan(3);
      for (const c of codes) expect(c).toBe(c.toUpperCase());
      expect(new Set(codes).size).toBe(codes.length);
      // The two Q5s read by their decision numbers, each beside its name, the PRD's code in the tooltip.
      const q5 = page.getByTestId("questions-mine").getByTestId("question-row").filter({ hasText: "Reminder default time" });
      await expect(q5.getByTestId("question-code")).toHaveText("D-105");
      await expect(q5.getByTestId("question-code")).toHaveAttribute("title", "Guided setup Q5");
      const other = page.getByTestId("decision-row").filter({ hasText: "Trial length for new teams" });
      await expect(other.getByTestId("decision-code")).toHaveText("D-140");
      await expect(other.getByTestId("decision-code")).toHaveAttribute("title", "Team trials Q5");
      // Two different decisions with one code and one title still read two numbers.
      const q9 = page.getByTestId("decision-row").filter({ hasText: "Seat price for teams" });
      await expect(q9.getByTestId("decision-code")).toHaveText(["D-142", "D-141"]);
      // A code no other decision shares keeps it.
      expect(codes.filter((c) => /^Q\d+$/.test(c)).length).toBeGreaterThan(0);
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
