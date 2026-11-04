import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";
import { expect, test, type Page } from "./test";

/*
 * Bring a date in, then the roadmap follows: once the re-plan is approved, the PRD's items on the
 * Help desk roadmap take their new dates on Simple Roadmap's Now / Next / Later board, its Gantt
 * and Priorities, and an item the re-plan sliced (Thread summary card's first slice, Jan 8) says
 * "Estimate pending" on each. Driven through the UI against the mock's "fit-date" scenario
 * (invented data: Larkspur Help Desk's Reply faster in the shared inbox).
 */

const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true };

async function open(page: Page) {
  await page.context().addInitScript(([key, value]) => localStorage.setItem(key, value), [MOCK_SCENARIO_KEY, "fit-date"] as const);
  await login(page);
  await page.goto("/simple/roadmap");
  await expect(page.getByTestId("fit-goal")).toBeVisible();
}

/** Ticks Oracle's own pick (it slices Thread summary card), drafts it and approves both. */
async function approvePick(page: Page) {
  await page.getByRole("button", { name: "Bring this date in" }).click();
  const panel = page.getByTestId("fit-panel");
  await expect(panel).toBeVisible();
  await expect(page.getByTestId("fit-change-summary").getByRole("checkbox")).toBeChecked();
  await page.getByRole("button", { name: "Draft 5 changes" }).click();
  await expect(panel).toContainText("Check the new drafts");
  await page.getByRole("button", { name: "Approve both", exact: true }).click();
  await expect(panel).toBeHidden();
  await expect(page.getByTestId("fit-approved")).toContainText("M2 lands Jan 25.");
}

const boardCard = (page: Page, title: string) => page.getByTestId("board-card").filter({ hasText: title });

test.describe("desktop", () => {
  test("an approved re-plan moves the PRD's items on the board, the Gantt and Priorities", async ({ page }) => {
    await open(page);
    // Before: the item sits on the Help desk roadmap on its old date, with no pending estimate.
    await page.getByTestId("format-board").click();
    await expect(boardCard(page, "Thread summary card")).toContainText("Jan 22");
    await expect(boardCard(page, "Thread summary card")).not.toContainText("Estimate pending");
    await expect(boardCard(page, "Reply to similar threads at once")).toContainText("Feb 12");

    await approvePick(page);

    // The Roadmap, opened again: the board reads the new dates.
    await page.goto("/simple/roadmap");
    await page.getByTestId("format-board").click();
    const summary = boardCard(page, "Thread summary card");
    await expect(summary).toContainText("Jan 8");
    await expect(summary).not.toContainText("Jan 22");
    await expect(summary).toContainText("Estimate pending");
    await expect(boardCard(page, "Reply to similar threads at once")).toContainText("Mar 19");
    await expect(boardCard(page, "Reply to similar threads at once")).not.toContainText("Estimate pending");
    await expect(boardCard(page, "Reply time chart")).toContainText("Mar 5");

    // The Gantt: the same item says its estimate is pending, its bar ends Jan 8.
    await page.getByTestId("format-gantt").click();
    const label = page.getByTestId("chart-label").filter({ hasText: "Thread summary card" });
    await expect(label).toContainText("Estimate pending");
    await expect(page.getByRole("button", { name: /^Thread summary card: .*Jan 8/ })).toHaveAttribute("aria-label", /estimate pending/);
    await expect(page.getByTestId("chart-label").filter({ hasText: "Reply to similar threads at once" })).not.toContainText("Estimate pending");

    // Priorities: the moved feature with its new date and the pending estimate.
    await page.getByRole("navigation").getByRole("link", { name: "Priorities" }).click();
    const row = page.getByTestId("prio-row").filter({ hasText: "Thread summary card" });
    await expect(row).toContainText("Ends Jan 8 · Estimate pending");
    await expect(page.getByTestId("prio-row").filter({ hasText: "Reply to similar threads at once" })).not.toContainText("Estimate pending");
  });
});

test.describe("phone", () => {
  test.use(PHONE);

  test("the approved re-plan's new date and pending estimate show on the board and Priorities", async ({ page }) => {
    await open(page);
    await approvePick(page);
    await page.goto("/simple/roadmap");
    await page.getByTestId("format-board").click();
    const summary = boardCard(page, "Thread summary card");
    await expect(summary).toContainText("Jan 8");
    await expect(summary).toContainText("Estimate pending");
    await page.goto("/simple/priorities");
    const row = page.getByTestId("prio-row").filter({ hasText: "Thread summary card" });
    await expect(row).toContainText("Ends Jan 8 · Estimate pending");
    const box = await row.boundingBox();
    expect(box!.width).toBeLessThanOrEqual(390);
  });
});
