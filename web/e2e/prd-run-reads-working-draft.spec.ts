import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login, openRoadmapItem, signOut } from "./helpers";
import { expect, test, type Locator, type Page } from "./test";

/*
 * prd-reads-working-draft (production, Nov 6): the owner edits the company roadmap in Simple
 * (its working draft), then regenerates a PRD; the run follows that draft, and its page says
 * which roadmap it read: "Company roadmap, working draft (edited <day, time>)", month first in
 * Pacific time; with no edits, the published version ("Company roadmap v1 (published <day>)").
 * Driven through the UI against the mock's "one-roadmap" scenario (invented data).
 *
 * Test card: protects=the run page names the roadmap the run read, the working draft after a
 * panel edit and the published version without one; fails_when=the run shows no roadmap, or
 * names the published version after the owner edited the draft; no_claim=what the agents are
 * told (api/tests/test_prd_run_reads_working_draft.py).
 */

const panel = (page: Page) => page.getByTestId("floating-card");

async function tap(l: Locator) {
  await l.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await l.click();
}

async function open(page: Page, email?: string) {
  await page.context().addInitScript(([key, value]) => localStorage.setItem(key, value), [MOCK_SCENARIO_KEY, "one-roadmap"] as const);
  await login(page, email);
}

async function regenerate(page: Page) {
  await page.goto("/documents/user-safety");
  await page.getByRole("button", { name: "Actions for User Safety" }).click();
  await page.getByRole("menuitem", { name: "Regenerate…" }).click();
  const dialog = page.getByRole("dialog", { name: "Regenerate User Safety" });
  await dialog.getByLabel("Note to the agents (optional)").fill("Follow the roadmap as I edited it.");
  await dialog.getByRole("button", { name: "Estimate" }).click();
  await dialog.getByRole("button", { name: "Start run" }).click();
  await expect(page).toHaveURL(/\/runs\/[0-9a-f-]+$/);
}

async function rename(page: Page) {
  await page.goto("/simple/roadmap");
  await expect(page.getByTestId("simple-roadmap")).toBeVisible();
  await openRoadmapItem(page, "report-button");
  await expect(panel(page)).toBeVisible();
  await tap(panel(page).getByRole("button", { name: "More actions" }));
  await tap(page.getByRole("menuitem", { name: "Rename" }));
  await panel(page).getByLabel("Name").fill("Report button on posts and comments");
  await tap(panel(page).getByRole("button", { name: "Save" }));
  await expect(panel(page).getByTestId("card-name")).toContainText("Report button on posts and comments");
}

test("after an edit in Simple, the regenerated PRD's run says it read the working draft", async ({ page }) => {
  await open(page);
  await rename(page);
  await regenerate(page);
  const read = page.getByTestId("run-roadmap-read");
  await expect(read).toHaveText(/^Roadmap read: Company roadmap, working draft \(edited [A-Z][a-z]{2} \d{1,2}, \d{4}, \d{1,2}:\d{2} [AP]M P[SD]T\)$/);
});

test("with no edits, the regenerated PRD's run says it read the published version", async ({ page }) => {
  await open(page);
  await regenerate(page);
  await expect(page.getByTestId("run-roadmap-read")).toHaveText(/^Roadmap read: Company roadmap v\d+ \(published [A-Z][a-z]{2} \d{1,2}\)$/);
});

// Round 1 review: the run follows the draft only when the person who starts it may see it. An
// approver who took no part in the owner's draft regenerates the PRD from the published version.
test("an approver outside the owner's draft regenerates the PRD from the published version", async ({ page }) => {
  await open(page);
  await rename(page);
  await signOut(page);
  await login(page, "approver@example.com");
  await regenerate(page);
  await expect(page.getByTestId("run-roadmap-read")).toHaveText(/^Roadmap read: Company roadmap v\d+ \(published [A-Z][a-z]{2} \d{1,2}\)$/);
});
