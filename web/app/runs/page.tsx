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
import { hasRole, useMe } from "@/lib/me";
import { useQuery } from "@/lib/use-query";

import {
  CHECKPOINT_LABEL,
  RUN_STATUS_KIND,
  RUN_STATUS_LABEL,
  RunCost,
  RunStatusBadge,
  RunsWhere,
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
  const { role } = useMe();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<string | null>(null);
  const runs = (q.data ?? []).filter((r) => r.status !== "draft");
  const waiting = runs.filter((r) => WAITING_STATUSES.includes(r.status));
  const checkpoints = runs.filter((r) => r.status === "awaiting_checkpoint").length;
  const selected = runs.find((r) => r.id === picked) ?? waiting[0] ?? runs[0];

  const columns: Column<RunSummary>[] = [
    {
      key: "id",
      header: "Run",
      width: "68px",
      phone: "hide",
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
    { key: "flow", header: "Flow", width: "150px", phone: "meta", cell: (r) => r.flow_title },
    {
      key: "state",
      header: "State",
      width: "320px",
      phone: "meta",
      cell: (r) => (
        // P3d: the cost stays on every size; prominent on approvals and overruns.
        <span className="flex min-w-0 items-center gap-2.5 max-[600px]:flex-wrap max-[600px]:gap-y-1">
          <RunStatusBadge status={r.status} />
          {r.waiting_on && <span className="sr-only">: {CHECKPOINT_LABEL[r.waiting_on]}</span>}
          <RunCost run={r} />
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
        ACTION[r.status] ? (
          <Button
            onClick={(e) => {
              e.stopPropagation();
              router.push(`/runs/${r.id}`);
            }}
          >
            {ACTION[r.status]}
          </Button>
        ) : null,
    },
  ];

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
          hasRole(role, "approver") && (
            <Button variant="primary" icon="plus" onClick={() => setOpen(true)}>
              New run
            </Button>
          )
        }
      />
      {q.error && <ErrorNote>{q.error}</ErrorNote>}
      <Split inspector={selected && <RunInspector run={selected} />}>
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
          <Chip hero kind={RUN_STATUS_KIND[run.status]}>
            {RUN_STATUS_LABEL[run.status]}
          </Chip>
          <Chip hero>{run.flow_title}</Chip>
        </>
      }
    >
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
