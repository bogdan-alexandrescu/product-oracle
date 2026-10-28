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
import { docLabel, runLabel } from "@/lib/labels";
import { useMe } from "@/lib/me";
import { useQuery } from "@/lib/use-query";
import { loadInbox } from "@/lib/waiting";

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
  type RunSummary,
} from "./_lib";
import { NewRunDialog } from "./_new-run-dialog";
import { QueueWaitNote } from "./_queue-wait";

const ACTION: Partial<Record<RunSummary["status"], string>> = {
  awaiting_checkpoint: "Decide",
  awaiting_approval: "Approve",
  paused_overrun: "Decide",
};

type DocNamed = Parameters<typeof docLabel>[0];

/**
 * What a run is for, by name (qa-shell-32), never its slug or short id: its document's title
 * ("Usage alerts PRD"), else the run's document and flow in words (runLabel).
 */
function runName(r: RunSummary, docs: Map<string, DocNamed>): string {
  const d = r.document_id ? docs.get(r.document_id) : undefined;
  return d ? docLabel(d) : runLabel(r);
}

export default function RunsPage() {
  const q = useQuery("runs", () => unwrap(api.GET("/v1/runs")));
  // Document titles, to name each run by its document; the slug in words until they load.
  const docsQ = useQuery("runs|documents", () => unwrap(api.GET("/v1/documents")).catch(() => []));
  const docs = new Map<string, DocNamed>((docsQ.data ?? []).map((d) => [d.id, d]));
  // qa-shell-1: the checkpoints this person may decide, as the Inbox lists them (the rail reads the same call).
  const inboxQ = useQuery("runs|inbox", loadInbox);
  const { can, me } = useMe();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<string | null>(null);
  const runs = (q.data ?? []).filter((r) => r.status !== "draft");
  // A run delivering a decision recorded at its checkpoint waits on no one.
  const waiting = runs.filter((r) => WAITING_STATUSES.includes(r.status) && !isDelivering(r));
  const checkpoints = runs.filter((r) => r.status === "awaiting_checkpoint" && !isDelivering(r)).length;
  const selected = runs.find((r) => r.id === picked) ?? waiting[0] ?? runs[0];

  /**
   * qa-shell-1: the row's one action, only for a person who may take it: a cost approval and
   * resuming an overrun are owners' (can()), cancelling one its starter's or an approver's, and
   * a checkpoint its decider's (the Inbox's can_decide). Anyone else opens the run from its name.
   */
  const mayAct = (r: RunSummary): boolean => {
    if (r.status === "awaiting_approval") return can("approve_run");
    if (r.status === "paused_overrun") return can("resume_run") || can("cancel_run", r.created_by === me?.user_id);
    if (r.status === "awaiting_checkpoint") return !!inboxQ.data?.checkpoints.some((c) => c.run_id === r.id && c.can_decide);
    return false;
  };

  const columns: Column<RunSummary>[] = [
    {
      key: "for",
      header: "For",
      phone: "title",
      cell: (r) => {
        const name = runName(r, docs);
        return (
          <Link href={`/runs/${r.id}`} className="font-medium hover:underline" title={name} onClick={(e) => e.stopPropagation()}>
            {name}
          </Link>
        );
      },
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
          {r.queue_wait && <QueueWaitNote wait={r.queue_wait} testId="run-queue-wait" />}
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
        ACTION[r.status] && !isDelivering(r) && mayAct(r) ? (
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
        info={
          <InfoTip label="where runs execute" align="start" side="bottom">
            <RunsWhere />
          </InfoTip>
        }
        status={
          <>
            {checkpoints > 0 && (
              <Chip kind="warn">
                {checkpoints} checkpoint{checkpoints === 1 ? "" : "s"}
              </Chip>
            )}
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
      {/* byRoom: the inspector goes below when the Split is too narrow for it and the table,
          as with the Ask panel docked, so the table keeps its button column (its narrow columns
          go first, by the table's width); with the panel closed it sits beside over 1100 px. */}
      <Split byRoom inspector={selected && <RunInspector run={selected} name={runName(selected, docs)} />}>
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

function RunInspector({ run, name }: { run: RunSummary; name: string }) {
  return (
    <Inspector
      label="Run"
      eyebrow="Run · selected"
      title={name}
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
