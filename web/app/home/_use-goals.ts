"use client";

import { useMemo } from "react";

import { api, unwrap } from "@/lib/api/client";
import { useQuery } from "@/lib/use-query";

import { goalViews, historyOf, measurementPoints, shownGoals, type GoalView, type Point } from "./_goals";

/** A goal's trend reads at most this many of its newest revisions (six monthly readings and change). */
const TREND_REVISIONS = 24;

/**
 * The company's goals as Home's goals panel shows them (tagged G1, G2… in baseline order),
 * with a trend for each goal shown that has a current value. Home and Plan read the same,
 * so a goal tag means the same thing on both.
 */
export function useGoals(scope: string): {
  goals: GoalView[] | undefined;
  history: Map<string, Point[]>;
  /** The trends are loading: a goal with a current value and no history yet keeps its trend's room meanwhile. */
  historyPending: boolean;
  error: string | null;
  loading: boolean;
} {
  const goalsQ = useQuery(`${scope}|goals`, () => unwrap(api.GET("/v1/baseline/entities", { params: { query: { type: "goal" } } })));
  const goals = useMemo(() => (goalsQ.data ? goalViews(goalsQ.data) : undefined), [goalsQ.data]);
  // A trend for each goal shown that has a current value, from its newest revisions only.
  const shown = (goals ? shownGoals(goals) : []).filter((g) => g.currentText);
  const tracked = shown.map((g) => g.id);
  // Only a goal with a typed current can have measurements (recording one sets it).
  const measured = new Set(shown.filter((g) => g.measured).map((g) => g.id));
  const historyQ = useQuery(
    `${scope}|history|${tracked.join(",")}`,
    async () => {
      // B5: the trend uses a goal's measurements when it has two or more, else its revisions.
      const lists = await Promise.all(
        tracked.map(async (id) => {
          const path = { params: { path: { entity_id: id } } };
          if (measured.has(id)) {
            const rows = await unwrap(api.GET("/v1/baseline/entities/{entity_id}/measurements", path)).catch(() => []);
            if (rows.length >= 2) return measurementPoints(rows);
          }
          const revisions = await unwrap(
            api.GET("/v1/baseline/entities/{entity_id}/revisions", {
              params: { path: { entity_id: id }, query: { limit: TREND_REVISIONS } },
            }),
          ).catch(() => []);
          return historyOf(revisions);
        }),
      );
      return new Map<string, Point[]>(tracked.map((id, i) => [id, lists[i]]));
    },
    { keepPrevious: true },
  );
  return { goals, history: historyQ.data ?? new Map(), historyPending: historyQ.loading, error: goalsQ.error, loading: goalsQ.loading };
}
