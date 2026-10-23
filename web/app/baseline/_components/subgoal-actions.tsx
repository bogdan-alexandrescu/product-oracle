"use client";

import { useState } from "react";

import { Button, InspectorSection } from "@/components/ds";
import { INPUT } from "@/components/ui";
import type { EntityDetail, GraphOut } from "@/lib/api/client";
import { goalTree } from "@/lib/goal-tree";

const NONE = "";

/**
 * #345: where a goal sits in the goal tree, for approvers: move a subgoal under another
 * goal, promote it to a goal, or archive it; or put a goal without subgoals under one.
 */
export function SubgoalActions({
  goal,
  graph,
  busy,
  onMove,
  onArchive,
}: {
  goal: EntityDetail;
  graph: GraphOut | undefined;
  busy: boolean;
  onMove: (parentId: string | null) => void;
  onArchive: () => void;
}) {
  const tree = goalTree(graph?.entities ?? []);
  const self = tree.find((n) => n.goal.id === goal.id);
  const parent = goal.parent_id ?? null;
  // One level: a goal with subgoals stays a goal; a parent is a goal, never a subgoal.
  const parents = tree.filter((n) => n.depth === 0 && n.goal.id !== goal.id && n.goal.id !== parent);
  const [to, setTo] = useState(NONE);
  if ((self?.children ?? 0) > 0) return null;
  return (
    <InspectorSection label={parent ? "Subgoal" : "Goal tree"}>
      <div className="flex flex-col gap-2">
        {parents.length > 0 && (
          <div className="flex flex-wrap items-end gap-2">
            <label className="flex min-w-0 flex-1 flex-col gap-1 text-sm">
              <span className="text-text2">{parent ? "Move under" : "Make it a subgoal of"}</span>
              <select className={INPUT} value={to} onChange={(e) => setTo(e.target.value)} aria-label="Parent goal">
                <option value={NONE}>Choose a goal</option>
                {parents.map((n) => (
                  <option key={n.goal.id} value={n.goal.id}>
                    {n.tag} · {n.goal.title}
                  </option>
                ))}
              </select>
            </label>
            <Button disabled={busy || to === NONE} onClick={() => onMove(to)}>
              Move
            </Button>
          </div>
        )}
        {parent && (
          <div className="flex flex-wrap gap-2">
            <Button disabled={busy} onClick={() => onMove(null)}>
              Promote to goal
            </Button>
            {goal.status !== "rejected" && (
              <Button disabled={busy} onClick={onArchive}>
                Archive subgoal
              </Button>
            )}
          </div>
        )}
      </div>
    </InspectorSection>
  );
}

/** #338/#345: link a feature to a goal or a subgoal, with how much it contributes. */
export function LinkToGoal({
  feature,
  graph,
  busy,
  onLink,
}: {
  feature: EntityDetail;
  graph: GraphOut | undefined;
  busy: boolean;
  onLink: (goalId: string, contribution: number) => void;
}) {
  const linked = new Set(feature.edges_out.filter((e) => e.type === "supports").map((e) => e.dst_id));
  const goals = goalTree(graph?.entities ?? []).filter((n) => !linked.has(n.goal.id));
  const [to, setTo] = useState(NONE);
  const [contribution, setContribution] = useState(2);
  if (goals.length === 0) return null;
  return (
    <InspectorSection label="Link to a goal">
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex min-w-0 flex-1 flex-col gap-1 text-sm">
          <span className="text-text2">Goal or subgoal</span>
          <select className={INPUT} value={to} onChange={(e) => setTo(e.target.value)} aria-label="Goal to link">
            <option value={NONE}>Choose a goal</option>
            {goals.map((n) => (
              <option key={n.goal.id} value={n.goal.id}>
                {n.depth ? "    " : ""}
                {n.tag} · {n.goal.title}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-text2">Contribution</span>
          <select
            className={INPUT}
            value={contribution}
            onChange={(e) => setContribution(Number(e.target.value))}
            aria-label="Contribution"
          >
            <option value={1}>1 · some</option>
            <option value={2}>2 · clear</option>
            <option value={3}>3 · strong</option>
          </select>
        </label>
        <Button disabled={busy || to === NONE} onClick={() => onLink(to, contribution)}>
          Link to goal
        </Button>
      </div>
    </InspectorSection>
  );
}
