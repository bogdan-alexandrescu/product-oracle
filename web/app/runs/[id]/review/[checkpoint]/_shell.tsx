"use client";

import { useRouter } from "next/navigation";
import { useEffect, type ComponentType } from "react";

import Link from "next/link";

import { Icon, LinkButton, NotFoundPanel, Page } from "@/components/ds";
import { ErrorNote, Loading } from "@/components/ui";
import { api, ApiError, unwrap, type Schemas } from "@/lib/api/client";
import { useQuery } from "@/lib/use-query";

import { beginDraft } from "./_draft";
import { ItemsReview } from "./_items-review";
import { CheckpointReviewScreen } from "./_review";
import { ScopeReview } from "./_scope-review";

type RunOut = Schemas["RunOut"];
type CheckpointOut = Schemas["CheckpointOut"];

export type ReviewViewProps = { run: RunOut; cp: CheckpointOut; item: string | null; reloadRun: () => Promise<void> };

/** F4's Engineering check and Engineering dates read their own draft review (./_review.tsx). */
function EngReviewView({ run, cp }: ReviewViewProps) {
  return <CheckpointReviewScreen runId={run.id} checkpointId={cp.id} />;
}

/** One entry per checkpoint kind with a review screen. */
const VIEWS: Partial<Record<CheckpointOut["kind"], ComponentType<ReviewViewProps>>> = {
  feature_set: ScopeReview,
  roadmap_items: ItemsReview,
  eng_review: EngReviewView,
  eng_dates: EngReviewView,
};

/** qa-work-6: a missing run, said as the run page says it (never with its id). */
const RUN_MISSING = "This run doesn't exist or was deleted.";

export function ReviewShell({ runId, checkpointId, item }: { runId: string; checkpointId: string; item: string | null }) {
  const router = useRouter();
  const q = useQuery(`run|${runId}`, () =>
    unwrap(api.GET("/v1/runs/{run_id}", { params: { path: { run_id: runId } } })).catch((e) => {
      throw e instanceof ApiError && e.status === 404 ? new ApiError(404, RUN_MISSING) : e;
    }),
  );
  const cp = q.data?.checkpoints.find((c) => c.id === checkpointId) ?? null;
  const View = cp ? VIEWS[cp.kind] : undefined;
  const elsewhere = !!q.data && !View;
  // The view's draft, asked for with the run rather than once the run has answered.
  useEffect(() => beginDraft(runId, checkpointId), [runId, checkpointId]);
  useEffect(() => {
    if (elsewhere) router.replace(`/runs/${runId}#decide`);
  }, [elsewhere, router, runId]);
  // qa-work-6: the run page's "Run not found" state (./_run-detail.tsx), not the API's line.
  if (!q.data && q.error === RUN_MISSING) {
    return (
      <NotFoundPanel
        title="Run not found"
        icon="search"
        testId="run-not-found"
        back={
          <Link href="/runs" className="inline-flex min-h-6 items-center gap-1 hover:text-text hover:underline">
            <Icon name="back" size={16} />
            Runs
          </Link>
        }
        actions={
          <LinkButton href="/runs" variant="primary" icon="back">
            Back to Runs
          </LinkButton>
        }
      >
        <p>{RUN_MISSING}</p>
      </NotFoundPanel>
    );
  }
  if (q.error) return <Page className="py-6"><ErrorNote>{q.error}</ErrorNote></Page>;
  if (!q.data || !cp || !View) return <div className="px-6 py-8"><Loading /></div>;
  return <View run={q.data} cp={cp} item={item} reloadRun={q.reload} />;
}
