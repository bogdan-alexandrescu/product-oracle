import { expect, test, type Page } from "@playwright/test";

import { login, seedConsoleHeld, seedRoadmapReview } from "./helpers";

/**
 * D3 Approve blocked by problems: Approve and continue stays disabled while a blocking reason
 * is open; an approver waives the waivable ones in place (never a date); a console approval
 * given while blocking problems are open is held in the Inbox until they are waived, then
 * confirmed. Driven through the UI over the mock API.
 */

/** Opens a seeded run from the runs list by its document, as a person would. */
async function openRun(page: Page, slug: string) {
  await page.goto("/runs");
  await page.getByTestId("run-row").filter({ hasText: new RegExp(`${slug}(?!-)`) }).getByRole("link").first().click();
  await expect(page.getByRole("heading", { level: 1, name: "Roadmap from an approved PRD" })).toBeVisible();
}

const decision = (page: Page) => page.getByRole("group", { name: "Decide: Roadmap items" });

async function waive(page: Page, title: string, reason: string) {
  const row = decision(page).getByTestId("gate-reason").filter({ hasText: title });
  await row.getByRole("button", { name: "Waive…" }).click();
  await row.getByRole("textbox").fill(reason);
  await row.getByRole("button", { name: "Waive", exact: true }).click();
}

// Card gate-list: protects = Approve is disabled with the blocking reasons listed, and a
// waiver from the list counts at once; fails_when = Approve is enabled with reasons open, the
// count does not drop, or a date offers Waive…; no_claim = the API's numbers (pytest has them).
test("approve stays disabled with blocking problems; waiving one drops the count; a date is never waived", async ({ page }) => {
  await login(page);
  await seedRoadmapReview(page);
  await openRun(page, "usage-alerts-roadmap");
  const approve = decision(page).getByRole("button", { name: "Approve and continue" });
  const gate = decision(page).getByTestId("approve-gate");
  await expect(gate).toContainText("3 blocking problems left: fix or waive them, or send back to the agents.");
  await expect(approve).toBeDisabled();
  await expect(gate.getByTestId("gate-reason")).toHaveCount(3);
  await expect(gate.getByTestId("gate-reason").filter({ hasText: "Slack alerts" })).toContainText("Date unverified");
  await expect(gate.getByTestId("gate-reason").filter({ hasText: "Slack alerts" }).getByRole("button", { name: "Waive…" })).toHaveCount(0);

  await waive(page, "Usage export", "Section lands in the next PRD version");
  await expect(gate).toContainText("2 blocking problems left");
  await expect(gate.getByTestId("gate-reason")).toHaveCount(2);
  await expect(approve).toBeDisabled();
});

// Card date-left: protects = with only the date reason left Approve stays disabled, and
// Request changes still sends the run back; fails_when = Approve enables, or the send-back is
// refused; no_claim = the agents' re-run.
test("with only the date left approve stays disabled and request changes still sends it back", async ({ page }) => {
  await login(page);
  await seedRoadmapReview(page);
  await openRun(page, "usage-alerts-roadmap");
  await waive(page, "Usage export", "Section lands in the next PRD version");
  await waive(page, "Budget caps", "Anomaly detection ships first in practice");
  const gate = decision(page).getByTestId("approve-gate");
  await expect(gate).toContainText("1 blocking problem left");
  await expect(gate.getByTestId("gate-reason")).toHaveText([/Slack alerts\s*Date unverified/]);
  await expect(decision(page).getByRole("button", { name: "Approve and continue" })).toBeDisabled();

  await decision(page).getByLabel("Note for the agents").fill("Remove the Slack alerts date");
  await decision(page).getByRole("button", { name: "Request changes" }).click();
  await expect(page.getByTestId("segment-roadmap_items").getByTestId("checkpoint-roadmap_items")).toContainText("Changes requested");
});

// Card console-held: protects = a console approval held by open blocking problems shows in
// the Inbox as held with Review, Confirm stays disabled until they are waived, and confirming
// moves the run on and clears the row; fails_when = the row is missing or reads Decide,
// Confirm is enabled with the gate closed, or the row stays after confirming; no_claim = the
// runtime's real console.
test("a console approval held by blocking problems is confirmed once they are waived", async ({ page }) => {
  await login(page);
  await seedConsoleHeld(page);
  await page.goto("/inbox");
  const badge = page.getByTestId("nav-inbox-badge");
  const before = Number(await badge.textContent());
  const row = page.locator("tr[data-row]").filter({ hasText: "usage-alerts-roadmap-2" }).filter({ visible: true });
  await expect(row).toHaveCount(1);
  await expect(row).toContainText("Console approval held");
  await expect(row).toContainText("Blocking problems are open: fix or waive them, then confirm");
  await row.getByRole("link", { name: "Review" }).click();

  const confirm = decision(page).getByRole("button", { name: "Confirm approval" });
  await expect(decision(page).getByTestId("console-answer")).toContainText("Blocking problems are open: fix or waive them, then confirm");
  await expect(confirm).toBeDisabled();
  await expect(confirm).toHaveAttribute("title", "1 blocking problem left");
  await waive(page, "Usage export", "Section lands in the next PRD version");
  await expect(confirm).toBeEnabled();
  await confirm.click();
  await expect(page.getByTestId("segment-roadmap_items").getByTestId("checkpoint-roadmap_items")).toContainText("Approved");

  await page.goto("/inbox");
  await expect(badge).toHaveText(String(before - 1));
  await expect(page.locator("tr[data-row]").filter({ hasText: "usage-alerts-roadmap-2" })).toHaveCount(0);
});
