import { byTitle } from "@/app/baseline/_components/order";

/** The fields the goal tree reads (an EntityOut is one). */
type GoalLike = {
  id: string;
  title: string;
  status: string;
  type: string;
  parent_id?: string | null;
  attrs?: Record<string, unknown>;
};

export type GoalNode<T extends GoalLike> = {
  goal: T;
  /** "G1", or "G1.1" for a subgoal of G1 (#345). */
  tag: string;
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
 * place: G1.1, G1.2. A subgoal whose parent is archived or gone stands as a goal.
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
      out.push({
        goal: g,
        tag: `G${i + 1}`,
        depth: 0,
        parentId: null,
        children: subs.length,
      });
      subs.forEach((s, j) =>
        out.push({
          goal: s,
          tag: `G${i + 1}.${j + 1}`,
          depth: 1,
          parentId: g.id,
          children: 0,
        }),
      );
    });
  return out;
}

/** "62%": a goal's progress (0 to 1) as people read it. */
export const percent = (v: number) => `${Math.round(v * 100)}%`;
