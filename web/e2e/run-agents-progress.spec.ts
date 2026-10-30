import { expect, test } from "./test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";

// #258: a running segment shows its agents (role, state, elapsed time, last heartbeat) and
// the cost spent so far; "Refresh progress" says what it checked. In the "slow-agents"
// scenario the agents take two checks to finish a segment.

test("a running segment shows its agents and the cost so far, and Refresh progress says what it checked", async ({ page }) => {
  await page.addInitScript((key) => localStorage.setItem(key, "slow-agents"), MOCK_SCENARIO_KEY);
  await login(page);
  await page.getByRole("navigation", { name: "Oracle" }).getByRole("link", { name: "Plan", exact: true }).click();
  await page.getByTestId("plan-tabs").filter({ visible: true }).getByRole("link", { name: "Roadmap documents" }).click();
  await page.getByTestId("approved-prd").filter({ hasText: "Usage alerts PRD" }).getByRole("button", { name: "Build roadmap" }).click();
  const dialog = page.getByRole("dialog", { name: "Build roadmap" });
  await dialog.getByRole("button", { name: "Estimate" }).click();
  await dialog.getByRole("button", { name: "Start run" }).click();
  await expect(page).toHaveURL(/\/runs\/[0-9a-f-]+$/);

  // Started, not checked yet: the segment says so rather than a bare "Running".
  const items = page.getByTestId("segment-roadmap_items");
  await expect(items.getByTestId("segment-state")).toHaveText("Running");
  const progress = items.getByTestId("segment-progress");
  await expect(progress).toContainText("$0.00 spent so far");
  await expect(progress).toContainText("Not checked yet");

  // The first check: the agents are working; each shows its role, state, elapsed time and
  // last heartbeat, and the cost so far reaches the segment and the run.
  await page.getByRole("button", { name: "Refresh progress" }).click();
  await expect(page.getByTestId("tick-result")).toHaveText(/^Checked \d+ active runs? at .+: .+\.$/);
  const agents = items.getByTestId("segment-agent");
  await expect(agents).not.toHaveCount(0);
  const first = agents.first();
  await expect(first.getByTestId("agent-role")).not.toBeEmpty();
  await expect(first).toContainText("Running");
  await expect(first.getByTestId("agent-elapsed")).toHaveText(/^\d+[smh]/);
  await expect(first.getByTestId("agent-heartbeat")).toContainText("last heartbeat");
  await expect(progress).not.toContainText("$0.00 spent so far");
  await expect(progress).toContainText(/\$\d+\.\d\d spent so far · checked/);
  await expect(page.getByTestId("run-details").getByTestId("run-spent")).not.toHaveText("$0.00");

  // The second check: the segment finished, and the result says so.
  await page.getByRole("button", { name: "Refresh progress" }).click();
  await expect(page.getByTestId("tick-result")).toHaveText(/^Checked \d+ active runs? at .+: \d+ segments? finished\.$/);
  await expect(items.getByTestId("segment-agent")).toHaveCount(0);
  await expect(items.getByTestId("segment-progress")).toHaveCount(0);
});

// Review fix: a segment that starts during a check (the one before it has its stop turned
// off) shows what that check read, not "Not checked yet".
test("a segment that starts during Refresh progress shows what that check read", async ({ page }) => {
  await page.addInitScript((key) => localStorage.setItem(key, "slow-agents"), MOCK_SCENARIO_KEY);
  await login(page);
  await page.getByTestId("nav-prds").filter({ visible: true }).first().click();
  await expect(page).toHaveURL(/\/documents$/);
  await page.getByRole("link", { name: "New PRD" }).click();
  await expect(page).toHaveURL(/\/documents\/new\?kind=prd$/);
  await page.getByRole("textbox", { name: "Title" }).fill("Saved carts across devices");
  await page.getByRole("textbox", { name: "What problem does it solve?" }).fill("Shoppers lose their cart when they switch from phone to laptop.");
  await page.getByRole("button", { name: "Continue" }).first().click();
  await expect(page).toHaveURL(/\/intakes\/[0-9a-f-]+$/);
  await page.getByRole("button", { name: "Draft with Oracle" }).click();
  const sheet = page.getByRole("dialog", { name: "Draft with Oracle" });
  await sheet.getByRole("switch", { name: "Feature set and dependencies" }).click();
  await expect(sheet.getByRole("switch", { name: "Feature set and dependencies" })).not.toBeChecked();
  // F4 (#181): the Engineering check, on by default, would run between the feature set and the
  // priority order; off, its segment is skipped and the priority order follows the feature set.
  await sheet.getByRole("switch", { name: "Engineering check" }).click();
  await expect(sheet.getByRole("switch", { name: "Engineering check" })).not.toBeChecked();
  await sheet.getByRole("button", { name: "Estimate" }).click();
  await sheet.getByRole("button", { name: "Start drafting" }).click();
  await expect(page).toHaveURL(/\/runs\/[0-9a-f-]+$/);

  const features = page.getByTestId("segment-feature_set");
  const priority = page.getByTestId("segment-priority");
  await expect(features.getByTestId("segment-state")).toHaveText("Running");
  // The first check reads the feature set's agents working.
  await page.getByRole("button", { name: "Refresh progress" }).click();
  await expect(features.getByTestId("segment-agent")).not.toHaveCount(0);
  // The second finishes it; with its stop off, the priority order starts in the same check.
  await page.getByRole("button", { name: "Refresh progress" }).click();
  await expect(page.getByTestId("tick-result")).toHaveText(/: 1 segment finished\.$/);
  await expect(priority.getByTestId("segment-state")).toHaveText("Running");
  const progress = priority.getByTestId("segment-progress");
  await expect(progress).toContainText(/spent so far · checked \d+[smh] ago/);
  await expect(progress).not.toContainText("Not checked yet");
  await expect(priority.getByTestId("segment-agent")).not.toHaveCount(0);
});
