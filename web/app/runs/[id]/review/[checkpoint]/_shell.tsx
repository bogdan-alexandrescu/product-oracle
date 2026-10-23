"use client";

import { useRouter } from "next/navigation";
import { useEffect, type ComponentType } from "react";

import { Page } from "@/components/ds";
import { ErrorNote, Loading } from "@/components/ui";
import { api, unwrap, type Schemas } from "@/lib/api/client";
import { useQuery } from "@/lib/use-query";

import { ScopeReview } from "./_scope-review";

type RunOut = Schemas["RunOut"];
type CheckpointOut = Schemas["CheckpointOut"];

export type ReviewViewProps = { run: RunOut; cp: CheckpointOut; item: string | null; reloadRun: () => Promise<void> };

/** One entry per checkpoint kind with a review screen (D1 adds roadmap_items, F4 its two stops). */
const VIEWS: Partial<Record<CheckpointOut["kind"], ComponentType<ReviewViewProps>>> = {
  feature_set: ScopeReview,
};

export function ReviewShell({ runId, checkpointId, item }: { runId: string; checkpointId: string; item: string | null }) {
  const router = useRouter();
  const q = useQuery(`run|${runId}`, () => unwrap(api.GET("/v1/runs/{run_id}", { params: { path: { run_id: runId } } })));
  const cp = q.data?.checkpoints.find((c) => c.id === checkpointId) ?? null;
  const View = cp ? VIEWS[cp.kind] : undefined;
  const elsewhere = !!q.data && !View;
  useEffect(() => {
    if (elsewhere) router.replace(`/runs/${runId}#decide`);
  }, [elsewhere, router, runId]);
  if (q.error) return <Page className="py-6"><ErrorNote>{q.error}</ErrorNote></Page>;
  if (!q.data || !cp || !View) return <div className="px-6 py-8"><Loading /></div>;
  return <View run={q.data} cp={cp} item={item} reloadRun={q.reload} />;
}
