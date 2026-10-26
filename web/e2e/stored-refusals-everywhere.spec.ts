import { expect, test, type Page } from "./test";

import { MOCK_SCENARIO_KEY, STORED_REFUSALS_SCENARIO } from "../lib/api/mock/server";
import { login, openSection, sectionAction } from "./helpers";

/**
 * #561 review (MAJOR 1): every surface that shows a stored Claude-pool refusal says when it
 * failed, in the Company time zone, and words the refusal as what was so then: nothing on the
 * page says every account is spent now. The "stored-refusals" scenario: a feedback loop, its
 * segment, usage-alerts v2's roadmap items and Clinic outreach's draft 6 build failed on
 * Oct 18 on a refusal stored before #403's wording; a refinement asked for now is refused.
 */
const FAILED = "Failed Oct 18, 4:12 PM PDT";
const THEN =
  "No Claude account could take this call: every Claude account was spent; the earliest window was due to clear Sun Oct 25, 3:00 PM PDT.";

async function noCurrentRefusal(page: Page) {
  const shown = page.locator("main");
  await expect(shown).not.toContainText("is spent");
  await expect(shown).not.toContainText("can take this call");
  await expect(shown).not.toContainText("2026-10-25T");
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(([key, value]) => localStorage.setItem(key, value), [MOCK_SCENARIO_KEY, STORED_REFUSALS_SCENARIO]);
  await login(page);
});

test("a failed run and its segment say when they failed, the refusal in the past", async ({ page }) => {
  await page.goto("/runs");
  await page.getByTestId("run-row").filter({ hasText: "checkout-redesign" }).filter({ hasText: "Failed" }).getByRole("link").first().click();

  const notes = page.getByTestId("failed-at");
  await expect(notes).toHaveCount(2);
  await expect(notes).toHaveText([`${FAILED}.`, `${FAILED}.`]);
  // The run's note, then the segment's: when, then what was so.
  await expect(page.getByText(THEN)).toHaveCount(2);
  await noCurrentRefusal(page);
});

test("roadmap items that failed say when, the refusal in the past", async ({ page }) => {
  await page.goto("/documents/usage-alerts/v/2/roadmap");
  const status = page.getByTestId("draft-roadmap-status").filter({ visible: true });
  await expect(status).toHaveAttribute("data-status", "failed");
  await expect(status.getByTestId("failed-at")).toHaveText(`${FAILED}.`);
  await expect(status).toContainText(`Oracle could not derive roadmap items: ${THEN}`);
  await noCurrentRefusal(page);
});

test("a next-draft build that failed says when on its chip, the refusal in the past", async ({ page }) => {
  await page.goto("/documents/clinic-outreach/v/5");
  await page.getByTestId("build-draft").filter({ visible: true }).click();
  const sheet = page.getByTestId("next-draft-sheet");
  await expect(sheet.getByTestId("job-failed")).toHaveText(FAILED);
  await expect(sheet).toContainText(`${THEN} Every Claude account was out of quota when this ran.`);
  await expect(sheet).not.toContainText("is spent");
  await expect(sheet).not.toContainText("can take this call");
});

test("a refinement the pool refused says when it failed, the refusal in the past", async ({ page }) => {
  await page.goto("/documents/checkout-redesign/v/2");
  const users = await openSection(page, "users");
  await sectionAction(users, "3. Users and jobs", /^Refine section/);
  const refine = users.getByTestId("refine-panel");
  await refine.getByLabel("Instruction").fill("Name the first-time buyer segment explicitly.");
  await refine.getByRole("button", { name: "Refine", exact: true }).click();

  const status = users.getByTestId("refine-status");
  await expect(status.getByTestId("job-failed")).toHaveText(/^Failed Oct \d+, \d+:\d{2} [AP]M PDT$/);
  await expect(status).toContainText(`${THEN} Every Claude account was out of quota when this ran.`);
  await expect(status).not.toContainText("is spent");
});
