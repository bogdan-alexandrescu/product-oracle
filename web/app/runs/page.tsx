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
import { formatDateTime, plural } from "@/lib/format";
import { docLabel } from "@/lib/labels";
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
  runName,
  RunsWhere,
  SENT_BACK_STATE,
  WAITING_STATUSES,
  type RunSummary,
} from "./_lib";
import { NewRunDialog } from "./_new-run-dialog";
import { QueueWaitNote } from "./_queue-wait";

type DocNamed = Parameters<typeof docLabel>[0];

/**
 * What a run is for, by name (qa-shell-32), never its slug or short id: its document's title
 * ("Usage alerts PRD"), else the run's document in words (runName; the Flow column says the flow).
 */
function runTitle(r: RunSummary, docs: Map<string, DocNamed>): string {
  const d = r.document_id ? docs.get(r.document_id) : undefined;
  return d ? docLabel(d) : runName(r);
}

export default function RunsPage() {
  const q = useQuery("runs", () => unwrap(api.GET("/v1/runs")));
  // Document titles, to name each run by its document; the slug in words until they load.
  const docsQ = useQuery("runs|documents", () => unwrap(api.GET("/v1/documents")).catch(() => []));
  const docs = new Map<string, DocNamed>((docsQ.data ?? []).map((d) => [d.id, d]));
  const { can } = useMe();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<string | null>(null);
  const runs = (q.data ?? []).filter((r) => r.status !== "draft");
  // A run delivering a decision recorded at its checkpoint waits on no one.
  const waiting = runs.filter((r) => WAITING_STATUSES.includes(r.status) && !isDelivering(r));
  const selected = runs.find((r) => r.id === picked) ?? waiting[0] ?? runs[0];

  /**
   * qa-work-1/17: a row's button says what it does, as the run page does, and shows only to
   * whoever can act on it (a viewer gets none; the whole row opens the run). A checkpoint opens
   * its decision: Review items for roadmap items, Decide for the rest; a cost approval and an
   * overrun open the run, where Approve and Resume are. fix-work review: Decide is per item
   * (an approver decides an approver's checkpoint), so the row passes its can_decide.
   */
  const rowAction = (r: RunSummary): { label: string; go: () => void } | null => {
    if (isDelivering(r)) return null;
    if (r.status === "awaiting_checkpoint" && can("decide_checkpoint", r.can_decide)) {
      return {
        label: r.waiting_on === "roadmap_items" ? "Review items" : "Decide",
        go: () => {
          // D10: a PRD or roadmap review opens its version, where it is decided.
          if (r.review_link) return router.push(r.review_link);
          // D1: Roadmap items open their review screen (the waiting checkpoint is the run's).
          if (r.waiting_on === "roadmap_items") return void openItemsReview(r.id);
          router.push(`/runs/${r.id}#decide`);
        },
      };
    }
    if ((r.status === "awaiting_approval" && can("approve_run")) || (r.status === "paused_overrun" && can("resume_run"))) {
      return { label: "Open", go: () => router.push(`/runs/${r.id}`) };
    }
    return null;
  };

  const columns: Column<RunSummary>[] = [
    {
      key: "for",
      header: "For",
      phone: "title",
      cell: (r) => {
        const name = runTitle(r, docs);
        return (
          // qa-work-29: on a phone the link is a 44 px target (and the whole row opens the run).
          <Link
            href={`/runs/${r.id}`}
            title={name}
            className="block truncate font-medium hover:underline max-[600px]:flex max-[600px]:min-h-11 max-[600px]:items-center max-[600px]:whitespace-normal"
            onClick={(e) => e.stopPropagation()}
          >
            {name}
          </Link>
        );
      },
    },
    {
      key: "flow",
      header: "Flow",
      width: "180px",
      phone: "meta",
      narrow: "hide",
      // qa-work-23: wide enough for the flows' names; one cut short shows in full on hover.
      cell: (r) => (
        <span className="block truncate" title={r.flow_title}>
          {r.flow_title}
        </span>
      ),
    },
    {
      key: "state",
      header: "State",
      width: "350px",
      phone: "meta",
      cell: (r) => (
        <span className="flex min-w-0 flex-wrap items-center gap-2.5 gap-y-1">
          <RunStatusBadge run={r} />
          {r.waiting_on && !isDelivering(r) && <span className="text-sm text-text2">{CHECKPOINT_LABEL[r.waiting_on]}</span>}
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
      width: "120px",
      align: "right",
      phone: "action",
      cell: (r) => {
        const a = rowAction(r);
        return a ? (
          <Button
            onClick={(e) => {
              e.stopPropagation();
              a.go();
            }}
          >
            {a.label}
          </Button>
        ) : null;
      },
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
          // qa-work-10: one count, said once: the runs waiting on a person's decision.
          waiting.length > 0 && (
            <Chip kind="warn" data-testid="runs-waiting">
              {plural(waiting.length, "run")} {waiting.length === 1 ? "needs" : "need"} a decision
            </Chip>
          )
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
      <Split byRoom inspector={selected && <RunInspector run={selected} name={runTitle(selected, docs)} />}>
        <Panel
          title="Runs"
          count={q.data ? runs.length : undefined}
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
              rowProps={(r) => ({ "data-testid": "run-row", "data-document": r.document_slug ?? undefined })}
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
      eyebrow="Selected run"
      title={name}
      action={
        <LinkButton variant="hero" href={`/runs/${run.id}`}>
          Open
        </LinkButton>
      }
      chips={
        <Chip hero kind={runStatusKind(run)}>
          {runStatusLabel(run)}
        </Chip>
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
        <InspectorRow value={<RunCost run={run} />}>Cost</InspectorRow>
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
