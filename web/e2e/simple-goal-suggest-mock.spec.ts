import { expect, test } from "./test";

import { routeSimpleChanges } from "../lib/api/mock/simple-changes";
import { goalId, seedSimpleRoadmap } from "../lib/api/mock/simple-roadmap";
import { routeGoalSuggestions } from "../lib/api/mock/simple-suggestions";

// The mock's goal-suggest routes check as the API's (additions.suggest): the role first, then
// the goal (no page: the viewer never sees "Suggest", and no screen names an unknown goal).
const ME = "u0000000-0000-4000-8000-000000000001";
const UNKNOWN = "g0000000-0000-4000-8000-000000000009";

function api(role: "viewer" | "commenter") {
  const db = seedSimpleRoadmap();
  const ctx = { id: ME, role, owners: [], names: { [ME]: "Sam Example" } };
  const req = (path: string, body: unknown = {}) => new Request(`http://mock/v1/${path}`, { method: "POST", body: JSON.stringify(body) });
  const at = (path: string) => ["v1", ...path.split("/")];
  return {
    /** Through the mock's router, as the app calls it. */
    async routed(path: string, body?: unknown) {
      return (await routeSimpleChanges(db, ctx, req(path, body), at(path), new URLSearchParams()))!.status;
    },
    /** The goal-suggest route itself (its own order of checks). */
    async direct(path: string, body?: unknown) {
      const res = await routeGoalSuggestions(db, ctx, req(path, body), at(path), new URLSearchParams(), async () => new Response("{}", { status: 201 }));
      return res!.status;
    },
  };
}

/**
 * Card goal-suggest-mock-order (dod-data-2 review minor): protects = the mock's "ask Oracle
 * for suggestions" refuses a viewer (403) before it looks the goal up, and refuses an unknown
 * goal (422, never 404) for a commenter, as the API's additions.suggest; a commenter on a
 * known goal starts the job (200, pending); fails_when = a viewer learns whether a goal exists
 * (a 422 or 404 instead of 403), an unknown goal reads 404 or starts a job; no_claim = the
 * job's suggestions (simple-suggest.spec.ts).
 */
test("the mock's goal suggest checks the role before the goal", async () => {
  const viewer = api("viewer");
  expect(await viewer.direct(`simple/goals/${UNKNOWN}/suggest`)).toBe(403);
  expect(await viewer.direct(`simple/goals/${goalId("grow-retention")}/suggest`)).toBe(403);
  expect(await viewer.routed(`simple/goals/${UNKNOWN}/suggest`)).toBe(403);
  const commenter = api("commenter");
  expect(await commenter.direct(`simple/goals/${UNKNOWN}/suggest`)).toBe(422);
  expect(await commenter.routed(`simple/goals/${UNKNOWN}/suggest`)).toBe(422);
  expect(await commenter.routed(`simple/goals/${UNKNOWN}/suggestions`, { title: "Faster sign-in", outcome: "More people finish" })).toBe(422);
  expect(await commenter.routed(`simple/goals/${goalId("grow-retention")}/suggest`)).toBe(200);
});
