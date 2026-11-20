"use client";

import { useMemo } from "react";

import { api, unwrap } from "@/lib/api/client";
import { errorMessage, useQuery } from "@/lib/use-query";

import { goalViews, historyOf, measurementPoints, shownGoals, type GoalView, type Point } from "./_goals";

/** A goal's trend reads at most this many of its newest revisions (six monthly readings and change). */
const TREND_REVISIONS = 24;

/**
 * The company's goals as Home's goals panel shows them (tagged G1, G2… in baseline order),
 * with a trend for each goal shown that has a current value. Home and Plan read the same,
 * so a goal tag means the same thing on both; `short` (Home only) writes money short ("$50k").
 */
export function useGoals(scope: string, { short = false }: { short?: boolean } = {}): {
  goals: GoalView[] | undefined;
  history: Map<string, Point[]>;
  /** The trends are loading: a goal with a current value and no history yet keeps its trend's room meanwhile. */
  historyPending: boolean;
  /** #1586: each goal whose trend could not be read, with the reason; never drawn as "no trend". */
  historyFailed: Map<string, string>;
  error: string | null;
  loading: boolean;
} {
  const goalsQ = useQuery(`${scope}|goals`, () => unwrap(api.GET("/v1/baseline/entities", { params: { query: { type: "goal" } } })));
  const goals = useMemo(() => (goalsQ.data ? goalViews(goalsQ.data, undefined, { short }) : undefined), [goalsQ.data, short]);
  // A trend for each goal shown that has a current value, from its newest revisions only.
  const shown = (goals ? shownGoals(goals) : []).filter((g) => g.currentText);
  const tracked = shown.map((g) => g.id);
  // Only a goal with a typed current can have measurements (recording one sets it).
  const measured = new Set(shown.filter((g) => g.measured).map((g) => g.id));
  const historyQ = useQuery(
    `${scope}|history|${tracked.join(",")}`,
    async () => {
      // B5: the trend uses a goal's measurements when it has two or more, else its revisions.
      // #1586: a goal whose reads fail keeps the reason, so its card says the trend could not load.
      const lists = await Promise.all(
        tracked.map(async (id): Promise<Point[] | { failed: string }> => {
          try {
            const path = { params: { path: { entity_id: id } } };
            if (measured.has(id)) {
              const rows = await unwrap(api.GET("/v1/baseline/entities/{entity_id}/measurements", path));
              if (rows.length >= 2) return measurementPoints(rows);
            }
            const revisions = await unwrap(
              api.GET("/v1/baseline/entities/{entity_id}/revisions", {
                params: { path: { entity_id: id }, query: { limit: TREND_REVISIONS } },
              }),
            );
            return historyOf(revisions);
          } catch (e) {
            return { failed: errorMessage(e) };
          }
        }),
      );
      const history = new Map<string, Point[]>();
      const failed = new Map<string, string>();
      tracked.forEach((id, i) => {
        const l = lists[i];
        if (Array.isArray(l)) history.set(id, l);
        else failed.set(id, l.failed);
      });
      return { history, failed };
    },
    { keepPrevious: true },
  );
  return {
    goals,
    history: historyQ.data?.history ?? new Map(),
    historyPending: historyQ.loading,
    historyFailed: historyQ.data?.failed ?? new Map(),
    error: goalsQ.error,
    loading: goalsQ.loading,
  };
}
