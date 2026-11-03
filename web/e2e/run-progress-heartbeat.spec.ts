import { expect, test } from "./test";

import { MOCK_TICK_ERRORS_KEY } from "../lib/api/mock/runs";
import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";

// run-progress: a running step whose agents send no heartbeat but wrote proposals shows that
// work, not "no heartbeat yet", and a cost SwarmCloud has not reported reads "Cost not
// reported yet", not "$0.00". "Refresh progress" counts only the runs at work and names each
// run it could not check, with why and a link to it.

async function startRoadmap(page: import("@playwright/test").Page) {
  await login(page);
  await page.getByRole("navigation", { name: "Oracle" }).getByRole("link", { name: "Plan", exact: true }).click();
  await page.getByTestId("plan-tabs").filter({ visible: true }).getByRole("link", { name: "Roadmap documents" }).click();
  await page.getByTestId("approved-prd").filter({ hasText: "Usage alerts PRD" }).getByRole("button", { name: "Build roadmap" }).click();
  const dialog = page.getByRole("dialog", { name: "Build roadmap" });
  await dialog.getByRole("button", { name: "Estimate" }).click();
  await dialog.getByRole("button", { name: "Start run" }).click();
  await expect(page).toHaveURL(/\/runs\/[0-9a-f-]+$/);
}

test("a step that wrote proposals shows that work, and an unreported cost says so", async ({ page }) => {
  await page.addInitScript((key) => localStorage.setItem(key, "quiet-agents"), MOCK_SCENARIO_KEY);
  await startRoadmap(page);
  const items = page.getByTestId("segment-roadmap_items");
  const progress = items.getByTestId("segment-progress");
  await expect(progress.getByTestId("segment-cost")).toHaveText("Cost not reported yet");
  await expect(progress).not.toContainText("$0.00");

  await page.getByRole("button", { name: "Refresh progress" }).click();
  await expect(page.getByTestId("tick-result")).toHaveText(/^Checked \d+ active runs? at .+: .+\.$/);
  const agent = items.getByTestId("segment-agent").first();
  await expect(agent).toContainText("Running");
  await expect(agent.getByTestId("agent-elapsed")).toHaveText(/^5m elapsed$/);
  await expect(agent.getByTestId("agent-heartbeat")).toHaveText(/^12 proposals written, last \d+s ago$/);
  await expect(agent).not.toContainText("no heartbeat yet");
  await expect(progress.getByTestId("segment-cost")).toHaveText("Cost not reported yet");
  await expect(progress).not.toContainText("$0.00");
  await expect(progress).toContainText(/· checked \d+[smh] ago/);
});

test("a check that could not read a run names it, says why and links to it", async ({ page }) => {
  await page.addInitScript(([key]) => localStorage.setItem(key, "1"), [MOCK_TICK_ERRORS_KEY] as const);
  await startRoadmap(page);
  const here = page.url();
  await page.getByRole("button", { name: "Refresh progress" }).click();
  const result = page.getByTestId("tick-result");
  // Only this run is at work: one active run, and the run it could not read is named.
  await expect(result).toContainText(/^Checked 1 active run at .+: .+\./);
  const unchecked = result.getByTestId("tick-unchecked");
  await expect(unchecked).toHaveCount(1);
  await expect(unchecked).toContainText(/could not be checked: SwarmCloud did not answer \(HTTP 503 unavailable\)\.$/);
  await expect(result).not.toContainText(/\d+ runs? could not be checked/);
  const link = unchecked.getByRole("link");
  const name = (await link.textContent()) ?? "";
  expect(name).not.toBe("");
  await link.click();
  await expect(page).not.toHaveURL(here);
  await expect(page).toHaveURL(/\/runs\/[0-9a-f-]+$/);
  await expect(page.getByRole("heading", { level: 1 })).toContainText(name.split(" · ").pop() ?? name);
});
