import { named } from "@/lib/codes";
import { goalTree } from "@/lib/goal-tree";
import { goalName } from "@/lib/placeholders";

/** The fields read (an EntityOut is one). */
type GoalLike = Parameters<typeof goalTree>[0][number];

/** A goal as Simple's goal lists name it. */
type GoalRef = { id: string; key: string; title: string };

export type KeyResult = { id: string; code: string | null; name: string };

export type KeyResults = {
  /** The parent goal of a key result named by id, key or title; null for a top-level goal or one unknown. */
  parentOf: (ref: string | null | undefined) => GoalRef | null;
  /** A goal's key results (its confirmed subgoals, theirs after each at any depth) by its id, key or title, in the one goal order. */
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
 * suggested features sit under that goal (as the roadmap API groups them). As the API's
 * _lane_goal: any subgoal whose parent is a confirmed goal folds into it, whatever its own status,
 * at any depth (a key result's own subgoal folds into the top-level goal too). The key results
 * listed are the confirmed ones.
 */
export function keyResults(entities: GoalLike[]): KeyResults {
  const goals = entities.filter((e) => e.type === "goal");
  const confirmed = new Map(goals.filter((e) => e.status === "confirmed").map((g) => [g.id, g]));
  const tree = goalTree([...confirmed.values()]);
  const parents = new Map<string, GoalRef>();
  const lists = new Map<string, KeyResult[]>();
  const metrics = new Map<string, string | null>();
  for (const g of goals) metrics.set(g.id, metric(g.attrs));
  /** The top-level goal a subgoal folds into: up its confirmed parents; null for a goal itself. */
  const topOf = (g: GoalLike): GoalLike | null => {
    let at = g;
    const seen = new Set([g.id]);
    while (at.parent_id && confirmed.has(at.parent_id) && !seen.has(at.parent_id)) {
      at = confirmed.get(at.parent_id)!;
      seen.add(at.id);
    }
    return at === g ? null : at;
  };
  for (const g of goals) {
    const top = topOf(g);
    if (!top) continue;
    const ref = { id: top.id, key: top.key ?? top.id, title: top.title };
    for (const k of [g.id, g.key, g.title]) if (k) parents.set(k, ref);
  }
  // The listed key results: the tree's confirmed subgoals, each followed by its own confirmed
  // subgoals at any depth (code: its parent's and its number, as goalTree numbers a subgoal).
  const below = (id: string) => [...confirmed.values()].filter((s) => s.parent_id === id);
  const oldest = (a: GoalLike, b: GoalLike) => (a.created_at ?? "").localeCompare(b.created_at ?? "") || a.id.localeCompare(b.id);
  for (const n of tree) {
    if (!n.parentId) continue;
    const top = tree.find((p) => p.goal.id === n.parentId)!.goal;
    const list = lists.get(top.id) ?? [];
    const walk = (g: GoalLike, code: string | null, name: string, seen: Set<string>) => {
      list.push({ id: g.id, code, name });
      below(g.id)
        .sort(oldest)
        .forEach((s, i) => {
          if (seen.has(s.id)) return;
          const own = named(goalName(s.title, s.key), s.key);
          walk(s, own.code ?? (code ? `${code}.${i + 1}` : null), own.name, new Set([...seen, s.id]));
        });
    };
    walk(n.goal, n.code, n.name, new Set([top.id, n.goal.id]));
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
 * key result's suggestions are under its parent goal (reached from its "Suggest a feature"),
 * each still named by its key result.
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
  // kr-name-kept: a key result's suggestion is listed under its parent goal (its home) but still
  // names the key result it serves.
  const home = (b: B): B => (top(b).id === b.id ? b : { ...top(b), title: b.title });
  return { ...data, goals, suggestions: data.suggestions.map((s) => ({ ...s, goal: home(s.goal) })) };
}
