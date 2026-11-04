import { expect, test } from "./test";

import { sortGoals } from "../lib/goal-order";

/**
 * goal-order: goals tied on position and creation order by title, case-folded and then as
 * written, then by id: the API's rule (api/oracle/baseline/goal_order.py, its
 * test_a_full_tie_goes_by_title_then_id holds the same four goals), so a rare tie reads the
 * same in the API's lists and the web's. Invented data.
 */
test("a full tie on position and creation goes by title, then id, as in the API", () => {
  const made = "2026-09-01T00:00:00Z";
  const goal = (id: string, title: string) => ({ id, title, position: 1, created_at: made });
  const goals = [goal("a", "same"), goal("c", "Same"), goal("b", "Same"), goal("d", "Other")];
  expect(sortGoals(goals).map((g) => g.id)).toEqual(["d", "b", "c", "a"]);
});
