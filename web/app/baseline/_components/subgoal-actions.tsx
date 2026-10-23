"use client";

import { useState } from "react";

import { Button, InspectorSection } from "@/components/ds";
import { INPUT } from "@/components/ui";
import type { EntityDetail, GraphOut } from "@/lib/api/client";
import { namedText } from "@/lib/codes";
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
                    {namedText(n)}
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
