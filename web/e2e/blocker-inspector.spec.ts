import { expect, test, type Page } from "@playwright/test";

import { DEPOSITS_IDS } from "../lib/api/mock/blockers";
import { login } from "./helpers";

/**
 * #340: the blocker inspector. A person edits a blocker's status, owner and description,
 * handles its solution options, sets its feasibility scope and runs its experiments, all
 * in the UI; it opens from the Blockers tab, the Baseline drawer and Publish's blocks.
 */
const DEPOSITS = "Same-day refund rule unanswered";
const LOOKUP = "The address lookup service allows 100 requests a minute per company";

async function openBlockers(page: Page, role?: "approver" | "commenter" | "viewer") {
  if (role) await page.addInitScript((r) => localStorage.setItem("po-mock-role", r), role);
  await login(page);
  await page.goto("/baseline?tab=blockers");
  await expect(page.getByRole("heading", { level: 1, name: "Baseline" })).toBeVisible();
}

async function openBlocker(page: Page, statement: string) {
  await page.getByTestId("blocker-row").filter({ hasText: statement }).click();
  const insp = page.getByTestId("blocker-inspector");
  await expect(insp.getByRole("heading", { name: statement })).toBeVisible();
  return insp;
}

const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

test("blockers tab: status counts, and a status change moves the count", async ({ page }) => {
  await openBlockers(page);
  await expect(page.getByTestId("tab-count-blockers")).toHaveText("2");
  const chips = page.getByRole("group", { name: "Blocker status" });
  await expect(chips.getByRole("button", { name: /^All/ })).toContainText("2");
  await expect(chips.getByRole("button", { name: /^Open/ })).toContainText("1");
  await expect(chips.getByRole("button", { name: /^Mitigating/ })).toContainText("1");
  await chips.getByRole("button", { name: /^Open/ }).click();
  await expect(page.getByTestId("blocker-row")).toHaveCount(1);
  await chips.getByRole("button", { name: /^All/ }).click();

  const insp = await openBlocker(page, DEPOSITS);
  await expect(insp.getByTestId("blocker-status")).toHaveText("Open");
  const form = insp.getByRole("form", { name: "Change status" });
  await form.getByLabel("Status").selectOption("resolved");
  await form.getByRole("button", { name: "Set status" }).click();
  await expect(form).toContainText("Say why the blocker is resolved");
  await form.getByLabel("Reason").fill("The processor confirmed same-day refunds in writing");
  await form.getByRole("button", { name: "Set status" }).click();
  await expect(insp.getByTestId("blocker-status")).toHaveText("Resolved");
  await expect(insp.getByRole("list", { name: "History" })).toContainText("Status changed from open to resolved");
  await expect(chips.getByRole("button", { name: /^Resolved/ })).toContainText("1");
  await expect(chips.getByRole("button", { name: /^Open/ })).toContainText("0");
});

test("edit a blocker: owner, description, severity", async ({ page }) => {
  await openBlockers(page);
  const insp = await openBlocker(page, LOOKUP);
  await expect(insp.getByTestId("blocker-locked")).toBeVisible();
  await expect(insp.getByTestId("blocker-owner")).toHaveText("You");
  await insp.getByRole("button", { name: "Edit blocker" }).click();
  const form = insp.getByRole("form", { name: "Edit blocker" });
  await form.getByLabel("Description").fill("Bursts at launch exceed the per-company quota.");
  await form.getByLabel("Severity").selectOption("high");
  await form.getByRole("button", { name: "Save" }).click();
  await expect(insp).toContainText("Blocker saved.");
  await expect(insp.getByTestId("blocker-detail")).toHaveText("Bursts at launch exceed the per-company quota.");
  await expect(insp.getByTestId("blocker-severity")).toHaveText("High");
});

test("options: propose, review, select, fallback, reject and edit", async ({ page }) => {
  await openBlockers(page);
  const insp = await openBlocker(page, DEPOSITS);
  const propose = async (title: string) => {
    await insp.getByRole("button", { name: "Propose option" }).click();
    const form = insp.getByRole("form", { name: "Propose option" });
    await form.getByLabel("Title").fill(title);
    await form.getByLabel("Approach").selectOption("alternative_workflow");
    await form.getByRole("button", { name: "Propose" }).click();
    await expect(form).toHaveCount(0);
    const row = insp.getByTestId("blocker-option").filter({ hasText: title });
    await expect(row).toContainText("Proposed");
    await expect(row).toContainText("Needs review");
    return row;
  };

  const voucher = await propose("Offer a credit note on same-day cancellations");
  // Only a compliant option can be chosen.
  await expect(voucher.getByRole("button", { name: "Select" })).toBeDisabled();
  await voucher.getByRole("button", { name: "Edit" }).click();
  const edit = voucher.getByRole("form", { name: "Edit option" });
  await edit.getByLabel("Title").fill("Offer a credit note on every same-day cancellation");
  await edit.getByLabel("Compliance").selectOption("compliant");
  await edit.getByRole("button", { name: "Save" }).click();
  const chosen = insp.getByTestId("blocker-option").filter({ hasText: "Offer a credit note on every same-day cancellation" });
  await expect(chosen).toContainText("Compliant");
  await chosen.getByRole("button", { name: "Select" }).click();
  const why = chosen.getByRole("form", { name: "Select option" });
  await why.getByLabel("Reason").fill("Patients keep the value; the processor rule does not apply");
  await why.getByRole("button", { name: "Select" }).click();
  await expect(chosen).toContainText("Selected");
  await expect(insp.getByTestId("blocker-status")).toHaveText("Mitigating");

  const manual = await propose("Refund by bank transfer the next day");
  await manual.getByRole("button", { name: "Edit" }).click();
  await manual.getByRole("form", { name: "Edit option" }).getByLabel("Compliance").selectOption("compliant");
  await manual.getByRole("form", { name: "Edit option" }).getByRole("button", { name: "Save" }).click();
  await manual.getByRole("button", { name: "Fallback" }).click();
  await expect(manual).toContainText("Fallback");

  const drop = await propose("Ask the clinic to refund in cash");
  await drop.getByRole("button", { name: "Reject" }).click();
  const no = drop.getByRole("form", { name: "Reject option" });
  await no.getByLabel("Reason").fill("Clinics do not hold cash");
  await no.getByRole("button", { name: "Reject" }).click();
  await expect(drop).toContainText("Rejected");
  await expect(drop.getByRole("button", { name: "Select" })).toHaveCount(0);
});

test("experiments and feasibility scope: plan, approve the scope, start, conclude", async ({ page }) => {
  await openBlockers(page);
  const insp = await openBlocker(page, DEPOSITS);
  await insp.getByRole("button", { name: "Plan experiment" }).click();
  const plan = insp.getByRole("form", { name: "Plan experiment" });
  await plan.getByLabel("Hypothesis").fill("The processor refunds same-day in the sandbox");
  await plan.getByLabel("Method").fill("Ten synthetic bookings cancelled on the day");
  await plan.getByLabel("Success threshold").fill("All ten refunds settle");
  await plan.getByLabel("Decision gate").fill(inDays(14));
  await plan.getByRole("button", { name: "Plan" }).click();
  const x = insp.getByTestId("experiment").filter({ hasText: "The processor refunds same-day in the sandbox" });
  await expect(x).toContainText("Planned");
  await expect(x).toContainText("All ten refunds settle");

  const scope = insp.getByRole("form", { name: "Feasibility scope" });
  await scope.getByLabel("Experiment").selectOption({ label: "The processor refunds same-day in the sandbox" });
  await scope.getByLabel("Reason").fill("Build only behind the sandbox until the gate");
  await scope.getByRole("button", { name: "Approve scope" }).click();
  await expect(insp.getByTestId("blocker-status")).toHaveText("Feasibility only");
  await expect(insp.getByTestId("feasibility-scope")).toContainText("The processor refunds same-day in the sandbox");

  await x.getByRole("button", { name: "Start" }).click();
  await expect(x).toContainText("Running");
  await x.getByRole("button", { name: "Conclude" }).click();
  const end = x.getByRole("form", { name: "Conclude experiment" });
  await end.getByLabel("Outcome").selectOption("failed");
  await end.getByRole("button", { name: "Save result" }).click();
  await expect(end).toContainText("Record the result when an experiment concludes");
  await end.getByLabel("Result").fill("Three of ten refunds were held until the next day");
  await end.getByRole("button", { name: "Save result" }).click();
  await expect(x).toContainText("Failed");
  await expect(x).toContainText("Three of ten refunds were held until the next day");
  // A failed experiment ends the scope: the blocker is open again.
  await expect(insp.getByTestId("blocker-status")).toHaveText("Open");
});

test("a viewer sees every control disabled, with the reason", async ({ page }) => {
  await openBlockers(page, "viewer");
  const insp = await openBlocker(page, DEPOSITS);
  await expect(insp.getByTestId("blocker-readonly")).toHaveText(
    "Viewers can read blockers. Approvers and owners change them; commenters can propose options.",
  );
  await expect(insp.getByRole("form", { name: "Change status" }).getByRole("button", { name: "Set status" })).toBeDisabled();
  await expect(insp.getByRole("button", { name: "Edit blocker" })).toBeDisabled();
  await expect(insp.getByRole("button", { name: "Propose option" })).toBeDisabled();
  await expect(insp.getByRole("button", { name: "Plan experiment" })).toBeDisabled();
  await expect(insp.getByRole("form", { name: "Feasibility scope" }).getByRole("button", { name: "Approve scope" })).toBeDisabled();
});

test("a commenter proposes an option but cannot decide; an approver cannot scope a gating blocker", async ({ page }) => {
  await openBlockers(page, "commenter");
  const insp = await openBlocker(page, DEPOSITS);
  await expect(insp.getByRole("button", { name: "Propose option" })).toBeEnabled();
  await expect(insp.getByRole("button", { name: "Edit blocker" })).toBeDisabled();
  await insp.getByRole("button", { name: "Propose option" }).click();
  const form = insp.getByRole("form", { name: "Propose option" });
  await form.getByLabel("Title").fill("Hold the deposit until the next morning");
  await form.getByLabel("Approach").selectOption("operations");
  await form.getByRole("button", { name: "Propose" }).click();
  const row = insp.getByTestId("blocker-option").filter({ hasText: "Hold the deposit until the next morning" });
  await expect(row).toContainText("Proposed");
  await expect(row.getByRole("button", { name: "Reject" })).toBeDisabled();
});

test("an approver: the gating blocker's feasibility scope is the owner's", async ({ page }) => {
  await openBlockers(page, "approver");
  const insp = await openBlocker(page, LOOKUP);
  const scope = insp.getByRole("form", { name: "Feasibility scope" });
  await expect(scope).toContainText("Only an owner can approve this feasibility scope");
  await expect(scope.getByRole("button", { name: "Approve scope" })).toBeDisabled();
  await expect(insp.getByRole("button", { name: "Edit blocker" })).toBeEnabled();
});

test("opens from the Baseline drawer", async ({ page }) => {
  await login(page);
  await page.goto(`/baseline?entity=${DEPOSITS_IDS.blocker}`);
  const drawer = page.getByTestId("entity-drawer");
  await drawer.getByRole("button", { name: "Open blocker" }).click();
  await expect(page.getByTestId("blocker-inspector").getByRole("heading", { name: DEPOSITS })).toBeVisible();
  await expect(page.getByRole("tab", { name: /Blockers/ })).toHaveAttribute("aria-selected", "true");
});

test("opens from Publish's blocks list", async ({ page }) => {
  await login(page);
  await page.goto("/documents/online-deposits/publish");
  await page.getByTestId("publish-inspector").getByRole("link", { name: "Open blocker" }).click();
  await expect(page).toHaveURL(/\/baseline\?tab=blockers&blocker=/);
  await expect(page.getByTestId("blocker-inspector").getByRole("heading", { name: DEPOSITS })).toBeVisible();
});

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("the inspector stacks under the list, no side scroll", async ({ page }) => {
    await openBlockers(page);
    const insp = await openBlocker(page, LOOKUP);
    await expect(insp.getByTestId("blocker-option").first()).toBeVisible();
    const width = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(width).toBeLessThanOrEqual(390);
  });
});
