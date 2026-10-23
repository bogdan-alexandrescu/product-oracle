import { expect, type Page, test } from "@playwright/test";

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
