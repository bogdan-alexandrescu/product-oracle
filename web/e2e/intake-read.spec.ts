import { expect, test, type Page } from "./test";

import { BEFORE_DRAFTING, READ_FAILED_TWICE } from "../lib/api/mock/intake";
import { login, signOut } from "./helpers";

/**
 * INT2 lane 2: Oracle's read of a new intake, as its author sees it on Before drafting
 * (/intakes/<id>). The mock's read runs on the mock clock: queued, then running on
 * SwarmCloud, then done (4 inferences and 1 gap from the brief and the author's 3 pinned
 * sources). The "intake-read-fallback" scenario fails the SwarmCloud read and falls back to
 * Oracle's built-in model, which reads it (owner answer Q3); "intake-read-fails" fails both,
 * and seeds READ_FAILED_TWICE, whose last two reads failed (its Inbox row).
 *
 * Test cards:
 * - "reading, then added" (10a): protects=the read line from start to finish and the path
 *   that produced it; fails_when=no line while reading, the counts or "private to you" are
 *   missing when done, it does not say SwarmCloud read it, or the inferences are not
 *   labelled "Oracle's inference"; no_claim=the real run or importer.
 * - "fallback" (Q3 changed): protects=the line names Oracle's built-in model when it read
 *   the brief in SwarmCloud's place, and why; fails_when=the line claims SwarmCloud or a
 *   run link; no_claim=the API's fallback timing.
 * - "failed, Try again" (10b): protects=a failed read says the rules read stands and offers
 *   Try again, which starts a read; fails_when=no failure line, no Try again, or the line
 *   does not return to reading; no_claim=SwarmCloud's retries.
 * - "Analyse with Oracle" (10c): protects=the author starts a fresh read of a finished
 *   intake, and of one never read; fails_when=the button is missing or no read starts;
 *   no_claim=Re-analyse (rules only, unchanged).
 * - "company switch" (10d): protects=Settings › Company's "Oracle reads new intakes" turns
 *   reads off; fails_when=the switch is missing for the owner, does not persist, or a new
 *   intake still reads; no_claim=the API's 409 on ai-read (test_intake_read*.py).
 * - "another member" (10e): protects=the read is the author's only; fails_when=another
 *   member sees the line or Analyse with Oracle; no_claim=findings sharing (S6).
 * - "phone" (10f): protects=the line on a 390 px screen; fails_when=the page scrolls
 *   sideways or the line is cut; no_claim=other phone layouts.
 * - "Inbox row": protects=two failed reads in a row raise one Inbox row that opens the
 *   intake; fails_when=the row is missing or opens elsewhere; no_claim=when the row ends.
 */

const BRIEF = "Team leads re-enter the same delivery notes for every bulk order. Let them save notes as presets.";

async function newIntake(page: Page, title: string): Promise<void> {
  await page.getByTestId("nav-prds").filter({ visible: true }).first().click();
  await page.getByRole("link", { name: "New PRD" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "New PRD" })).toBeVisible();
  await page.getByRole("textbox", { name: "Title" }).fill(title);
  await page.getByRole("textbox", { name: "What problem does it solve?" }).fill(BRIEF);
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page).toHaveURL(/\/intakes\/[0-9a-f-]+$/);
  await expect(page.getByRole("heading", { level: 1, name: title })).toBeAttached();
}

const line = (page: Page) => page.getByTestId("intake-read");
const scenario = (page: Page, key: string) =>
  page.addInitScript((k) => {
    if (!localStorage.getItem("po-mock-scenario")) localStorage.setItem("po-mock-scenario", k);
  }, key);

test("reading, then added: Oracle reads the brief on SwarmCloud and adds private inferences", async ({ page }) => {
  await login(page);
  await newIntake(page, "Delivery note presets");
  await expect(line(page)).toContainText("Oracle is reading your brief and 3 sources · started");
  await expect(page.getByRole("button", { name: "Analyse with Oracle" })).toHaveCount(0);

  // The page polls while the read runs.
  await page.clock.runFor(120_000);
  await expect(line(page)).toContainText("Oracle added 4 inferences and 1 gap · private to you");
  await expect(line(page)).toContainText("Read on SwarmCloud");
  await expect(line(page).getByRole("link", { name: "View run" })).toHaveAttribute("href", /^\/runs\/[0-9a-f-]+$/);

  await page.getByRole("tab", { name: "Findings" }).click();
  const findings = page.getByTestId("finding");
  await expect(findings).toHaveCount(5);
  await expect(findings.filter({ hasText: "Oracle's inference" })).toHaveCount(5);
});

test("fallback: SwarmCloud's read fails and Oracle's built-in model reads the brief instead", async ({ page }) => {
  await scenario(page, "intake-read-fallback");
  await login(page);
  await newIntake(page, "Delivery note presets");
  await expect(line(page)).toContainText("Oracle is reading your brief and 3 sources");
  await page.clock.runFor(100_000);
  await expect(line(page)).toContainText("on Oracle's built-in model");
  await page.clock.runFor(60_000);
  await expect(line(page)).toContainText("Oracle added 4 inferences and 1 gap · private to you");
  await expect(line(page)).toContainText("Oracle's read on the agent service failed, so Oracle's built-in model read it instead.");
  await expect(line(page)).not.toContainText("Read on SwarmCloud");
  await expect(line(page).getByRole("link", { name: "View run" })).toHaveCount(0);
});

test("failed, Try again: the rules read stands and Try again starts a new read", async ({ page }) => {
  await scenario(page, "intake-read-fails");
  await login(page);
  await newIntake(page, "Delivery note presets");
  await expect(line(page)).toContainText("Oracle is reading your brief and 3 sources");
  await page.clock.runFor(200_000);
  await expect(line(page)).toContainText("Oracle's read failed. The rules read stands.");
  await line(page).getByRole("button", { name: "Try again" }).click();
  await expect(line(page)).toContainText("Oracle is reading your brief and 3 sources");
  await expect(line(page).getByRole("button", { name: "Try again" })).toHaveCount(0);
});

test("Analyse with Oracle: the author starts a fresh read of a finished intake, and of one never read", async ({ page }) => {
  await scenario(page, "before-drafting");
  await login(page);
  await newIntake(page, "Delivery note presets");
  await page.clock.runFor(120_000);
  await expect(line(page)).toContainText("Oracle added 4 inferences and 1 gap");
  await line(page).getByRole("button", { name: "Analyse with Oracle" }).click();
  await expect(line(page)).toContainText("Oracle is reading your brief and 3 sources");

  // A brief from before Oracle's read: nothing read yet, one click away.
  await page.goto(`/intakes/${BEFORE_DRAFTING.intakeId}`);
  await expect(line(page)).toContainText("Oracle hasn't read this brief");
  await line(page).getByRole("button", { name: "Analyse with Oracle" }).click();
  await expect(line(page)).toContainText("Oracle is reading your brief and 3 sources");
});

test("company switch: an owner turns Oracle's read off on Settings › Company", async ({ page }) => {
  await login(page);
  await page.goto("/settings/company");
  const toggle = page.getByRole("checkbox", { name: "Oracle reads new intakes ($1.50 each)" });
  await expect(toggle).toBeChecked();
  await toggle.uncheck();
  await expect(page.getByTestId("intake-read-setting").getByRole("status")).toHaveText("Saved");
  await page.reload();
  await expect(page.getByRole("checkbox", { name: "Oracle reads new intakes ($1.50 each)" })).not.toBeChecked();

  await newIntake(page, "Delivery note presets");
  await expect(line(page)).toContainText("Oracle's read is off for this company");
  await expect(page.getByRole("button", { name: "Analyse with Oracle" })).toHaveCount(0);
});

test("company switch: a member who is not an owner sees it but cannot change it", async ({ page }) => {
  await login(page, "approver@example.com");
  await page.goto("/settings/company");
  await expect(page.getByRole("checkbox", { name: "Oracle reads new intakes ($1.50 each)" })).toBeDisabled();
});

test("another member: no read line and no Analyse with Oracle on someone else's brief", async ({ page }) => {
  await scenario(page, "before-drafting");
  await login(page);
  await page.goto(`/intakes/${BEFORE_DRAFTING.intakeId}`);
  await line(page).getByRole("button", { name: "Analyse with Oracle" }).click();
  await expect(line(page)).toContainText("Oracle is reading your brief");
  await signOut(page);

  for (const email of ["approver@example.com", "commenter@example.com", "viewer@example.com"]) {
    await login(page, email);
    await page.goto(`/intakes/${BEFORE_DRAFTING.intakeId}`);
    await expect(page.getByRole("heading", { level: 1, name: BEFORE_DRAFTING.title })).toBeAttached();
    await expect(page.getByTestId("intake-status")).toBeVisible();
    await expect(line(page)).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Analyse with Oracle" })).toHaveCount(0);
    await signOut(page);
  }
});

test("phone: the read line wraps at 390 px with no sideways scroll", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await scenario(page, "intake-read-fallback");
  await login(page);
  await newIntake(page, "Delivery note presets for every bulk order across all regions");
  await page.clock.runFor(160_000);
  await expect(line(page)).toContainText("Oracle's built-in model read it instead.");
  const box = await line(page).boundingBox();
  expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

test("Inbox row: two failed reads in a row raise one row that opens the intake", async ({ page }) => {
  await scenario(page, "intake-read-fails");
  await login(page);
  await page.goto("/inbox");
  const row = page.getByTestId("intake-read-need").filter({ hasText: `Oracle couldn't read ${READ_FAILED_TWICE.title}` });
  await expect(row).toBeVisible();
  await page.getByRole("row").filter({ has: row }).getByRole("link", { name: "Open" }).click();
  await expect(page).toHaveURL(new RegExp(`/intakes/${READ_FAILED_TWICE.intakeId}$`));
  await expect(line(page)).toContainText("Oracle's read failed. The rules read stands.");
  await expect(line(page).getByRole("button", { name: "Try again" })).toBeVisible();
});
