"use client";

import { api, unwrap, type Schemas } from "@/lib/api/client";
import { useQuery } from "@/lib/use-query";

/**
 * H11 Shape goals (the `goals` responsibility on Settings › Autonomy): how far Oracle goes
 * in a goals interview. Observe: it opens none (the flags stay); Draft: one version for a
 * named person to edit and own, no default; Recommend: up to three, "Use version 1" first.
 */
export type GoalsLevel = Schemas["AutonomyItem"]["level"];

/** The API's refusal at Observe, shown where Make measurable would be. */
export const GOALS_OBSERVE = "Oracle is set to observe goals: it flags gaps and drafts nothing. An owner can change this in Settings › Autonomy.";

/**
 * Shape goals' level in force; undefined while it loads. A failed read counts as the default
 * (Recommend): the API still refuses an interview at Observe.
 */
export function useGoalsLevel(): GoalsLevel | undefined {
  const q = useQuery("autonomy-goals", () => unwrap(api.GET("/v1/autonomy")));
  if (q.error) return "recommend";
  return q.data?.items.find((i) => i.key === "goals")?.level;
}
