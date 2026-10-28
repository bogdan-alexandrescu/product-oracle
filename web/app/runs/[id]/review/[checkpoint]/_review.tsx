"use client";

import Link from "next/link";
import { useCallback } from "react";

import { Empty, LinkButton, Page, PageHeader } from "@/components/ds";
import { ErrorNote, Loading } from "@/components/ui";
import { api, unwrap, type Schemas } from "@/lib/api/client";
import { runLabel } from "@/lib/labels";
import { useQuery } from "@/lib/use-query";
import { invalidateWaiting, waitingChanged } from "@/lib/waiting";

import { briefsCheck, CHECKPOINT_LABEL, datesCheck } from "../../../_lib";
import { draftKey, loadDraft } from "./_draft";
import { EngDates } from "./_eng-dates";
import { EngReview } from "./_eng-review";

/**
 * A checkpoint's review screen (F4): the table left, the inspector right, the decision bar
 * at the bottom. The shell reads the run and the checkpoint's shared draft (D8) and hands
 * them to its kind's view (the Engineering check, the Engineering dates); a kind without a view
 * here is decided on the run page.
 */
export function CheckpointReviewScreen({ runId, checkpointId }: { runId: string; checkpointId: string }) {
  const run = useQuery(`run|${runId}`, () => unwrap(api.GET("/v1/runs/{run_id}", { params: { path: { run_id: runId } } })));
  const draft = useQuery(draftKey(runId, checkpointId), () => loadDraft(runId, checkpointId));
  const { setData, reload } = draft;
  const accept = useCallback((out: Schemas["CheckpointReview"]) => setData(() => out), [setData]);
  const reloadAll = useCallback(async () => {
    await Promise.all([run.reload(), reload()]);
    invalidateWaiting();
    waitingChanged();
  }, [run, reload]);

  const r = run.data;
  const cp = r?.checkpoints.find((c) => c.id === checkpointId);
  const back = r && (
    <Link href={`/runs/${r.id}`} className="hover:underline">
      {runLabel(r)}
    </Link>
  );
  if (run.error || draft.error) {
    return (
      <Page>
        <ErrorNote>{run.error ?? draft.error}</ErrorNote>
      </Page>
    );
  }
  if (!r || !draft.data) {
    return (
      <Page>
        <Loading />
      </Page>
    );
  }
  if (!cp) {
    return (
      <Page>
        <PageHeader title="Checkpoint not found" back={back} />
        <Empty>This run has no such checkpoint.</Empty>
      </Page>
    );
  }
  const segment = r.segments.find((s) => s.seq === cp.segment_seq);
  const check = briefsCheck(cp);
  const dates = datesCheck(cp);
  if (dates) {
    return (
      <EngDates
        run={r}
        cp={cp}
        title={segment?.title ?? CHECKPOINT_LABEL[cp.kind]}
        check={dates}
        review={draft.data}
        back={back}
        onReview={accept}
        onDecided={reloadAll}
      />
    );
  }
  if (!check) {
    return (
      <Page>
        <PageHeader title={CHECKPOINT_LABEL[cp.kind]} back={back} />
        <Empty>
          This stop is decided on the run page.{" "}
          <LinkButton href={`/runs/${r.id}#decide`}>Open the run</LinkButton>
        </Empty>
      </Page>
    );
  }
  return (
    <EngReview
      run={r}
      cp={cp}
      title={segment?.title ?? CHECKPOINT_LABEL[cp.kind]}
      check={check}
      review={draft.data}
      back={back}
      onReview={accept}
      onDecided={reloadAll}
    />
  );
}
