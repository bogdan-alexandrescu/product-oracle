import { expect, test } from "./test";

import { readMetricIntoGoal, seedBaseline } from "../lib/api/mock/baseline";

// The mock's goal measurements follow the API's oracle.metrics.pull._goal_measurement: when a
// metric's weekly value is removed, only the goal measurement that metric wrote goes (no page:
// the difference only shows on data the mock does not seed).
let n = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
const SUNDAY = "2026-10-25";

function goalState() {
  const s = seedBaseline(uuid);
  const goal = s.entities.find((e) => e.key === "g.activation")!;
  const onSunday = () => (s.measurements ?? []).filter((x) => x.entity_id === goal.id && x.measured_on === SUNDAY);
  return { s, goal, onSunday };
}

test("review: removing a metric's value keeps a goal measurement another metric wrote that Sunday", async () => {
  const { s, goal, onSunday } = goalState();
  readMetricIntoGoal(s, goal.id, SUNDAY, 41, "Weekly value from Example rate A", "metric-a");
  readMetricIntoGoal(s, goal.id, SUNDAY, null, "Weekly value from Example rate B", "metric-b");
  expect(onSunday().map((x) => x.value)).toEqual([41]);
});

test("review: removing a metric's value removes the goal measurement it wrote", async () => {
  const { s, goal, onSunday } = goalState();
  readMetricIntoGoal(s, goal.id, SUNDAY, 41, "Weekly value from Example rate A", "metric-a");
  readMetricIntoGoal(s, goal.id, SUNDAY, null, "Weekly value from Example rate A", "metric-a");
  expect(onSunday()).toEqual([]);
});
