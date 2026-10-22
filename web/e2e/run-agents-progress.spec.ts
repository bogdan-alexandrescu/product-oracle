import { expect, test } from "@playwright/test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";

// #258: a running segment shows its agents (role, state, elapsed time, last heartbeat) and
// the cost spent so far; "Check agents now" says what it checked. In the "slow-agents"
// scenario the agents take two checks to finish a segment.

test("a running segment shows its agents and the cost so far, and Check agents now says what it checked", async ({ page }) => {
  await page.addInitScript((key) => localStorage.setItem(key, "slow-agents"), MOCK_SCENARIO_KEY);
  await login(page);
  await page.getByRole("navigation", { name: "Oracle" }).getByRole("link", { name: "Roadmap" }).click();
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
  await page.getByRole("button", { name: "Check agents now" }).click();
  await expect(page.getByTestId("tick-result")).toHaveText(/^Checked 1 active run at .+: no segment finished yet\.$/);
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
  await page.getByRole("button", { name: "Check agents now" }).click();
  await expect(page.getByTestId("tick-result")).toHaveText(/^Checked 1 active run at .+: 1 segment finished\.$/);
  await expect(items.getByTestId("segment-agent")).toHaveCount(0);
  await expect(items.getByTestId("segment-progress")).toHaveCount(0);
});
