import { expect, test, type Page } from "@playwright/test";

import { BEFORE_DRAFTING } from "../lib/api/mock/intake";
import { login } from "./helpers";

/*
 * #343: the brief page (/intakes/<id>) handles knowledge gaps and intake proposals in the
 * UI. The "before-drafting" mock scenario is one brief by admin@example.com (the owner and
 * the brief's author) with Oracle's seventeen gaps, a PRD patch proposed from the customer
 * answer, and two findings from the author's own sources (one private, one at counts).
 *
 * Test cards:
 * - "add and triage": protects=a person adds a gap by hand and triages it (importance, owner,
 *   sections, stop condition, defer, reopen); fails_when=any field does not save or show;
 *   no_claim=the engine's question drafting.
 * - "research and accept": protects=Research this proposes a run, accept starts it;
 *   fails_when=the proposal does not appear, or accepting leaves no run link.
 * - "PRD patch": protects=a PRD patch shows what it adds and can be dismissed with a reason.
 * - "sharing": protects=the author sets what others see of a finding; it holds on reload.
 * - "roles": protects=a viewer sees every control disabled with the reason; a commenter adds
 *   and researches but does not triage or accept.
 * - "phone": protects=the gaps and proposals tabs on a 390 px screen, no sideways scroll.
 */

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (!localStorage.getItem("po-mock-scenario")) localStorage.setItem("po-mock-scenario", "before-drafting");
  });
});

async function openTab(page: Page, tab: "Gaps" | "Proposals" | "Findings") {
  await page.goto(`/intakes/${BEFORE_DRAFTING.intakeId}`);
  await expect(page.getByRole("heading", { level: 1, name: BEFORE_DRAFTING.title })).toBeAttached();
  await page.getByRole("tab", { name: new RegExp(`^${tab}`) }).click();
}

const gaps = (page: Page) => page.getByTestId("intake-gaps");
const gapRow = (page: Page, text: string) => gaps(page).getByTestId("gap-row").filter({ hasText: text });
const proposals = (page: Page) => page.getByTestId("intake-proposals");

test("add and triage: add a gap by hand, set its fields, defer and reopen it", async ({ page }) => {
  await login(page);
  await openTab(page, "Gaps");
  await gaps(page).getByRole("button", { name: "Add a gap" }).click();
  const add = gaps(page).getByTestId("gap-add");
  await add.getByRole("button", { name: "Add gap" }).click();
  await expect(add).toContainText("Say what is not known");
  await add.getByLabel("Category").selectOption("non_goals");
  await add.getByLabel("What is not known").fill("Is gift wrapping out of scope for the first release?");
  await add.getByLabel("Importance").selectOption("high");
  await add.getByLabel("Sections").fill("scope.non_goals");
  await add.getByRole("button", { name: "Add gap" }).click();

  const row = gapRow(page, "Is gift wrapping out of scope");
  await expect(row).toContainText("Non-goals");
  await expect(row).toContainText("High");
  await expect(row).toContainText("scope.non_goals");

  await row.getByRole("button", { name: "Triage" }).click();
  const triage = row.getByTestId("gap-triage");
  await triage.getByLabel("Importance").selectOption("medium");
  await triage.getByLabel("Sections").fill("scope.non_goals, launch.rollout");
  await triage.getByLabel("Stop condition").fill("The team names what the first release leaves out.");
  await triage.getByRole("button", { name: "Choose an owner" }).click();
  await triage.getByRole("option", { name: /Approver/ }).click();
  await triage.getByRole("button", { name: "Save" }).click();
  await expect(triage).toHaveCount(0);
  await expect(row).toContainText("Medium");
  await expect(row).toContainText("launch.rollout");
  await expect(row).toContainText("Stop when: The team names what the first release leaves out.");
  await expect(row).toContainText("Owner: Approver");

  await row.getByRole("button", { name: "Defer" }).click();
  await expect(row.getByTestId("gap-status")).toHaveText("Deferred");
  await row.getByRole("button", { name: "Reopen" }).click();
  await expect(row.getByTestId("gap-status")).toHaveText("Not known");
});

test("lowering a critical gap's importance below owner is refused with the API's reason", async ({ page }) => {
  await login(page, "approver@example.com");
  await openTab(page, "Gaps");
  const row = gapRow(page, "Security and privacy");
  await row.getByRole("button", { name: "Triage" }).click();
  await row.getByTestId("gap-triage").getByLabel("Importance").selectOption("low");
  await row.getByTestId("gap-triage").getByRole("button", { name: "Save" }).click();
  await expect(row.getByTestId("gap-triage")).toContainText("Lowering a critical gap's importance needs an owner");
});

test("research and accept: Research this proposes a run, accepting it starts one", async ({ page }) => {
  await login(page);
  await openTab(page, "Gaps");
  const row = gapRow(page, "Effort and cost");
  await row.getByRole("button", { name: "Research this" }).click();
  await expect(row.getByTestId("gap-status")).toHaveText("Under investigation");
  await expect(row).toContainText("Research proposed");

  await page.getByRole("tab", { name: /^Proposals/ }).click();
  const card = proposals(page).getByTestId("proposal").filter({ hasText: "Research: Effort and cost" });
  await expect(card.getByTestId("proposal-diff")).toContainText("Depth: quick");
  await card.getByRole("button", { name: "Accept" }).click();
  await expect(card.getByTestId("proposal-status")).toHaveText("Accepted");
  await expect(card.getByRole("link", { name: "Open the run" })).toHaveAttribute("href", /\/runs\//);
});

test("PRD patch: shows what it adds to the PRD, and is dismissed with a reason", async ({ page }) => {
  await login(page);
  await openTab(page, "Proposals");
  const card = proposals(page).getByTestId("proposal").filter({ hasText: "Add to the PRD: Customer and user" });
  const diff = card.getByTestId("proposal-diff");
  await expect(diff).toContainText("saved-addresses v2");
  await expect(diff).toContainText("context.users");
  await expect(diff.locator("ins")).toContainText("Returning buyers on the web shop, signed in.");
  await card.getByRole("button", { name: "Dismiss" }).click();
  await card.getByLabel("Reason (optional)").fill("Already covered in the PRD.");
  await card.getByRole("button", { name: "Dismiss proposal" }).click();
  await expect(card.getByTestId("proposal-status")).toHaveText("Dismissed");
  await expect(card).toContainText("Already covered in the PRD.");
  await expect(card.getByRole("button", { name: "Accept" })).toHaveCount(0);
});

test("sharing: the author sets what others see of a finding, and it holds", async ({ page }) => {
  await login(page);
  await openTab(page, "Findings");
  const finding = page.getByTestId("intake-findings").getByTestId("finding").filter({ hasText: "Support tickets mention retyping" });
  const level = finding.getByRole("group", { name: "Who sees this finding" });
  await expect(level.getByRole("button", { name: "Private" })).toHaveAttribute("aria-pressed", "true");
  await level.getByRole("button", { name: "Summary" }).click();
  await expect(level.getByRole("button", { name: "Summary" })).toHaveAttribute("aria-pressed", "true");
  await page.reload();
  await page.getByRole("tab", { name: /^Findings/ }).click();
  await expect(level.getByRole("button", { name: "Summary" })).toHaveAttribute("aria-pressed", "true");
});

test("roles: a viewer sees every control disabled, with the reason", async ({ page }) => {
  await login(page, "viewer@example.com");
  await openTab(page, "Gaps");
  await expect(gaps(page).getByRole("button", { name: "Add a gap" })).toBeDisabled();
  await expect(gaps(page).getByTestId("gaps-role-note")).toContainText("A commenter adds gaps and asks for research; an approver triages them");
  const row = gapRow(page, "Effort and cost");
  await expect(row.getByRole("button", { name: "Triage" })).toBeDisabled();
  await expect(row.getByRole("button", { name: "Research this" })).toBeDisabled();
  await expect(row.getByRole("button", { name: "Defer" })).toBeDisabled();

  await page.getByRole("tab", { name: /^Proposals/ }).click();
  await expect(proposals(page).getByTestId("proposals-role-note")).toContainText("An approver accepts or dismisses proposals");
  const card = proposals(page).getByTestId("proposal").first();
  await expect(card.getByRole("button", { name: "Accept" })).toBeDisabled();
  await expect(card.getByRole("button", { name: "Dismiss" })).toBeDisabled();

  await page.getByRole("tab", { name: /^Findings/ }).click();
  const findings = page.getByTestId("intake-findings");
  await expect(findings.getByTestId("findings-role-note")).toContainText("Only the brief's author sets what others see");
  // The private finding is not shown to others; the one at counts is, with its control disabled.
  await expect(findings.getByTestId("finding")).toHaveCount(1);
  await expect(findings.getByRole("button", { name: "Full" })).toBeDisabled();
});

test("roles: a commenter adds a gap and asks for research, but does not triage or accept", async ({ page }) => {
  await login(page, "commenter@example.com");
  await openTab(page, "Gaps");
  await expect(gaps(page).getByTestId("gaps-role-note")).toContainText("An approver triages gaps");
  const row = gapRow(page, "Alternatives");
  await expect(row.getByRole("button", { name: "Triage" })).toBeDisabled();
  await row.getByRole("button", { name: "Research this" }).click();
  await expect(row).toContainText("Research proposed");
  await page.getByRole("tab", { name: /^Proposals/ }).click();
  await expect(proposals(page).getByTestId("proposal").filter({ hasText: "Research: Alternatives" }).getByRole("button", { name: "Accept" })).toBeDisabled();
});

test("phone: gaps and proposals fit a 390 px screen", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  await openTab(page, "Gaps");
  await gaps(page).getByRole("button", { name: "Add a gap" }).click();
  await expect(gaps(page).getByTestId("gap-add")).toBeVisible();
  const wide = () => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(await wide()).toBeLessThanOrEqual(0);
  await page.getByRole("tab", { name: /^Proposals/ }).click();
  await expect(proposals(page).getByTestId("proposal").first()).toBeVisible();
  expect(await wide()).toBeLessThanOrEqual(0);
});

test("dark theme: gap rows use the theme's text on its surface", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("oracle-theme", "dark"));
  await login(page);
  await openTab(page, "Gaps");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  const row = gaps(page).getByTestId("gap-row").first();
  const [text, ground] = await row.evaluate((el) => [getComputedStyle(el).color, getComputedStyle(document.body).backgroundColor]);
  // Light text on a dark ground: the text's red channel is well above the ground's.
  const red = (c: string) => Number(c.match(/\d+/)?.[0] ?? 0);
  expect(red(text) - red(ground)).toBeGreaterThan(100);
});
