"use client";

import { useMemo, useState } from "react";

import { InfoTip, PageHeader, Panel, Split, ViewOnly } from "@/components/ds";
import { ErrorNote } from "@/components/ui";
import { goalViews } from "@/app/home/_goals";
import { api, unwrap } from "@/lib/api/client";
import { useMe } from "@/lib/me";
import { useQuery } from "@/lib/use-query";
import { invalidateWaiting, waitingChanged } from "@/lib/waiting";

import { StrategyCard, VisionCard } from "./_components/Cards";
import { DraftSheet } from "./_components/DraftSheet";
import { DriftList } from "./_components/DriftList";
import { StackInspector, StackTable, stackRows } from "./_components/StackTable";
import type { DocKind, FindingState } from "./_components/lib";

/**
 * Company › Strategy (H4): the approved vision and product strategy, the strategy stack
 * (vision → focus choice → goal → roadmap items, then what is not under the strategy) with
 * its inspector, and the drift findings. Owners start a vision or strategy here, or draft
 * its next version with Oracle; the documents themselves open from the cards.
 */
export default function StrategyPage() {
  const { can, capsReady } = useMe();
  // #370: a vision or a product strategy is an owner's to start: POST /v1/drafts lets an
  // approver in by kind, and its per-item role (owner) is the one these kinds need.
  const owner = can("start_draft", false);
  // #370: approvers waive drift and owners draft; below that the strategy is read only.
  const readOnly = capsReady && !can("waive_strategy_finding");
  const [state, setState] = useState<FindingState>("open");
  const [picked, setPicked] = useState<string | null>(null);
  const [drafting, setDrafting] = useState<DocKind | null>(null);

  const stackQ = useQuery("strategy|stack", () => unwrap(api.GET("/v1/strategy/stack")));
  // Every state's list, so each chip counts the findings its list shows (the API does not page).
  const findings = (status: FindingState) => () => unwrap(api.GET("/v1/strategy/findings", { params: { query: { status } } }));
  const openQ = useQuery("strategy|findings|open", findings("open"));
  const waivedQ = useQuery("strategy|findings|waived", findings("waived"));
  const resolvedQ = useQuery("strategy|findings|resolved", findings("resolved"));
  const listQ = { open: openQ, waived: waivedQ, resolved: resolvedQ }[state];
  const docsQ = useQuery("strategy|documents", async () => {
    const [vision, strategy] = await Promise.all(
      (["vision", "strategy"] as const).map((kind) => unwrap(api.GET("/v1/documents", { params: { query: { kind } } }))),
    );
    return { vision, strategy };
  });
  const goalsQ = useQuery("strategy|goals", () => unwrap(api.GET("/v1/baseline/entities", { params: { query: { type: "goal" } } })));

  const stack = stackQ.data;
  const open = useMemo(() => openQ.data ?? [], [openQ.data]);
  const rows = useMemo(() => stackRows(stack, open), [stack, open]);
  const goals = useMemo(() => new Map((goalsQ.data ? goalViews(goalsQ.data) : []).map((g) => [g.id, g])), [goalsQ.data]);
  const selected = rows.find((r) => r.key === picked) ?? rows[0] ?? null;

  // The approved document when there is one; else the draft in progress.
  const docs = docsQ.data;
  const docOf = (kind: DocKind) => {
    const approved = kind === "vision" ? stack?.vision?.document : stack?.strategy?.document;
    const listed = docs?.[kind] ?? [];
    return listed.find((d) => d.slug === approved?.slug) ?? listed[0] ?? null;
  };
  const approvedVersion = (kind: DocKind) => (kind === "vision" ? stack?.vision?.document.version : stack?.strategy?.document.version) ?? null;

  async function waived() {
    invalidateWaiting();
    await Promise.all([stackQ.reload(), openQ.reload(), waivedQ.reload(), resolvedQ.reload()]);
    waitingChanged();
  }

  return (
    <div data-testid="strategy-page" className="flex min-w-0 flex-col gap-4 max-[600px]:gap-3">
      <PageHeader
        title="Company"
        status={
          <>
            {readOnly && <ViewOnly />}
            <InfoTip label="the strategy" align="start" side="bottom">
              The vision and the product strategy Oracle drafts and an owner approves. Each goal should follow from a focus choice, and
              each roadmap item from a goal; what does not shows as drift.
            </InfoTip>
          </>
        }
      />
      {(stackQ.error || docsQ.error) && <ErrorNote>{stackQ.error ?? docsQ.error}</ErrorNote>}
      <div className="grid grid-cols-2 items-stretch gap-4 max-[900px]:grid-cols-1 max-[600px]:gap-3">
        <VisionCard stack={stack} doc={docs ? docOf("vision") : null} owner={owner && !!docs} onDraft={setDrafting} />
        <StrategyCard stack={stack} doc={docs ? docOf("strategy") : null} owner={owner && !!docs} goals={goals} onDraft={setDrafting} />
      </div>
      <Split inspector={selected ? <StackInspector stack={stack} row={selected} onWaived={waived} /> : undefined}>
        <Panel
          title="Strategy stack"
          tools={
            <InfoTip label="the strategy stack" align="end">
              One line per goal under the focus choice it derives from, with the roadmap items serving it. The last group lists the goals
              and items not under the strategy.
            </InfoTip>
          }
        >
          <StackTable stack={stack} rows={rows} selected={selected?.key ?? null} onSelect={setPicked} />
        </Panel>
        <DriftList
          state={state}
          onState={setState}
          rows={listQ.data}
          loading={listQ.loading}
          error={listQ.error}
          counts={{ open: openQ.data?.length, waived: waivedQ.data?.length, resolved: resolvedQ.data?.length }}
          stack={stack}
          onWaived={waived}
        />
      </Split>
      {drafting && owner && (
        <DraftSheet
          kind={drafting}
          doc={docOf(drafting)}
          approvedVersion={approvedVersion(drafting)}
          onClose={() => setDrafting(null)}
          onCreated={() => void docsQ.reload()}
        />
      )}
    </div>
  );
}
