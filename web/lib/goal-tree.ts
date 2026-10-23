import { byTitle } from "@/app/baseline/_components/order";
import { named, type Names } from "@/lib/codes";

/** The fields the goal tree reads (an EntityOut is one). */
type GoalLike = {
  id: string;
  key?: string | null;
  title: string;
  status: string;
  type: string;
  parent_id?: string | null;
  attrs?: Record<string, unknown>;
};

export type GoalNode<T extends GoalLike> = {
  goal: T;
  /** "G1", or "G1.1" for a subgoal of G1 (#345): the goal's place, for ordering. */
  tag: string;
  /**
   * The code shown (#304): a goal's company code ("G-B"), none when it has none. A subgoal's
   * is its parent's code plus its place, in the company's style: G-B.1 under G-B, G1.1 under
   * a goal without a code; a code the subgoal's own title carries wins.
   */
  code: string | null;
  /** The name without its code: "G-B Growth" -> "Growth". */
  name: string;
  /** 0 for a goal, 1 for a subgoal. */
  depth: 0 | 1;
  /** The parent goal's id, for a subgoal shown under it. */
  parentId: string | null;
  /** How many live subgoals it has (a goal only). */
  children: number;
};

const heaviest = (a: GoalLike, b: GoalLike) =>
  Number(b.attrs?.weight ?? 0) - Number(a.attrs?.weight ?? 0) || byTitle(a, b);

/**
 * Live goals as a tree, heaviest first at each level: each goal is followed by its
 * subgoals (#345). Goals are tagged G1, G2…; a subgoal takes its parent's tag and its
 * place: G1.1, G1.2, and its parent's code the same way (G-B.1). A subgoal whose parent is
 * archived or gone stands as a goal.
 */
export function goalTree<T extends GoalLike>(entities: T[]): GoalNode<T>[] {
  const live = entities.filter((e) => e.type === "goal" && e.status !== "rejected");
  const ids = new Set(live.map((g) => g.id));
  const isSub = (g: T) => !!g.parent_id && ids.has(g.parent_id);
  const out: GoalNode<T>[] = [];
  live
    .filter((g) => !isSub(g))
    .sort(heaviest)
    .forEach((g, i) => {
      const subs = live.filter((s) => isSub(s) && s.parent_id === g.id).sort(heaviest);
      const own = named(g.title, g.key);
      out.push({
        goal: g,
        tag: `G${i + 1}`,
        ...own,
        depth: 0,
        parentId: null,
        children: subs.length,
      });
      subs.forEach((s, j) => {
        const sub = named(s.title, s.key);
        out.push({
          goal: s,
          tag: `G${i + 1}.${j + 1}`,
          code: sub.code ?? `${own.code ?? `G${i + 1}`}.${j + 1}`,
          name: sub.name,
          depth: 1,
          parentId: g.id,
          children: 0,
        });
      });
    });
  return out;
}

const codesOf = new WeakMap<Names, Map<string, string | null>>();

/** The company's goal codes by goal id and by key, subgoals' included ("G-B.1"), from its one lookup. */
export function treeCodes(names: Names): Map<string, string | null> {
  let codes = codesOf.get(names);
  if (!codes) {
    codes = new Map(goalTree([...names.byId.values()]).flatMap((n) => [[n.goal.id, n.code] as const, [n.goal.key, n.code] as const]));
    codesOf.set(names, codes);
  }
  return codes;
}

/** "62%": a goal's progress (0 to 1) as people read it. */
export const percent = (v: number) => `${Math.round(v * 100)}%`;
