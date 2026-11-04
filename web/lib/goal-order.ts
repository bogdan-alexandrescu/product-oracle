/**
 * Goals keep one order on every page (goal-order), the API's twin rule
 * (api/oracle/baseline/goal_order.py): a goal's position (its attrs.position, 1 = first)
 * first; goals without one after those with one; then the older goal; then by title
 * (case-folded, then as written); then by id.
 * Every list, group or picker of goals sorts with byGoalOrder. Archived goals keep their
 * place among archived ones: the rule never looks at status.
 */

/** The fields the rule reads (an EntityOut is one). */
export type OrderedGoal = {
  id?: string;
  title: string;
  created_at?: string | null;
  position?: number | null;
  attrs?: Record<string, unknown> | null;
};

/** A goal's stored position: a whole number of 1 or more, else null. */
export function goalPosition(g: Pick<OrderedGoal, "position" | "attrs">): number | null {
  const v = g.position ?? g.attrs?.position;
  return typeof v === "number" && Number.isInteger(v) && v >= 1 ? v : null;
}

/** The one goal order, for Array.prototype.sort. */
export function byGoalOrder(a: OrderedGoal, b: OrderedGoal): number {
  const pa = goalPosition(a);
  const pb = goalPosition(b);
  if (pa !== pb) {
    if (pa === null) return 1;
    if (pb === null) return -1;
    return pa - pb;
  }
  const made = (a.created_at ?? "￿").localeCompare(b.created_at ?? "￿");
  if (made) return made;
  return byCode(a.title.toLowerCase(), b.title.toLowerCase()) || byCode(a.title, b.title) || byCode(a.id ?? "", b.id ?? "");
}

/** Plain code-point order, as Python compares strings (the API's tie-breaks). */
function byCode(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** `goals` in the one goal order (a new array). */
export function sortGoals<T extends OrderedGoal>(goals: readonly T[]): T[] {
  return [...goals].sort(byGoalOrder);
}
