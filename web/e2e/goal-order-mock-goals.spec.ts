import { GOALS, knowGoalOrderGoals } from "../lib/api/mock/simple-roadmap";
import { expect, test } from "./test";

/**
 * build-goal-order-control review: the "goal-order" scenarios name their added goals in the mock's
 * module-level GOALS; once another scenario's data loads in the same page session (no page load),
 * they are taken out again, as knowManyPlans does for the 500-item plans. No person can switch
 * scenarios without a page load, so this calls the mock itself (no browser).
 */
test("the goal-order scenarios' goals leave the mock's goals when another scenario's data loads", () => {
  const own = Object.keys(GOALS).sort();
  const goal = (key: string) => ({ key, status: "confirmed" });
  const hard = ["faster-activation", "grow-retention", "support-load", "guided-week", "mid-size", "page-speed"].map(goal);
  knowGoalOrderGoals(hard);
  expect(GOALS["support-load"]).toBe("Cut support load");
  expect(GOALS["mid-size"]).toBe("Win more mid-size teams");
  // "goal-order" (not hard): the hard scenario's three extra goals go.
  knowGoalOrderGoals(hard.filter((g) => !["guided-week", "mid-size", "page-speed"].includes(g.key)));
  expect(GOALS["support-load"]).toBe("Cut support load");
  expect(GOALS["mid-size"]).toBeUndefined();
  // Another scenario: only the mock's own goals are left.
  knowGoalOrderGoals([goal("faster-activation"), goal("grow-retention")]);
  expect(Object.keys(GOALS).sort()).toEqual(own);
});
