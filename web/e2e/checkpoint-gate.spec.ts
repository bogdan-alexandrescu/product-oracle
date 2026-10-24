import { expect, test, type Page } from "@playwright/test";

import { login, openSeeded, seedConsoleHeld, seedRoadmapReview } from "./helpers";

/**
 * D3 Approve blocked by problems: Approve and continue stays disabled while a blocking reason
 * is open; an approver waives the waivable ones in place (never a date); a console approval
 * given while blocking problems are open is held in the Inbox until they are waived, then
 * confirmed. Driven through the UI over the mock API.
 */

import { CONSOLE_HELD_RUN_ID, ROADMAP_REVIEW_RUN } from "../lib/api/mock/runs";

const RUN = ROADMAP_REVIEW_RUN.run.id;
const CP = ROADMAP_REVIEW_RUN.run.checkpoints[0].id;

const bar = (page: Page) => page.getByTestId("decision-bar");
const row = (page: Page, key: string) => page.locator(`[data-testid="roadmap-item-row"][data-key="${key}"]`);
const decision = (page: Page) => page.getByRole("group", { name: "Decide: Roadmap items" });

/** D1: Roadmap items are decided on their review screen, opened from the run page's Review items. */
async function openReview(page: Page) {
  await page.goto("/runs");
  await page.getByTestId("run-row").filter({ hasText: /usage-alerts-roadmap(?!-)/ }).getByRole("link").first().click();
  await page.getByTestId("items-review-line").getByRole("link", { name: "Review items" }).click();
  await expect(page).toHaveURL(new RegExp(`/runs/${RUN}/review/${CP}$`));
}

async function waive(page: Page, key: string, title: string, reason: string) {
  await row(page, key).getByRole("button", { name: `More actions for ${title}` }).click();
  await page.getByRole("menuitem", { name: "Waive…" }).click();
  await page.getByTestId("roadmap-items-table").getByLabel("Why waive it").fill(reason);
  await page.getByTestId("roadmap-items-table").getByRole("button", { name: "Waive", exact: true }).click();
  await expect(row(page, key).getByTestId("row-done")).toHaveText(/✓ Waived/);
}

// Card gate-list: protects = Approve is disabled while blocking reasons are open, and a waiver
// counts at once; fails_when = Approve is enabled with reasons open, the count does not drop, or
// a date offers Waive…; no_claim = the API's numbers (pytest has them).
test("approve stays disabled with blocking problems; waiving one drops the count; a date is never waived", async ({ page }) => {
  await login(page);
  await seedRoadmapReview(page);
  await openReview(page);
  const approve = bar(page).getByRole("button", { name: /^Approve/ });
  await expect(bar(page).getByTestId("decision-tally")).toContainText("3 blocking left");
  await expect(approve).toBeDisabled();
  await expect(row(page, "slack-alerts")).toContainText("Date unverified");
  await row(page, "slack-alerts").getByRole("button", { name: "More actions for Slack alerts" }).click();
  await expect(page.getByRole("menuitem", { name: "Waive…" })).toHaveCount(0);
  await page.keyboard.press("Escape");

  await waive(page, "usage-export", "Usage export", "Section lands in the next PRD version");
  await expect(bar(page).getByTestId("decision-tally")).toContainText("2 blocking left");
  await expect(approve).toBeDisabled();
});

// Card date-left: protects = with only the date reason left Approve stays disabled, and Send
// back still sends the run back; fails_when = Approve enables, or the send-back is refused;
// no_claim = the agents' re-run.
test("with only the date left approve stays disabled and send back still sends it back", async ({ page }) => {
  await login(page);
  await seedRoadmapReview(page);
  await openReview(page);
  await waive(page, "usage-export", "Usage export", "Section lands in the next PRD version");
  await waive(page, "budget-caps", "Budget caps", "Anomaly detection ships first in practice");
  await expect(bar(page).getByTestId("decision-tally")).toContainText("1 blocking left");
  await expect(bar(page).getByRole("button", { name: /^Approve/ })).toBeDisabled();

  await bar(page).getByLabel("Note to the agents").fill("Remove the Slack alerts date");
  await bar(page).getByRole("button", { name: "Send back to agents" }).click();
  await page.getByTestId("sheet-send-back").getByRole("button", { name: "Send back", exact: true }).click();
  await expect(page.getByTestId("review-status")).toHaveText(/Sent back/);
});

// Card console-run-page: protects = the run page keeps its own console panel for a console
// approval held by blocking problems: its Confirm is held to the same gate, and confirming once
// they are waived approves; fails_when = the panel is gone, Confirm is enabled with the gate
// closed, or confirming does not approve; no_claim = the review screen's Confirm (below).
test("the run page's console Confirm is held to the same gate", async ({ page }) => {
  await login(page);
  await openSeeded(page, seedConsoleHeld, `/runs/${CONSOLE_HELD_RUN_ID}`);
  await expect(decision(page).getByTestId("console-answer")).toContainText("Blocking problems are open: fix or waive them, then confirm");
  const confirm = decision(page).getByRole("button", { name: "Confirm approval" });
  await expect(confirm).toBeDisabled();
  const reason = decision(page).getByTestId("gate-reason").filter({ hasText: "Usage export" });
  await reason.getByRole("button", { name: "Waive…" }).click();
  await reason.getByRole("textbox").fill("Section lands in the next PRD version");
  await reason.getByRole("button", { name: "Waive", exact: true }).click();
  await expect(confirm).toBeEnabled();
  await confirm.click();
  await expect(page.getByTestId("segment-roadmap_items").getByTestId("checkpoint-roadmap_items")).toContainText("Approved");
});

// Card console-held: protects = a console approval held by open blocking problems shows in
// the Inbox as held with Review, Confirm stays disabled until they are waived, and confirming
// moves the run on and clears the row; fails_when = the row is missing or reads Decide,
// Confirm is enabled with the gate closed, or the row stays after confirming; no_claim = the
// runtime's real console.
test("a console approval held by blocking problems is confirmed once they are waived", async ({ page }) => {
  await login(page);
  await openSeeded(page, seedConsoleHeld, "/inbox");
  const badge = page.getByTestId("nav-inbox-badge");
  const before = Number(await badge.textContent());
  // D9's counted row names the roadmap and its PRD, not the run's document slug.
  const row = page.locator("tr[data-row]").filter({ hasText: "console approval held" }).filter({ visible: true });
  await expect(row).toHaveCount(1);
  await expect(row).toContainText("Console approval held");
  await expect(row).toContainText("Blocking problems are open: fix or waive them, then confirm");
  // D1: Review opens the Roadmap items review screen, where C7's decision bar holds the
  // console approval as Confirm until the blocking problem is waived.
  await row.getByRole("link", { name: "Review" }).click();
  const bar = page.getByTestId("decision-bar");
  const confirm = bar.getByRole("button", { name: "Confirm" });
  await expect(bar.getByTestId("console-held")).toContainText("Approved in the console: blocking problems are open: fix or waive them, then confirm");
  await expect(confirm).toBeDisabled();
  await expect(confirm).toHaveAttribute("title", "1 blocking problem left");
  await waive(page, "usage-export", "Usage export", "Section lands in the next PRD version");
  await expect(confirm).toBeEnabled();
  await confirm.click();
  await expect(page.getByTestId("review-status")).toHaveText("Approved");

  await page.goto("/inbox");
  await expect(badge).toHaveText(String(before - 1));
  await expect(page.locator("tr[data-row]").filter({ hasText: "console approval held" })).toHaveCount(0);
});
