import { expect, test, type Page, mockNow } from "./test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login, openSection, sectionAction, seedDecidedRun } from "./helpers";

/*
 * H1 Decision log, driven through the UI on the mock layer. The mock seeds five judgement
 * calls of the mock company (D-4 "Price the team plan per seat" is decided and due for
 * review, D-5 "Ship usage caps before anomaly detection" waits on the approver), and
 * seedDecidedRun adds a finished run whose decided stops become checkpoint records.
 * Each test states its card: protects / fails_when / no_claim.
 */

const APPROVER = "approver@example.com";
const COMMENTER = "commenter@example.com";

const rows = (page: Page) => page.getByTestId("decision-row");
const row = (page: Page, text: string | RegExp) => rows(page).filter({ hasText: text });
const badge = (page: Page) => page.getByTestId("app-nav").getByTestId("nav-inbox-badge");
const chip = (page: Page, group: string, name: string | RegExp) =>
  page.getByRole("group", { name: group }).getByRole("button", { name: typeof name === "string" ? new RegExp(`^${name}`) : name });

async function badgeCount(page: Page): Promise<number> {
  await expect(badge(page)).toHaveText(/^\d+$/);
  return Number(await badge(page).innerText());
}

test("an approver decides a proposal from Needs me; the chip reads Decided and the badge drops by one", async ({ page }) => {
  // protects=the named approver sees the seeded judgement calls, Needs me by default, and
  // decides one with an option, a reason and a review date; fails_when=the decision is not
  // recorded, the chip does not change, or the Inbox badge keeps counting it; no_claim=the
  // mock stands in for the API (its rules mirror /v1/decisions).
  await login(page, APPROVER);
  await page.goto("/company/decisions");
  await expect(page.getByRole("heading", { level: 1, name: "Company" })).toBeVisible();
  await expect(chip(page, "State", "Needs me")).toHaveAttribute("aria-pressed", "true");
  await expect(row(page, "Ship usage caps before anomaly detection")).toBeVisible();
  await expect(row(page, "Price the team plan per seat")).toContainText("Review due");
  const before = await badgeCount(page);
  // Oracle's words on screen: a company, never a workspace.
  await row(page, "Price the team plan per seat").click();
  const priced = page.getByTestId("decision-inspector").filter({ visible: true });
  await expect(priced).toContainText("Per seat or per company?");
  await expect(priced.getByTestId("decision-option").filter({ hasText: "Per company" })).toBeVisible();
  await expect(priced).not.toContainText(/workspace/i);

  await row(page, "Ship usage caps before anomaly detection").click();
  const inspector = page.getByTestId("decision-inspector").filter({ visible: true });
  await expect(inspector).toContainText("Do caps wait for detection?");
  await expect(inspector.getByTestId("decision-option").filter({ hasText: "Caps first" })).toContainText("Oracle recommends");
  await inspector.getByRole("button", { name: "Decide" }).click();
  const form = inspector.getByRole("form", { name: "Decide" });
  await form.getByRole("radio", { name: "Caps first" }).check();
  await form.getByLabel("Why").fill("Caps alone meet the goal; detection follows.");
  await expect(form.getByLabel("Review date")).not.toHaveValue("");
  await form.getByLabel("Expected outcome").fill("Spend incidents drop below 2 a month");
  await form.getByRole("button", { name: "Record decision" }).click();

  await expect(inspector).toContainText("Caps alone meet the goal; detection follows.");
  await chip(page, "State", "All").click();
  await expect(row(page, "Ship usage caps before anomaly detection")).toContainText("Decided");
  await expect(badge(page)).toHaveText(String(before - 1));
});

test("a commenter proposes but never decides; one option is refused before it is sent", async ({ page }) => {
  // protects=commenters see Propose decision and no Decide; a proposal with one option shows
  // "Add at least two options" and is not submitted; fails_when=a commenter can decide, or a
  // one-option proposal is created; no_claim=the API's own 422 rules are covered by pytest.
  await login(page, COMMENTER);
  await page.goto("/company/decisions");
  await expect(page.getByRole("button", { name: "Propose decision" })).toBeVisible();
  await row(page, "Ship usage caps before anomaly detection").click();
  const inspector = page.getByTestId("decision-inspector").filter({ visible: true });
  await expect(inspector).toContainText("Ship usage caps before anomaly detection");
  await expect(inspector.getByRole("button", { name: "Decide" })).toHaveCount(0);
  const count = await rows(page).count();

  await page.getByRole("button", { name: "Propose decision" }).click();
  const dialog = page.getByRole("dialog", { name: "Propose decision" });
  await dialog.getByLabel("Decision", { exact: true }).fill("Offer annual billing at launch");
  await dialog.getByLabel("Option 1", { exact: true }).fill("Annual at launch");
  await dialog.getByRole("button", { name: "Remove option 2" }).click();
  await dialog.getByLabel("Approver", { exact: true }).selectOption({ label: APPROVER });
  await dialog.getByRole("button", { name: "Propose", exact: true }).click();
  await expect(dialog).toContainText("Add at least two options");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(rows(page)).toHaveCount(count);
  await expect(row(page, "Offer annual billing at launch")).toHaveCount(0);
});

test("a Review due row is reaffirmed in place in the Inbox: it moves to Done and the badge drops by one", async ({ page }) => {
  // protects=the approver's "Review due" row reaffirms the decision for 90 more days without
  // leaving the Inbox; fails_when=the row stays counted or the badge does not drop;
  // no_claim=the seeded review date stands in for one that has come due.
  await login(page, APPROVER);
  await page.goto("/inbox");
  const decisions = page.getByTestId("inbox-decisions");
  const due = decisions.locator("tr[data-row]").filter({ hasText: "Review due · D-4 Price the team plan per seat" });
  await expect(due).toBeVisible();
  // The review date reads like the Inbox's other dates, never a raw ISO date.
  const was = mockNow();
  was.setDate(was.getDate() - 2);
  const shown = new Intl.DateTimeFormat("en", { month: "short", day: "numeric", year: "numeric" }).format(was);
  await expect(due).toContainText(`Review was due ${shown}`);
  await expect(due).not.toContainText(/\d{4}-\d{2}-\d{2}/);
  const before = await badgeCount(page);
  await due.getByRole("button", { name: /^Reaffirm/ }).click();
  await expect(page.getByTestId("inbox-decisions").locator("tr[data-row]").filter({ hasText: "D-4 Price the team plan per seat" })).toHaveCount(0);
  await expect(badge(page)).toHaveText(String(before - 1));
  await page.getByRole("tab", { name: /^Done/ }).click();
  await expect(page.getByTestId("inbox-tab-done").getByTestId("inbox-decisions")).toContainText("D-4 Price the team plan per seat");
});

test("phone: the table keeps D-number, title and state, no sideways scroll, the inspector opens as a sheet", async ({ page }) => {
  // protects=at 390 px each row reads D-number, title and state and the page never scrolls
  // sideways; a row opens its inspector in a sheet; fails_when=a hidden column pushes the
  // page wider or the inspector only renders below the list; no_claim=Chromium's layout.
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page, APPROVER);
  await page.goto("/company/decisions");
  const caps = row(page, "Ship usage caps before anomaly detection");
  await expect(caps).toContainText("D-5");
  await expect(caps).toContainText("Proposed");
  await expect(caps.locator('[data-col="approver"]')).toBeHidden();
  const [sw, cw] = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
  expect(sw).toBeLessThanOrEqual(cw);
  await caps.click();
  const sheet = page.getByRole("dialog", { name: /^D-5/ });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByTestId("decision-inspector")).toContainText("Do caps wait for detection?");
});

test("the class switch keeps checkpoint records apart; From and the URL keep the view; a checkpoint record is read-only", async ({ page }) => {
  // protects=the log opens on Judgement calls with no checkpoint record; Checkpoints shows
  // the seeded run's stops; From "Pushback overrides" shows only those; a reload keeps the
  // filters; a checkpoint record offers Open run and no Decide; fails_when=checkpoint records
  // bury the judgement calls, a filter is lost on reload, or a stop can be decided here;
  // no_claim=the run is seeded into the mock, its stops decided as the Inbox would.
  await login(page);
  await seedDecidedRun(page);
  await page.goto("/company/decisions");
  await expect(chip(page, "Class", "Judgement calls")).toHaveAttribute("aria-pressed", "true");
  await expect(row(page, "Price the team plan per seat")).toBeVisible();
  await expect(row(page, /Approve Feature set · /)).toHaveCount(0);

  await chip(page, "Class", "Checkpoints").click();
  await expect(row(page, "Approve Feature set · Checkout redesign PRD run")).toBeVisible();
  await expect(row(page, "Send back Feature set · Checkout redesign PRD run")).toBeVisible();
  await expect(row(page, "Price the team plan per seat")).toHaveCount(0);
  await expect(row(page, "Approve Feature set · Checkout redesign PRD run")).toContainText("—");

  // Two quick picks: From is picked before All has taken, and both stay.
  await chip(page, "Class", "All").click();
  await page.getByLabel("From").selectOption({ label: "Pushback overrides" });
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).first()).toContainText("Keep the reviewer's call over Oracle's pushback");
  await expect(page).toHaveURL(/from=pushback_override/);

  await page.reload();
  await expect(page.getByLabel("From")).toHaveValue("pushback_override");
  await expect(chip(page, "Class", "All")).toHaveAttribute("aria-pressed", "true");
  await expect(rows(page)).toHaveCount(1);

  await page.getByLabel("From").selectOption({ label: "Checkpoint send-backs" });
  await row(page, "Send back Feature set · Checkout redesign PRD run").click();
  const inspector = page.getByTestId("decision-inspector").filter({ visible: true });
  await expect(inspector).toContainText("Size the export feature again");
  await expect(inspector.getByRole("link", { name: "Open run" })).toBeVisible();
  await expect(inspector.getByRole("button", { name: "Decide" })).toHaveCount(0);
  await expect(inspector.getByRole("button", { name: /^Review/ })).toHaveCount(0);
});

test("the run page's Decisions in this run opens the log on Checkpoints with that run's records", async ({ page }) => {
  // protects=the run page links to /company/decisions?run=<id>, which opens on Checkpoints
  // with exactly that run's stop records; fails_when=the link loses the run or shows another
  // run's records; no_claim=the run is seeded into the mock.
  await login(page);
  const id = await seedDecidedRun(page);
  await page.goto(`/runs/${id}`);
  await page.getByTestId("run-decision-log").click();
  await expect(page).toHaveURL(new RegExp(`/company/decisions\\?run=${id}`));
  await expect(chip(page, "Class", "Checkpoints")).toHaveAttribute("aria-pressed", "true");
  await expect(rows(page)).toHaveCount(5);
  for (const title of [
    "Approve Baseline confirm",
    "Send back Feature set",
    "Approve Feature set",
    "Approve Priority order",
    "Approve PRD review",
  ]) {
    await expect(row(page, `${title} · Checkout redesign PRD run`)).toHaveCount(1);
  }
});

test("a section's Record a decision opens Propose decision about that section", async ({ page }) => {
  // protects=a commenter starts a decision from a document section's ⋯ menu; the proposal is
  // about that section and the log, opened for it, lists it; fails_when=the subject is lost
  // on the way or the new decision is not findable by its subject; no_claim=the mock's
  // section ids stand in for the API's.
  await login(page, COMMENTER);
  await page.goto("/documents/checkout-redesign/v/2");
  const goalTrace = await openSection(page, "goal-trace");
  await sectionAction(goalTrace, "1. Goal trace", "Record a decision about 1. Goal trace");
  await expect(page).toHaveURL(/\/company\/decisions\?subject=section/);
  const dialog = page.getByRole("dialog", { name: "Propose decision" });
  await expect(dialog).toContainText("About: Section 1. Goal trace");
  await dialog.getByLabel("Decision", { exact: true }).fill("Trace the retention goal to repeat orders");
  await dialog.getByLabel("Option 1", { exact: true }).fill("Repeat orders in 30 days");
  await dialog.getByLabel("Option 2", { exact: true }).fill("Monthly active buyers");
  await dialog.getByLabel("Approver", { exact: true }).selectOption({ label: APPROVER });
  await dialog.getByRole("button", { name: "Propose", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(rows(page)).toHaveCount(1);
  await expect(row(page, "Trace the retention goal to repeat orders")).toContainText("Proposed");
  const inspector = page.getByTestId("decision-inspector").filter({ visible: true });
  await expect(inspector).toContainText("Section 1. Goal trace");
});

test("with 250 newer decisions, Needs me and Review due still find an old one; Show more pages through the rest", async ({ page }) => {
  // protects=the state filters run in the API, so D-4 (decided 92 days ago, review due) is
  // found under Needs me and Review due behind 250 newer decisions, and All pages 200 at a
  // time; fails_when=a filter only looks at the newest 200 rows or the rest cannot be reached;
  // no_claim=the "large" mock scenario stands in for a company with a long log.
  await page.addInitScript((key) => localStorage.setItem(key, "large"), MOCK_SCENARIO_KEY);
  await login(page, APPROVER);
  await page.goto("/company/decisions");
  await expect(chip(page, "State", "Needs me")).toHaveAttribute("aria-pressed", "true");
  await expect(row(page, "Price the team plan per seat")).toContainText("Review due");
  await chip(page, "State", "Review due").click();
  await expect(row(page, "Price the team plan per seat")).toBeVisible();
  await expect(rows(page)).toHaveCount(1);
  await chip(page, "State", "All").click();
  await expect(rows(page)).toHaveCount(200);
  await page.getByRole("button", { name: "Show more" }).click();
  await expect(rows(page)).toHaveCount(255);
  await expect(row(page, "Price the team plan per seat")).toBeVisible();
  await expect(page.getByRole("button", { name: "Show more" })).toHaveCount(0);
});
