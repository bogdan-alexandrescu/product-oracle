import { expect, type Page, test, mockNow } from "./test";

import { login } from "./helpers";

/**
 * #463: days the API writes into text a person reads are the Company time zone's day. The
 * mock's Baseline to PRD run started at 07:30 UTC on Oct 16, which is 21:30 on Oct 15 in
 * Honolulu. Driven through the UI on the mock layer.
 */

const AGENT_RUN = "0b7e5d4c-3a29-4118-9f07-e6d5c4b3a291";

async function setZone(page: Page, zone: string) {
  await page.goto("/settings/company");
  await page.getByLabel("Company time zone").selectOption(zone);
  await page.getByTestId("timezone-panel").getByRole("button", { name: "Save" }).click();
  await expect(page.getByTestId("timezone-panel").getByRole("status")).toHaveText("Saved");
}

async function openProposals(page: Page) {
  await page.goto("/baseline");
  await expect(page.getByRole("heading", { level: 1, name: "Baseline" })).toBeVisible();
  await page.getByRole("tab", { name: /Proposals/ }).click();
  await expect(page.getByTestId("proposal")).toHaveCount(3);
}

// protects: a run's proposals name the day the run started in the Company time zone.
// fails_when: the label keeps the UTC day (Oct 16) after the zone changes to one where
// the run started the day before.
// no_claim: the API's own wording (pytest test_company_day_text.py).
test("proposals: the run that made them is named with the Company day", async ({ page }) => {
  await login(page);
  await openProposals(page);
  await expect(page.getByLabel("From").locator("option")).toContainText(["Baseline to PRD · Oct 16"]);

  await setZone(page, "Pacific/Honolulu");
  await openProposals(page);
  const label = "Baseline to PRD · Oct 15";
  await expect(page.getByLabel("From").locator("option")).toContainText([label]);
  const rows = page.getByTestId("proposal");
  const link = rows.filter({ hasText: "Guided setup" }).getByRole("link", { name: `From run · ${label}` });
  await expect(link).toHaveAttribute("href", `/runs/${AGENT_RUN}`);
  await expect(page.getByText("Baseline to PRD · Oct 16")).toHaveCount(0);
});

const PROBLEM = "Returning buyers retype their address at every checkout. Saved addresses would make repeat checkout faster.";

/** The mock's last baseline review, 16:40 UTC nine days ago, is the next day in Auckland (UTC+13). */
function aucklandApprovalDay(): string {
  const at = new Date(mockNow().getTime() - 9 * 86_400_000);
  at.setUTCHours(16, 40, 0, 0);
  const next = new Date(at.getTime() + 86_400_000);
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${months[next.getUTCMonth()]} ${next.getUTCDate()}`;
}

// protects: the reused baseline's approval day, in the Draft with Oracle sheet and on the
// run page, is the Company day the API's notes name.
// fails_when: either still shows the UTC day of the approval.
// no_claim: the API's note text (pytest test_company_day_text.py).
test("reuse: the baseline's approval day is the Company day in the sheet and on the run", async ({ page }) => {
  await login(page);
  await setZone(page, "Pacific/Auckland");
  const day = aucklandApprovalDay();

  await page.getByTestId("nav-prds").filter({ visible: true }).first().click();
  await page.getByRole("link", { name: "New PRD" }).click();
  await page.getByRole("textbox", { name: "Title" }).fill("Saved addresses for late shoppers");
  await page.getByRole("textbox", { name: "What problem does it solve?" }).fill(PROBLEM);
  await page.getByRole("button", { name: "Continue" }).first().click();
  await expect(page).toHaveURL(/\/intakes\/[0-9a-f-]+$/);
  await page.getByRole("button", { name: "Draft with Oracle" }).click();

  const sheet = page.getByRole("dialog", { name: "Draft with Oracle" });
  await expect(sheet.getByRole("radio", { name: `Use the current baseline (approved ${day})` })).toBeChecked();
  await sheet.getByRole("button", { name: "Estimate" }).click();
  // F4 (#181): the Engineering check and the Engineering dates are on by default, $5.00 each in the estimate (eng-review.spec.ts, eng-dates.spec.ts).
  await expect(sheet.getByTestId("draft-estimate")).toHaveText("Estimated $29.50");
  await sheet.getByRole("button", { name: "Start drafting" }).click();
  await expect(page).toHaveURL(/\/runs\/[0-9a-f-]+$/);
  await expect(page.getByTestId("segment-baseline").getByTestId("segment-state")).toHaveText(`Reused (approved ${day})`);
});
