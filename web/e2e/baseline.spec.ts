import { expect, test, type Page } from "@playwright/test";

import { login } from "./helpers";

async function openBaseline(page: Page) {
  await login(page);
  await page.goto("/baseline");
  await expect(page.getByRole("heading", { level: 1, name: "Baseline" })).toBeVisible();
  await expect(page.getByTestId("goal-g.activation")).toBeVisible();
}

const drawer = (page: Page, title: string) => page.getByRole("dialog", { name: title });

test("baseline: goals with weight, metric, target and horizon", async ({ page }) => {
  await openBaseline(page);
  await expect(page.getByRole("tab", { name: /Graph/ })).toHaveAttribute("aria-selected", "true");

  const goals = page.getByRole("grid", { name: "Goals" }).getByTestId(/^goal-/);
  await expect(goals).toHaveCount(3);

  const activation = page.getByTestId("goal-g.activation");
  await expect(activation).toContainText("Raise activation");
  await expect(activation.locator('[data-attr="weight"]')).toHaveText("0.5");
  await expect(activation.locator('[data-attr="metric"]')).toHaveText("Accounts that finish setup within 7 days");
  await expect(activation.locator('[data-attr="target"]')).toHaveText("45%");
  await expect(activation.locator('[data-attr="horizon"]')).toHaveText("2026-Q4");
  await expect(activation).toContainText("Confirmed");
  // Confidence is a ring, 0-100.
  await expect(activation.getByTestId("confidence")).toHaveText("78");
  await expect(activation.getByTestId("confidence")).toHaveAttribute("data-tone", "green");

  const paid = page.getByTestId("goal-g.paid-conversion");
  await expect(paid.locator('[data-attr="target"]')).toHaveText("12%");
  await expect(paid.locator('[data-attr="horizon"]')).toHaveText("2027-H1");

  // Only the proposed goal offers Confirm.
  await expect(page.getByTestId("goal-g.early-churn")).toContainText("Proposed");
  await expect(page.getByRole("grid", { name: "Goals" }).getByRole("button", { name: "Confirm" })).toHaveCount(1);
});

test("baseline: an approver confirms the proposed goal", async ({ page }) => {
  await openBaseline(page);
  const churn = page.getByTestId("goal-g.early-churn");
  await churn.getByRole("button", { name: "Confirm" }).click();
  await expect(page.getByRole("status")).toContainText("Confirmed “Cut early churn”");
  await expect(churn).toContainText("Confirmed");
  await expect(churn.getByRole("button", { name: "Confirm" })).toHaveCount(0);
  // Confirming is a person's decision, so it locks the goal.
  await expect(churn).toContainText("Locked");

  // A confirmed goal with no features now counts as uncovered.
  await page.getByRole("tab", { name: /Flagged/ }).click();
  await expect(page.getByLabel("Summary")).toContainText("Uncovered goals1");
});

test("baseline: products with their features, and an Unassigned group", async ({ page }) => {
  await openBaseline(page);
  const storefront = page.getByTestId("product-p.storefront");
  await expect(storefront).toHaveAccessibleName("Features of Storefront");
  await expect(storefront.getByTestId(/^feature-/)).toHaveText([
    /Guided setup/,
    /Sample data/,
    /Saved carts/,
  ]);
  const admin = page.getByTestId("product-p.admin-console");
  await expect(admin.getByTestId(/^feature-/)).toHaveText([/Dark mode/, /Team invites/]);
  const unassigned = page.getByTestId("product-unassigned");
  await expect(unassigned).toContainText("Unassigned");
  await expect(unassigned.getByTestId(/^feature-/)).toHaveText([/Usage export/]);

  // Flags from the trace report sit on the feature rows.
  await expect(page.getByTestId("feature-f.dark-mode").getByTestId("flag")).toHaveText(["Serves no goal"]);
  await expect(page.getByTestId("feature-f.saved-carts").getByTestId("flag")).toHaveText(["Low confidence"]);
  await expect(page.getByTestId("feature-f.guided-setup").getByTestId("flag")).toHaveCount(0);
  await expect(page.getByTestId("feature-f.guided-setup")).toContainText("Locked");
  await expect(page.getByTestId("feature-f.saved-carts").getByTestId("confidence")).toHaveAttribute("data-tone", "red");
});

test("baseline: the feature drawer shows links, evidence and the lock", async ({ page }) => {
  await openBaseline(page);
  await page.getByTestId("feature-f.guided-setup").getByRole("button", { name: "Guided setup" }).click();
  const d = drawer(page, "Guided setup");
  await expect(d).toBeVisible();
  await expect(d).toContainText("f.guided-setup");
  await expect(d).toContainText("Feature");
  await expect(d).toContainText("A short checklist that walks a new account");
  await expect(d.locator('[data-attr="effort"]')).toHaveText("M");

  // Supports, with contribution 0-3, strongest first.
  const supports = d.getByRole("list", { name: "Supports" }).getByRole("listitem");
  await expect(supports).toHaveText([/Raise activation\s*contribution 3\/3/, /Grow paid conversion\s*contribution 1\/3/]);
  await expect(d.getByRole("list", { name: "Depends on" })).toHaveText(/Sample data/);
  await expect(d.getByRole("list", { name: "Blocks" })).toHaveText(/Saved carts/);

  // Lock: who and when, with Unlock for approvers.
  await expect(d.getByTestId("lock-note")).toContainText("Locked by member");
  await expect(d.getByTestId("lock-note")).toContainText("Oct 15");
  await expect(d.getByRole("button", { name: "Unlock" })).toBeVisible();

  // Evidence chips: source kind and confidence badge.
  const chips = d.getByTestId("evidence-chip");
  await expect(chips).toHaveCount(3);
  await expect(chips.nth(0)).toContainText("GitHub issue");
  await expect(chips.nth(0).getByTestId("confidence")).toHaveText("0.80");
  await expect(chips.nth(0).getByTestId("confidence")).toHaveAttribute("data-tone", "green");
  await expect(chips.nth(1)).toContainText("Slack");
  await expect(chips.nth(1).getByTestId("confidence")).toHaveAttribute("data-tone", "amber");

  // Clicking pins the card: excerpt, link and the factor breakdown.
  await chips.nth(0).click();
  const card = page.getByRole("tooltip");
  await expect(card).toContainText("New accounts stall before adding a payment method");
  await expect(card).toContainText("example-org/storefront#128");
  await expect(card.getByRole("link", { name: /Open source/ })).toHaveAttribute("href", /issues\/128/);
  const factors = card.getByRole("table", { name: "Confidence factors" }).getByRole("row");
  await expect(factors).toHaveText([
    /Factor\s*Value\s*Weight/,
    /Source\s*0\.90\s*0\.35/,
    /Freshness\s*0\.85\s*0\.25/,
    /Mentions\s*0\.60\s*0\.20/,
    /Goal impact\s*0\.75\s*0\.20/,
  ]);
  await expect(card.getByTestId("private-note")).toHaveCount(0);

  // Escape closes the card but keeps the drawer open.
  await page.keyboard.press("Escape");
  await expect(page.getByRole("tooltip")).toHaveCount(0);
  await expect(d).toBeVisible();

  // Someone else's private source: the excerpt only.
  await chips.nth(1).click();
  const privateCard = page.getByRole("tooltip");
  await expect(privateCard).toContainText("Support keeps walking people through");
  await expect(privateCard.getByTestId("private-note")).toHaveText(
    "From another person's private source: you see the excerpt, not the item.",
  );

  // Links open the linked item in the drawer.
  await d.getByRole("list", { name: "Depends on" }).getByRole("button", { name: "Sample data" }).click();
  await expect(drawer(page, "Sample data")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("baseline: evidence from a removed source item says 'source removed' and no longer links out", async ({ page }) => {
  await openBaseline(page);
  await page.getByTestId("feature-f.guided-setup").getByRole("button", { name: "Guided setup" }).click();
  const d = drawer(page, "Guided setup");
  const chips = d.getByTestId("evidence-chip");
  await expect(chips).toHaveCount(3);
  // The mock's meeting was narrowed out of its source (S5): a muted badge on the chip.
  await expect(chips.nth(2)).toContainText("Meeting notes");
  await expect(chips.nth(2).getByTestId("source-removed")).toHaveText("source removed");
  await expect(chips.nth(2)).toHaveAttribute("aria-label", /source removed/);
  await expect(chips.nth(0).getByTestId("source-removed")).toHaveCount(0);
  // The card keeps the stored title and excerpt, says why, and has no link out.
  await chips.nth(2).click();
  const card = page.getByRole("tooltip");
  await expect(card).toContainText("Onboarding review");
  await expect(card).toContainText("Agreed to ship the checklist");
  await expect(card.getByTestId("source-removed-note")).toContainText("Source removed");
  await expect(card.getByRole("link", { name: /Open source/ })).toHaveCount(0);
});

test("baseline: editing a feature saves and locks it; unlock releases it", async ({ page }) => {
  await openBaseline(page);
  const row = page.getByTestId("feature-f.sample-data");
  await expect(row).not.toContainText("Locked");
  await row.getByRole("button", { name: "Sample data" }).click();
  const d = drawer(page, "Sample data");
  await expect(d.getByTestId("lock-note")).toHaveCount(0);

  await d.getByRole("button", { name: "Edit" }).click();
  const form = d.getByRole("form", { name: "Edit" });
  await expect(form).toContainText("Saving locks this item");
  await form.getByLabel("Title").fill("Sample store data");
  await form.getByLabel("Delivery status").fill("in_progress");
  await form.getByLabel("Effort").fill("M");
  await form.getByRole("button", { name: "Save" }).click();

  const edited = drawer(page, "Sample store data");
  await expect(edited.getByRole("status")).toContainText("now locked against agent changes");
  await expect(edited.getByTestId("lock-note")).toContainText("Locked by you");
  await expect(edited.locator('[data-attr="effort"]')).toHaveText("M");
  await expect(edited.locator('[data-attr="status"]')).toHaveText("In progress");
  await expect(row).toContainText("Sample store data");
  await expect(row).toContainText("Locked");

  // An approver's edit to a locked item applies too, and keeps it locked.
  await edited.getByRole("button", { name: "Edit" }).click();
  await edited.getByRole("form", { name: "Edit" }).getByLabel("Effort").fill("L");
  await edited.getByRole("form", { name: "Edit" }).getByRole("button", { name: "Save" }).click();
  await expect(edited.locator('[data-attr="effort"]')).toHaveText("L");
  await expect(edited.getByTestId("lock-note")).toBeVisible();

  await edited.getByRole("button", { name: "Unlock" }).click();
  await expect(edited.getByTestId("lock-note")).toHaveCount(0);
  await expect(row).not.toContainText("Locked");
});

test("baseline: flagged tab lists the feature that serves no goal, with goal coverage", async ({ page }) => {
  await openBaseline(page);
  const tab = page.getByRole("tab", { name: /Flagged/ });
  await expect(tab.getByTestId("tab-count-flagged")).toHaveText("3");
  await tab.click();

  await expect(page.getByTestId("flagged-f.dark-mode")).toContainText("Dark mode");
  await expect(page.getByTestId("flagged-f.dark-mode").getByTestId("flag")).toHaveText(["Serves no goal"]);
  await expect(page.getByTestId("flagged-f.saved-carts").getByTestId("flag")).toHaveText(["Low confidence"]);
  await expect(page.getByTestId("flagged-f.usage-export").getByTestId("flag")).toHaveText(["No evidence"]);
  await expect(page.getByTestId("flagged-f.guided-setup")).toHaveCount(0);

  const summary = page.getByLabel("Summary");
  await expect(summary).toContainText("Flagged3");
  await expect(summary).toContainText("Serve no goal1");
  await expect(summary).toContainText("Weak evidence2");

  const activation = page.getByTestId("coverage-g.activation");
  await expect(activation.locator('[data-col="features"]')).toHaveText("3");
  await expect(activation.locator('[data-col="coverage"]')).toHaveText("6");
  await expect(page.getByTestId("coverage-g.early-churn").locator('[data-col="features"]')).toHaveText("0");
});

test("baseline: an approver resolves an open material conflict by picking a claim", async ({ page }) => {
  await openBaseline(page);
  const tab = page.getByRole("tab", { name: /Conflicts/ });
  await expect(tab.getByTestId("tab-count-conflicts")).toHaveText("1");
  await tab.click();

  const conflicts = page.getByTestId("conflict");
  await expect(conflicts).toHaveCount(2);
  const open = conflicts.filter({ hasText: "Saved carts" });
  await expect(open.getByTestId("conflict-field")).toHaveText("status");
  await expect(open.getByTestId("conflict-status")).toHaveText("Open");
  await expect(open).toContainText("Material");
  await expect(open.getByTestId("conflict-rule")).toContainText("code beats tracker");
  const claims = open.getByTestId("claim");
  await expect(claims).toHaveCount(2);
  await expect(claims.nth(0)).toContainText("in_progress");
  await expect(claims.nth(0)).toContainText("GitHub pull request");
  await expect(claims.nth(0).getByTestId("confidence")).toHaveText("0.52");
  await expect(claims.nth(1)).toContainText("Linear");

  const logged = conflicts.filter({ hasText: "Raise activation" });
  await expect(logged.getByTestId("conflict-status")).toHaveText("Logged");
  await expect(logged.getByRole("button", { name: /Pick/ })).toHaveCount(0);

  await claims.nth(0).getByRole("button", { name: "Pick in_progress" }).click();
  await expect(open.getByTestId("conflict-status")).toHaveText("Resolved");
  await expect(open).toContainText("Set to in_progress");
  await expect(open.getByRole("button", { name: /Pick/ })).toHaveCount(0);
  await expect(tab.getByTestId("tab-count-conflicts")).toHaveText("0");

  // The pick is a person's write: it locks the feature.
  await page.getByRole("tab", { name: /Graph/ }).click();
  await expect(page.getByTestId("feature-f.saved-carts")).toContainText("In progress");
  await expect(page.getByTestId("feature-f.saved-carts")).toContainText("Locked");
});

test("baseline: an approver accepts and rejects proposals", async ({ page }) => {
  await openBaseline(page);
  const tab = page.getByRole("tab", { name: /Proposals/ });
  await expect(tab.getByTestId("tab-count-proposals")).toHaveText("3");
  await tab.click();

  const proposals = page.getByTestId("proposal");
  await expect(proposals).toHaveCount(3);
  const onLocked = proposals.filter({ hasText: "Guided setup" });
  await expect(onLocked).toContainText("update");
  await expect(onLocked).toContainText("attrs.effort:L");
  await expect(onLocked).toContainText("The setup review estimated more work than planned.");
  await expect(onLocked).toContainText("From run · Baseline to PRD · Oct 16");

  await onLocked.getByRole("button", { name: "Accept" }).click();
  await expect(page.getByRole("status")).toContainText("Proposal accepted");
  await expect(proposals).toHaveCount(2);
  await expect(tab.getByTestId("tab-count-proposals")).toHaveText("2");

  const darkMode = proposals.filter({ hasText: "Dark mode" });
  await darkMode.getByRole("button", { name: "Reject" }).click();
  await expect(proposals).toHaveCount(1);
  await expect(tab.getByTestId("tab-count-proposals")).toHaveText("1");
  await proposals.filter({ hasText: "Team invites" }).getByRole("button", { name: "Reject" }).click();
  await expect(page.getByText("No open proposals.")).toBeVisible();
  await expect(tab.getByTestId("tab-count-proposals")).toHaveText("0");

  // The accepted change is applied to the feature; the rejected one is not.
  await page.getByRole("tab", { name: /Graph/ }).click();
  await page.getByTestId("feature-f.guided-setup").getByRole("button", { name: "Guided setup" }).click();
  await expect(drawer(page, "Guided setup").locator('[data-attr="effort"]')).toHaveText("L");
  await page.keyboard.press("Escape");
  await page.getByTestId("feature-f.dark-mode").getByRole("button", { name: "Dark mode" }).click();
  await expect(drawer(page, "Dark mode").locator('[data-attr="status"]')).toHaveText("Idea");
});

test("baseline: a viewer reads everything but sees no write buttons", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("po-mock-role", "viewer"));
  await openBaseline(page);

  const main = page.getByRole("main");
  await expect(page.getByTestId("goal-g.early-churn")).toContainText("Proposed");
  await expect(main.getByRole("button", { name: "Confirm" })).toHaveCount(0);

  await page.getByTestId("feature-f.guided-setup").getByRole("button", { name: "Guided setup" }).click();
  const d = drawer(page, "Guided setup");
  await expect(d.getByTestId("evidence-chip")).toHaveCount(3);
  await expect(d.getByTestId("lock-note")).toBeVisible();
  await expect(d.getByRole("button", { name: "Unlock" })).toHaveCount(0);
  await expect(d.getByRole("button", { name: "Edit" })).toHaveCount(0);
  await page.keyboard.press("Escape");

  await page.getByRole("tab", { name: /Conflicts/ }).click();
  await expect(page.getByTestId("conflict")).toHaveCount(2);
  await expect(main.getByRole("button", { name: /Pick/ })).toHaveCount(0);

  await page.getByRole("tab", { name: /Proposals/ }).click();
  await expect(page.getByTestId("proposal")).toHaveCount(3);
  await expect(main.getByRole("button", { name: "Accept" })).toHaveCount(0);
  await expect(main.getByRole("button", { name: "Reject" })).toHaveCount(0);
});

// B3 Proposals by run. The mock seeds two proposals from one Baseline to PRD run (started
// Oct 16) and one from a commenter, with no run.
const AGENT_RUN = "0b7e5d4c-3a29-4118-9f07-e6d5c4b3a291";
const RUN_LABEL = "Baseline to PRD · Oct 16";

async function openProposals(page: Page) {
  await openBaseline(page);
  await page.getByRole("tab", { name: /Proposals/ }).click();
  await expect(page.getByTestId("proposal")).toHaveCount(3);
}

/**
 * protects: the From filter and its shareable URL.
 * fails_when: another run's or a person's proposal shows under the run, the select misses
 * an entry, or choosing a run leaves the URL without run=.
 * no_claim: mock data only.
 */
test("baseline: proposals filtered by the run that made them", async ({ page }) => {
  await openProposals(page);
  const from = page.getByLabel("From");
  await expect(from).toHaveValue("");
  await expect(from.locator("option")).toHaveText(["All", "People and intake answers", RUN_LABEL]);

  await from.selectOption({ label: RUN_LABEL });
  await expect(page).toHaveURL(new RegExp(`[?&]run=${AGENT_RUN}`));
  await expect(page).toHaveURL(/[?&]tab=proposals/);
  const rows = page.getByTestId("proposal");
  await expect(rows).toHaveCount(2);
  await expect(rows.filter({ hasText: "Guided setup" })).toHaveCount(1);
  await expect(rows.filter({ hasText: "Dark mode" })).toHaveCount(1);
  await expect(rows.filter({ hasText: "Team invites" })).toHaveCount(0);
  const line = page.getByTestId("run-filter-line");
  await expect(line).toHaveText(`Proposals from ${RUN_LABEL} · Open run`);
  await expect(line.getByRole("link", { name: "Open run" })).toHaveAttribute("href", `/runs/${AGENT_RUN}`);

  await from.selectOption({ label: "People and intake answers" });
  await expect(page).toHaveURL(/[?&]run=none/);
  await expect(rows).toHaveCount(1);
  await expect(rows).toContainText("Team invites");

  await from.selectOption({ label: "All" });
  await expect(page).not.toHaveURL(/run=/);
  await expect(rows).toHaveCount(3);
});

/**
 * protects: a shared link to one run's proposals opens filtered.
 * fails_when: reloading /baseline?tab=proposals&run=<id> shows the Graph tab or every proposal.
 * no_claim: mock data only.
 */
test("baseline: reloading a run's proposals link restores the filter", async ({ page }) => {
  await openBaseline(page);
  await page.goto(`/baseline?tab=proposals&run=${AGENT_RUN}`);
  await expect(page.getByRole("tab", { name: /Proposals/ })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByLabel("From")).toHaveValue(AGENT_RUN);
  await expect(page.getByTestId("proposal")).toHaveCount(2);
  await page.reload();
  await expect(page.getByLabel("From")).toHaveValue(AGENT_RUN);
  await expect(page.getByTestId("proposal")).toHaveCount(2);
  await expect(page.getByTestId("run-filter-line")).toContainText(RUN_LABEL);
});

/**
 * protects: each proposal from a run links to that run, named in plain words.
 * fails_when: a row shows a raw run id, the link is missing, or it does not open the run.
 * no_claim: the person's name on rows not from a run (pick B4 Proposal sentences).
 */
test("baseline: each run's proposal links to its run", async ({ page }) => {
  await openProposals(page);
  const rows = page.getByTestId("proposal");
  for (const title of ["Guided setup", "Dark mode"]) {
    const link = rows.filter({ hasText: title }).getByRole("link", { name: `From run · ${RUN_LABEL}` });
    await expect(link).toHaveAttribute("href", `/runs/${AGENT_RUN}`);
  }
  await expect(rows.filter({ hasText: "Team invites" }).getByRole("link", { name: /From run/ })).toHaveCount(0);
  await expect(page.getByTestId("proposal").filter({ hasText: `run:${AGENT_RUN}` })).toHaveCount(0);

  await rows.filter({ hasText: "Guided setup" }).getByRole("link", { name: /From run/ }).click();
  await expect(page).toHaveURL(new RegExp(`/runs/${AGENT_RUN}$`));
  await expect(page.getByRole("heading", { level: 1, name: "Baseline to PRD" })).toBeVisible();
});

/**
 * protects: the run page says how many open proposals the run left and leads to them.
 * fails_when: the count is missing or stale after a proposal is accepted, or Review does not
 * land on the run's filtered proposals.
 * no_claim: mock data only.
 */
test("baseline: the run page counts its open proposals and Review opens them", async ({ page }) => {
  await login(page);
  await page.goto(`/runs/${AGENT_RUN}`);
  await expect(page.getByRole("heading", { level: 1, name: "Baseline to PRD" })).toBeVisible();
  const count = page.getByTestId("run-proposals");
  await expect(count).toHaveText("2 open · Review");
  await expect(page.getByTestId("run-proposals-row")).toContainText("Baseline proposals");

  await count.getByRole("link", { name: "Review" }).click();
  await expect(page).toHaveURL(new RegExp(`/baseline\\?tab=proposals&run=${AGENT_RUN}$`));
  const rows = page.getByTestId("proposal");
  await expect(rows).toHaveCount(2);
  await rows.filter({ hasText: "Guided setup" }).getByRole("button", { name: "Accept" }).click();
  await expect(page.getByRole("status")).toContainText("Proposal accepted");
  await expect(rows).toHaveCount(1);

  await page.getByTestId("run-filter-line").getByRole("link", { name: "Open run" }).click();
  await expect(page).toHaveURL(new RegExp(`/runs/${AGENT_RUN}$`));
  await expect(page.getByTestId("run-proposals")).toHaveText("1 open · Review");
});

/**
 * protects: the From select and the run rows on a phone.
 * fails_when: the page scrolls sideways at 390 px.
 * no_claim: other widths.
 */
test("baseline: proposals by run fit a phone", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openProposals(page);
  await expect(page.getByLabel("From")).toBeVisible();
  const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(await overflow()).toBeLessThanOrEqual(0);
  await page.getByLabel("From").selectOption({ label: RUN_LABEL });
  await expect(page.getByTestId("run-filter-line")).toBeVisible();
  expect(await overflow()).toBeLessThanOrEqual(0);
});
