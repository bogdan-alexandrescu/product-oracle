"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import {
  Button,
  Chip,
  DataTable,
  Empty,
  InfoTip,
  Inspector,
  InspectorRow,
  InspectorSection,
  LinkButton,
  Page,
  PageHeader,
  Panel,
  Split,
  type Column,
} from "@/components/ds";
import { ErrorNote } from "@/components/ui";
import { api, unwrap } from "@/lib/api/client";
import { formatDateTime } from "@/lib/format";
import { useMe } from "@/lib/me";
import { useQuery } from "@/lib/use-query";

import {
  CHECKPOINT_LABEL,
  COST_DECISION_STATUSES,
  isDelivering,
  reviewHref,
  runStatusKind,
  runStatusLabel,
  RunCost,
  RunStatusBadge,
  RunsWhere,
  SENT_BACK_STATE,
  WAITING_STATUSES,
  shortId,
  type RunSummary,
} from "./_lib";
import { NewRunDialog } from "./_new-run-dialog";

const ACTION: Partial<Record<RunSummary["status"], string>> = {
  awaiting_checkpoint: "Decide",
  awaiting_approval: "Approve",
  paused_overrun: "Decide",
};

export default function RunsPage() {
  const q = useQuery("runs", () => unwrap(api.GET("/v1/runs")));
  const { can } = useMe();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<string | null>(null);
  const runs = (q.data ?? []).filter((r) => r.status !== "draft");
  // A run delivering a decision recorded at its checkpoint waits on no one.
  const waiting = runs.filter((r) => WAITING_STATUSES.includes(r.status) && !isDelivering(r));
  const checkpoints = runs.filter((r) => r.status === "awaiting_checkpoint" && !isDelivering(r)).length;
  const selected = runs.find((r) => r.id === picked) ?? waiting[0] ?? runs[0];

  const columns: Column<RunSummary>[] = [
    {
      key: "id",
      header: "Run",
      width: "68px",
      phone: "hide",
      narrow: "hide",
      cell: (r) => <span className="tnum font-mono text-sm text-accent-ink">{shortId(r.id)}</span>,
    },
    {
      key: "for",
      header: "For",
      phone: "title",
      cell: (r) => (
        <Link href={`/runs/${r.id}`} className="font-medium hover:underline" onClick={(e) => e.stopPropagation()}>
          {r.document_slug ?? r.flow_title}
        </Link>
      ),
    },
    { key: "flow", header: "Flow", width: "150px", phone: "meta", narrow: "hide", cell: (r) => r.flow_title },
    {
      key: "state",
      header: "State",
      width: "320px",
      phone: "meta",
      cell: (r) => (
        <span className="flex min-w-0 flex-wrap items-center gap-2.5 gap-y-1">
          <RunStatusBadge run={r} />
          {r.waiting_on && <span className="sr-only">: {CHECKPOINT_LABEL[r.waiting_on]}</span>}
          {r.draft_rejected && <DraftRejectedChip summary={r.draft_rejected} />}
          {r.sent_back && <SentBackChip summary={r.sent_back} />}
          {/* P3d Cost prominence: cost only where it needs a decision; on every size. */}
          {COST_DECISION_STATUSES.includes(r.status) && <RunCost run={r} />}
        </span>
      ),
    },
    {
      key: "act",
      header: <span className="sr-only">Action</span>,
      width: "112px",
      align: "right",
      phone: "action",
      cell: (r) =>
        ACTION[r.status] && !isDelivering(r) ? (
          <Button
            onClick={(e) => {
              e.stopPropagation();
              // D10: a PRD or roadmap review opens its version, where it is decided.
              if (r.status === "awaiting_checkpoint" && r.review_link) return router.push(r.review_link);
              // D1: Roadmap items open their review screen (the waiting checkpoint is the run's).
              if (r.status === "awaiting_checkpoint" && r.waiting_on === "roadmap_items") return void openItemsReview(r.id);
              router.push(`/runs/${r.id}`);
            }}
          >
            {ACTION[r.status]}
          </Button>
        ) : null,
    },
  ];

  async function openItemsReview(id: string) {
    const run = await unwrap(api.GET("/v1/runs/{run_id}", { params: { path: { run_id: id } } })).catch(() => null);
    const cp = run?.checkpoints.find((c) => c.status === "pending" && c.kind === "roadmap_items" && !c.console);
    router.push((cp && reviewHref({ ...cp, run_id: id })) || `/runs/${id}`);
  }

  return (
    <Page>
      <PageHeader
        title="Runs"
        status={
          <>
            {checkpoints > 0 && (
              <Chip kind="warn">
                {checkpoints} checkpoint{checkpoints === 1 ? "" : "s"}
              </Chip>
            )}
            <InfoTip label="where runs execute" align="start" side="bottom">
              <RunsWhere />
            </InfoTip>
          </>
        }
        action={
          // #370: an approver starts any run but an update draft (the run decides), as Plan does.
          can("create_run", true) && (
            <Button variant="primary" icon="plus" onClick={() => setOpen(true)}>
              New run
            </Button>
          )
        }
      />
      {q.error && <ErrorNote>{q.error}</ErrorNote>}
      {/* wide: under 1320 px the inspector goes below, so the table keeps its button column
          beside the docked Ask panel (its narrow columns go first, by the table's width). */}
      <Split wide inspector={selected && <RunInspector run={selected} />}>
        <Panel
          title="Runs"
          count={q.data ? runs.length : undefined}
          tools={waiting.length > 0 && <Chip kind="warn">{waiting.length} waiting</Chip>}
        >
          {q.data && runs.length === 0 ? (
            <Empty>
              No runs yet{" "}
              <InfoTip label="runs" align="start">
                Runs turn the baseline into a PRD draft: each one plans the work, gathers evidence from your sources and
                writes a cited draft for review.
              </InfoTip>
            </Empty>
          ) : (
            <DataTable
              label="Runs"
              testId="runs-table"
              columns={columns}
              rows={q.data ? runs : undefined}
              loading={q.loading}
              rowKey={(r) => r.id}
              selected={selected?.id ?? null}
              onSelect={(k) => setPicked(k)}
              onActivate={(k) => router.push(`/runs/${k}`)}
              rowProps={() => ({ "data-testid": "run-row" })}
            />
          )}
        </Panel>
      </Split>
      {open && <NewRunDialog onClose={() => setOpen(false)} />}
    </Page>
  );
}

function RunInspector({ run }: { run: RunSummary }) {
  return (
    <Inspector
      label="Run"
      eyebrow={`Run ${shortId(run.id)} · selected`}
      title={run.document_slug ?? run.flow_title}
      action={
        <LinkButton variant="hero" href={`/runs/${run.id}`}>
          Open
        </LinkButton>
      }
      chips={
        <>
          <Chip hero kind={runStatusKind(run)}>
            {runStatusLabel(run)}
          </Chip>
          <Chip hero>{run.flow_title}</Chip>
        </>
      }
    >
      {run.draft_rejected && (
        <InspectorSection label="Draft rejected">
          <p className="text-[15px] text-crit">{run.draft_rejected}</p>
        </InspectorSection>
      )}
      {run.sent_back && (
        <InspectorSection label={SENT_BACK_STATE}>
          <p className="text-[15px] text-text">{run.sent_back}</p>
        </InspectorSection>
      )}
      {run.waiting_on && (
        <InspectorSection label="Waiting on">
          <InspectorRow>{CHECKPOINT_LABEL[run.waiting_on]}</InspectorRow>
        </InspectorSection>
      )}
      <InspectorSection label="Cost">
        <InspectorRow value={<RunCost run={run} />}>{run.status === "awaiting_approval" ? "Estimate" : "Spent"}</InspectorRow>
      </InspectorSection>
      <InspectorSection label="Dates">
        <InspectorRow value={formatDateTime(run.created_at)}>Created</InspectorRow>
        {run.started_at && <InspectorRow value={formatDateTime(run.started_at)}>Started</InspectorRow>}
        {run.finished_at && <InspectorRow value={formatDateTime(run.finished_at)}>Finished</InspectorRow>}
      </InspectorSection>
    </Inspector>
  );
}

/** A draft of the run Oracle refused to import; what it refused, on hover and in the inspector. */
function DraftRejectedChip({ summary }: { summary: string }) {
  return (
    <Chip kind="crit" title={summary} data-testid="run-draft-rejected">
      Draft rejected
    </Chip>
  );
}

/** A refused draft Oracle sent back to the writer itself, being revised: nothing to decide yet. */
function SentBackChip({ summary }: { summary: string }) {
  return (
    <Chip kind="acc" title={`${SENT_BACK_STATE}. ${summary}`} data-testid="run-sent-back">
      Revising
    </Chip>
  );
}
