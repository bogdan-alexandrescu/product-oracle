import { expect, test } from "./test";

import { MOCK_TICK_ERRORS_KEY } from "../lib/api/mock/runs";
import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";

// run-progress: a running step whose agents send no heartbeat but wrote proposals shows that
// work, not "no heartbeat yet", and a cost SwarmCloud has not reported reads "Cost not
// reported yet", not "$0.00". "Refresh progress" counts only the runs at work and names each
// run it could not check, with why and a link to it.

async function startRoadmap(page: import("@playwright/test").Page, phone = false) {
  await login(page);
  // A phone keeps the side nav folded away: Plan by its address.
  if (phone) await page.goto("/plan");
  else await page.getByRole("navigation", { name: "Oracle" }).getByRole("link", { name: "Plan", exact: true }).click();
  await page.getByTestId("plan-tabs").filter({ visible: true }).getByRole("link", { name: "Roadmap documents" }).click();
  await page.getByTestId("approved-prd").filter({ hasText: "Usage alerts PRD" }).getByRole("button", { name: "Build roadmap" }).click();
  const dialog = page.getByRole("dialog", { name: "Build roadmap" });
  await dialog.getByRole("button", { name: "Estimate" }).click();
  await dialog.getByRole("button", { name: "Start run" }).click();
  await expect(page).toHaveURL(/\/runs\/[0-9a-f-]+$/);
}

async function quietAgents(page: import("@playwright/test").Page, phone = false) {
  await page.addInitScript((key) => localStorage.setItem(key, "quiet-agents"), MOCK_SCENARIO_KEY);
  await startRoadmap(page, phone);
  const items = page.getByTestId("segment-roadmap_items");
  const progress = items.getByTestId("segment-progress");
  await expect(progress.getByTestId("segment-cost")).toHaveText("Cost not reported yet");
  await expect(progress).not.toContainText("$0.00");

  await page.getByRole("button", { name: "Refresh progress" }).click();
  await expect(page.getByTestId("tick-result")).toHaveText(/^Checked \d+ active runs? at .+: .+\.$/);
  const agent = items.getByTestId("segment-agent").first();
  await expect(agent).toContainText("Running");
  await expect(agent.getByTestId("agent-elapsed")).toHaveText(/^5m elapsed$/);
  // The run's proposals are counted once for the step, not on each of its agents.
  await expect(progress.getByTestId("segment-proposals")).toHaveText("12 proposals written");
  await expect(items.getByTestId("segment-agent")).toHaveCount(2);
  for (const each of await items.getByTestId("segment-agent").all()) {
    await expect(each.getByTestId("agent-heartbeat")).toHaveText(/^last proposal \d+s ago$/);
    await expect(each).not.toContainText("proposals written");
  }
  await expect(agent).not.toContainText("no heartbeat yet");
  await expect(progress.getByTestId("segment-cost")).toHaveText("Cost not reported yet");
  await expect(progress).not.toContainText("$0.00");
  await expect(progress).toContainText(/· checked \d+[smh] ago/);
}

async function uncheckedRun(page: import("@playwright/test").Page, phone = false) {
  await page.addInitScript(([key]) => localStorage.setItem(key, "1"), [MOCK_TICK_ERRORS_KEY] as const);
  await startRoadmap(page, phone);
  const here = page.url();
  await page.getByRole("button", { name: "Refresh progress" }).click();
  const result = page.getByTestId("tick-result");
  // Only this run is at work: one active run, and the run it could not read is named.
  await expect(result).toContainText(/^Checked 1 active run at .+: .+\./);
  const unchecked = result.getByTestId("tick-unchecked");
  await expect(unchecked).toHaveCount(1);
  await expect(unchecked).toContainText(/could not be checked: SwarmCloud had a problem on its side; the next check tries again\.$/);
  await expect(result).not.toContainText("HTTP");
  await expect(result).not.toContainText(/\d+ runs? could not be checked/);
  const link = unchecked.getByRole("link");
  const name = (await link.textContent()) ?? "";
  expect(name).not.toBe("");
  await link.click();
  await expect(page).not.toHaveURL(here);
  await expect(page).toHaveURL(/\/runs\/[0-9a-f-]+$/);
  await expect(page.getByRole("heading", { level: 1 })).toContainText(name.split(" · ").pop() ?? name);
}

async function thisRunUnchecked(page: import("@playwright/test").Page, phone = false) {
  // Every running run, this one included, could not be checked.
  await page.addInitScript(([key]) => localStorage.setItem(key, "running"), [MOCK_TICK_ERRORS_KEY] as const);
  await startRoadmap(page, phone);
  await page.getByRole("button", { name: "Refresh progress" }).click();
  const result = page.getByTestId("tick-result");
  // It leads with this run and why, not with "Checked 0 active runs".
  await expect(result).toHaveText(
    /^This run could not be checked: SwarmCloud had a problem on its side; the next check tries again\.(.*)Checked at .+\.$/,
  );
  await expect(result).not.toContainText(/Checked \d+ active runs?/);
  await expect(result.getByTestId("tick-unchecked").first()).toHaveText(/^This run could not be checked/);
}

test("a check that could not read this run leads with it", async ({ page }) => {
  await thisRunUnchecked(page);
});

test("a step that wrote proposals shows that work, and an unreported cost says so", async ({ page }) => {
  await quietAgents(page);
});

test("a check that could not read a run names it, says why and links to it", async ({ page }) => {
  await uncheckedRun(page);
});

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("on a phone, the proposals written and the unreported cost show", async ({ page }) => {
    await quietAgents(page, true);
  });

  test("on a phone, a check that could not read this run leads with it", async ({ page }) => {
    await thisRunUnchecked(page, true);
  });

  test("on a phone, the run a check could not read is named with a link", async ({ page }) => {
    await uncheckedRun(page, true);
  });
});
