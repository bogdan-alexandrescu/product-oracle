import { GOALS, knowManyPlans, seedSimpleMany, seedSimpleRoadmap } from "../lib/api/mock/simple-roadmap";
import { expect, test } from "./test";

/**
 * dod-perf review: the mock's 500-item scenario ("simple-500") adds its 12 roadmaps, 8 goals and
 * 6 tracks to the mock's module-level lists; a switch to another scenario in the same page
 * session (a reload of other data, with no page load) takes them out again. No person can switch
 * scenarios without a page load, so this calls the mock itself (no browser).
 *
 * Card simple-roadmap-many-plans-mock: protects = once the roadmap holds no 500-item plans, the
 * mock's goals are its own again (the 500-item goals gone, its own kept); seeding the 500 items
 * again brings them back; fails_when = knowManyPlans only ever adds (the 500-item goals stay in
 * every later scenario of the session); no_claim = the API (it has no such lists).
 */
test("the 500-item plans leave the mock's goals when another scenario's data loads", () => {
  // simple-roadmap-many-plans-mock (see the card).
  const own = Object.keys(GOALS);
  seedSimpleMany();
  expect(GOALS["win-teams"]).toBe("Win larger teams");
  knowManyPlans(seedSimpleRoadmap());
  expect(GOALS["win-teams"]).toBeUndefined();
  expect(Object.keys(GOALS).sort()).toEqual([...own].sort());
  knowManyPlans(undefined);
  expect(Object.keys(GOALS).sort()).toEqual([...own].sort());
  seedSimpleMany();
  expect(GOALS["win-teams"]).toBe("Win larger teams");
  knowManyPlans(undefined);
  expect(GOALS["win-teams"]).toBeUndefined();
});
