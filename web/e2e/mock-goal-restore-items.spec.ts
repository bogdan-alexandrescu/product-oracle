import { GOAL_BUCKETS_THREE_GOALS_SCENARIO, MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";
import { expect, test } from "./test";

/*
 * Card mock-goal-restore-items (mock parity, train BM merge review): the mock's goal restore
 * (POST /v1/simple/goal-buckets/goals/{id}/restore) gives the roadmap's items the goals a delete moved back, as the
 * API's goal restore and the mock's /v1/trash/{id}/restore do. On "goal-buckets-three-goals" (invented data), Grow
 * retention is deleted onto another goal, then restored by that route. protects = every item's goals read as before
 * the delete; fails_when = the route restores the goal with no items (items: []), so they keep the goal they were
 * moved to; no_claim = the UI, which restores from Trash (trash-features-goals.spec.ts).
 */

test("the mock's goal restore gives the items their goals back", async ({ page }) => {
  await page.context().addInitScript(([k, v]) => localStorage.setItem(k, v), [MOCK_SCENARIO_KEY, GOAL_BUCKETS_THREE_GOALS_SCENARIO] as const);
  await login(page);
  await page.goto("/simple/priorities?tab=buckets");
  await expect(page.locator('[data-testid="plan-goal"][data-goal="Grow retention"]')).toBeVisible();
  const got = await page.evaluate(async () => {
    const f = (globalThis as { __poMockFetch?: (r: Request) => Promise<Response> }).__poMockFetch!;
    const call = async (method: string, path: string) => {
      const r = await f(new Request(new URL(path, location.origin), { method }));
      return { status: r.status, body: await r.json() };
    };
    const goals = (await call("GET", "/v1/simple/goal-buckets")).body.goals as { id: string; title: string }[];
    const grow = goals.find((g) => g.title === "Grow retention")!;
    const other = goals.find((g) => g.title !== "Grow retention")!;
    const itemGoals = async () => {
      const items = (await call("GET", "/v1/simple/roadmap")).body.items as { key: string; goal_ids?: string[] }[];
      return items.map((i) => `${i.key}: ${(i.goal_ids ?? []).join(",")}`);
    };
    const before = await itemGoals();
    const deleted = (await call("DELETE", `/v1/simple/goal-buckets/goals/${grow.id}?to_goal_id=${other.id}`)).status;
    const moved = await itemGoals();
    const restored = (await call("POST", `/v1/simple/goal-buckets/goals/${grow.id}/restore`)).status;
    return { before, moved, after: await itemGoals(), deleted, restored };
  });
  expect([got.deleted, got.restored]).toEqual([200, 200]);
  expect(got.moved).not.toEqual(got.before);
  expect(got.after).toEqual(got.before);
});
