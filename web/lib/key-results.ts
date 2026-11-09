import { goalTree } from "@/lib/goal-tree";

/** The fields read (an EntityOut is one). */
type GoalLike = Parameters<typeof goalTree>[0][number];

/** A goal as Simple's goal lists name it. */
type GoalRef = { id: string; key: string; title: string };

export type KeyResult = { id: string; code: string | null; name: string };

export type KeyResults = {
  /** The parent goal of a key result named by id, key or title; null for a top-level goal or one unknown. */
  parentOf: (ref: string | null | undefined) => GoalRef | null;
  /** A goal's key results (its confirmed subgoals) by its id, key or title, in the one goal order. */
  of: (ref: string) => KeyResult[];
  /** A goal's own metric (attrs.metric), by its id. */
  metricOf: (id: string) => string | null;
};

const metric = (attrs: Record<string, unknown> | undefined): string | null => {
  let m = attrs?.metric;
  if (m && typeof m === "object") m = (m as { name?: unknown; title?: unknown }).name ?? (m as { title?: unknown }).title;
  return typeof m === "string" && m ? m : null;
};

/**
 * kr-in-goal-card: the confirmed goals as Simple shows them. Only top-level goals are goals; a
 * subgoal (a key result, parent_id set) belongs to its parent goal's card, and its work and
 * suggested features sit under that goal (as the roadmap API groups them).
 */
export function keyResults(entities: GoalLike[]): KeyResults {
  const tree = goalTree(entities.filter((e) => e.type === "goal" && e.status === "confirmed"));
  const parents = new Map<string, GoalRef>();
  const lists = new Map<string, KeyResult[]>();
  const metrics = new Map<string, string | null>();
  for (const n of tree) {
    metrics.set(n.goal.id, metric(n.goal.attrs));
    if (!n.parentId) continue;
    const top = tree.find((p) => p.goal.id === n.parentId)!.goal;
    const ref = { id: top.id, key: top.key ?? top.id, title: top.title };
    for (const k of [n.goal.id, n.goal.key, n.goal.title]) if (k) parents.set(k, ref);
    const list = lists.get(top.id) ?? [];
    list.push({ id: n.goal.id, code: n.code, name: n.name });
    for (const k of [top.id, top.key, top.title]) if (k) lists.set(k, list);
  }
  return {
    parentOf: (ref) => (ref ? (parents.get(ref) ?? null) : null),
    of: (ref) => lists.get(ref) ?? [],
    metricOf: (id) => metrics.get(id) ?? null,
  };
}

type SuggestionsOut<B extends GoalRef> = {
  goals: { goal: B; pending: boolean; empty: boolean }[];
  suggestions: { goal: B }[];
};

/**
 * kr-in-goal-card: Oracle's suggested features as Simple lists them: top-level goals only; a
 * key result's suggestions are under its parent goal (reached from its "Suggest a feature").
 */
export function topGoalSuggestions<B extends GoalRef, T extends SuggestionsOut<B>>(data: T | undefined, krs: KeyResults): T | undefined {
  if (!data) return data;
  const top = (b: B): B => {
    const p = krs.parentOf(b.id) ?? krs.parentOf(b.key);
    return p ? (data.goals.find((g) => g.goal.id === p.id)?.goal ?? ({ ...b, ...p } as B)) : b;
  };
  const subs = (id: string) => data.goals.filter((g) => g.goal.id !== id && top(g.goal).id === id);
  const goals = data.goals
    .filter((g) => top(g.goal).id === g.goal.id)
    .map((g) => (subs(g.goal.id).length ? { ...g, pending: g.pending || subs(g.goal.id).some((s) => s.pending), empty: g.empty && subs(g.goal.id).every((s) => s.empty) } : g));
  return { ...data, goals, suggestions: data.suggestions.map((s) => ({ ...s, goal: top(s.goal) })) };
}
