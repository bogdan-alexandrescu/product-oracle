"use client";

import Link from "next/link";
import type { ReactNode } from "react";

import { Button, Chip, CostFigure, DataTable, Icon, LinkButton, type Column, type IconName } from "@/components/ds";
import { api, unwrap, type DocumentSummary, type Schemas } from "@/lib/api/client";
import { formatDateTime } from "@/lib/format";

import {
  CANCEL_AGAIN_CONFIRM,
  CHECKPOINT_LABEL,
  FINAL_STATUSES,
  RETRY_CONFIRM,
  STOP_CANCELLING_CONFIRM,
  age,
  shortId,
  usd,
  type InboxOut,
  type RunSummary,
} from "../runs/_lib";

/** One row of B1's "Needs you" table: kind, item, context, age, the action. Inbox and Home draw the same rows. */
export type Need = {
  key: string;
  icon: IconName;
  kind: string;
  item: ReactNode;
  context: ReactNode;
  run?: string;
  at?: string | null;
  action: ReactNode;
};

export const NEED_COLUMNS: Column<Need>[] = [
  {
    key: "kind",
    header: "Kind",
    width: "170px",
    phone: "meta",
    cell: (n) => (
      <span className="flex min-w-0 items-center gap-2.5 max-[600px]:gap-1.5" title={n.kind}>
        <Icon name={n.icon} className="flex-none text-accent-ink" />
        <span className="truncate font-medium">{n.kind}</span>
      </span>
    ),
  },
  {
    key: "item",
    header: "Item",
    phone: "title",
    cell: (n) => <span className="flex min-w-0 items-center gap-x-2.5 gap-y-1 max-[600px]:flex-wrap">{n.item}</span>,
  },
  { key: "context", header: "For", width: "26%", phone: "meta", cell: (n) => n.context },
  {
    key: "run",
    header: "Run",
    width: "64px",
    phone: "hide",
    cell: (n) => <span className="tnum font-mono text-sm text-text2">{n.run ?? ""}</span>,
  },
  {
    key: "age",
    header: "Age",
    width: "56px",
    align: "right",
    phone: "meta",
    cell: (n) => (
      <span className="tnum text-text2" title={n.at ? formatDateTime(n.at) : undefined}>
        {age(n.at)}
      </span>
    ),
  },
  {
    key: "act",
    header: <span className="sr-only">Action</span>,
    width: "212px",
    align: "right",
    phone: "action",
    cell: (n) => <span className="inline-flex flex-wrap justify-end gap-1.5">{n.action}</span>,
  },
];

/** Home's narrower lines: no run id, one action each. */
export const NEED_COLUMNS_COMPACT: Column<Need>[] = NEED_COLUMNS.filter((c) => c.key !== "run").map((c) =>
  c.key === "kind" ? { ...c, width: "164px" } : c.key === "context" ? { ...c, width: "24%" } : c.key === "act" ? { ...c, width: "112px" } : c,
);

export function NeedTable({
  title,
  testId,
  rows,
  compact = false,
}: {
  title: string;
  testId: string;
  rows: Need[];
  compact?: boolean;
}) {
  if (rows.length === 0) return null;
  return (
    <section aria-label={title} data-testid={testId}>
      <DataTable
        label={title}
        columns={compact ? NEED_COLUMNS_COMPACT : NEED_COLUMNS}
        rows={rows}
        rowKey={(n) => n.key}
        hideHeader
        rowProps={(n) => ({ "data-need": n.kind })}
      />
    </section>
  );
}

export function CountChip({ label, n }: { label: string; n: number }) {
  return (
    <Chip kind="line">
      {label} <b className="tnum">{n}</b>
    </Chip>
  );
}

function RunName({ run }: { run: Pick<RunSummary, "flow_title" | "document_slug"> }) {
  return (
    <span className="min-w-0 truncate">
      {run.flow_title}
      {run.document_slug && <span className="ml-1.5 font-mono text-sm text-text2">{run.document_slug}</span>}
    </span>
  );
}

export type Act = (key: string, call: () => Promise<unknown>) => Promise<void>;

const path = (id: string) => ({ params: { path: { run_id: id } } });

/** What Oracle still needs of a checkpoint answered in SwarmCloud's console. */
function consoleNeeds(c: NonNullable<InboxOut["checkpoints"][number]["console"]>): string {
  if (c.needs === "confirm") return "needs an approver to confirm";
  if (c.needs === "redo_or_continue") return `changes requested; choose Redo from ${c.redo_segment} or Continue`;
  if (c.needs === "unread") return "waiting to read the answer";
  return "the verdict could not be read";
}

/**
 * The Inbox's rows, each with its action. `compact` (Home) gives an overrun, a stuck run and
 * a failed import one action that opens the run, where the rest are.
 */
export function inboxNeeds(inbox: InboxOut, busy: string | null, act: Act, compact = false) {
  const checkpoints: Need[] = inbox.checkpoints.map((c) => ({
    key: c.id,
    icon: "flag",
    kind: "Checkpoint",
    item: (
      <>
        <span className="truncate">{CHECKPOINT_LABEL[c.kind]}</span>
        {c.console && (
          // Answered in SwarmCloud's console: what Oracle still needs before it counts.
          <Chip kind="warn" title={`Answered in SwarmCloud by ${c.console.answered_by ?? "someone"}: ${consoleNeeds(c.console)}`}>
            <span className="truncate">
              Answered in SwarmCloud by {c.console.answered_by ?? "someone"}: {consoleNeeds(c.console)}
            </span>
          </Chip>
        )}
      </>
    ),
    context: (
      <span className="block truncate" title={[c.flow_title, c.segment_title, c.document_slug].filter(Boolean).join(" · ")}>
        {c.segment_title ?? c.flow_title}
        {c.document_slug && <span className="ml-1.5 font-mono text-sm text-text2">{c.document_slug}</span>}
      </span>
    ),
    run: shortId(c.run_id),
    at: c.created_at,
    action: (
      // The same verb as the runs list: the run page opens at the decision.
      <LinkButton href={`/runs/${c.run_id}#decide`}>Decide</LinkButton>
    ),
  }));

  const approvals: Need[] = inbox.approvals.map((r) => ({
    key: r.id,
    icon: "coin",
    kind: "Cost approval",
    item: (
      <>
        <span className="truncate">Start run</span>
        <CostFigure usd={r.estimate_usd} est prominent />
        <span className="sr-only">Estimated {usd(r.estimate_usd)}, over the $50 approval threshold.</span>
      </>
    ),
    context: (
      <Link href={`/runs/${r.id}`} className="block truncate hover:underline">
        <RunName run={r} />
      </Link>
    ),
    run: shortId(r.id),
    at: r.created_at,
    action: (
      <Button
        aria-label={`Approve ${usd(r.estimate_usd)}`}
        disabled={busy !== null}
        onClick={() => act(`approve-${r.id}`, () => unwrap(api.POST("/v1/runs/{run_id}/approve", path(r.id))))}
      >
        Approve
      </Button>
    ),
  }));

  const overruns: Need[] = inbox.overruns.map((r) => ({
    key: r.id,
    icon: "pause",
    kind: "Overrun",
    item: (
      <>
        <span className="truncate">Resume or cancel</span>
        <CostFigure usd={r.spent_usd} of={r.estimate_usd} prominent />
        <span className="sr-only">
          Spent {usd(r.spent_usd)} of {usd(r.estimate_usd)} estimated
        </span>
      </>
    ),
    context: (
      <Link href={`/runs/${r.id}`} className="block truncate hover:underline">
        <RunName run={r} />
      </Link>
    ),
    run: shortId(r.id),
    at: r.started_at ?? r.created_at,
    action: compact ? (
      <LinkButton href={`/runs/${r.id}`}>Decide</LinkButton>
    ) : (
      <>
        <Button
          disabled={busy !== null}
          onClick={() => act(`resume-${r.id}`, () => unwrap(api.POST("/v1/runs/{run_id}/resume", path(r.id))))}
        >
          Resume
        </Button>
        <Button
          variant="ghost"
          disabled={busy !== null}
          onClick={() => act(`cancel-${r.id}`, () => unwrap(api.POST("/v1/runs/{run_id}/cancel", path(r.id))))}
        >
          Cancel run
        </Button>
      </>
    ),
  }));

  const runContext = (r: RunSummary) => (
    <Link href={`/runs/${r.id}`} className="block truncate hover:underline">
      <RunName run={r} />
    </Link>
  );
  const openRun = (r: RunSummary) => <LinkButton href={`/runs/${r.id}`}>Open</LinkButton>;

  const lookups: Need[] = inbox.lookups.map((r) => ({
    key: r.id,
    icon: "alert",
    kind: "Stuck run",
    item: (
      <span className="truncate" title={r.stuck ?? undefined}>
        {r.stuck}
      </span>
    ),
    context: runContext(r),
    run: shortId(r.id),
    at: r.started_at ?? r.created_at,
    action: compact ? (
      openRun(r)
    ) : (
      <>
        {r.can_retry && (
          <Button
            disabled={busy !== null}
            onClick={() => {
              if (window.confirm(RETRY_CONFIRM)) {
                void act(`retry-${r.id}`, () => unwrap(api.POST("/v1/runs/{run_id}/retry", path(r.id))));
              }
            }}
          >
            Retry
          </Button>
        )}
        {r.can_stop_cancelling && (
          <Button
            disabled={busy !== null}
            onClick={() => {
              if (window.confirm(STOP_CANCELLING_CONFIRM)) {
                void act(`stop-${r.id}`, () => unwrap(api.POST("/v1/runs/{run_id}/stop-cancelling", path(r.id))));
              }
            }}
          >
            Stop cancelling
          </Button>
        )}
        {r.can_retry_lookup && (
          <Button
            disabled={busy !== null}
            onClick={() => act(`lookup-${r.id}`, () => unwrap(api.POST("/v1/runs/{run_id}/retry-lookup", path(r.id))))}
          >
            Retry lookup
          </Button>
        )}
        {(r.cancel_again ?? []).map((wid, _, all) => (
          <Button
            key={wid}
            disabled={busy !== null}
            onClick={() => {
              if (window.confirm(CANCEL_AGAIN_CONFIRM)) {
                void act(`again-${r.id}-${wid}`, () =>
                  unwrap(api.POST("/v1/runs/{run_id}/cancel-again", { ...path(r.id), body: { workflow_id: wid } })),
                );
              }
            }}
          >
            {all.length > 1 ? `Cancel again ${wid}` : "Cancel again"}
          </Button>
        ))}
        {r.can_dismiss_overrun && (
          <Button
            variant="ghost"
            disabled={busy !== null}
            onClick={() => act(`dismiss-${r.id}`, () => unwrap(api.POST("/v1/runs/{run_id}/dismiss-overrun", path(r.id))))}
          >
            Dismiss
          </Button>
        )}
        {!FINAL_STATUSES.includes(r.status) && (
          <Button
            variant="ghost"
            disabled={busy !== null}
            onClick={() => act(`cancel-${r.id}`, () => unwrap(api.POST("/v1/runs/{run_id}/cancel", path(r.id))))}
          >
            Cancel run
          </Button>
        )}
      </>
    ),
  }));

  // Owners only: runs whose output Oracle stopped trying to import.
  const imports: Need[] = (inbox.imports ?? []).map((r) => ({
    key: r.id,
    icon: "alert",
    kind: "Couldn't import",
    item: (
      <span className="truncate" title={r.import_failed ?? undefined}>
        {r.import_failed}
      </span>
    ),
    context: runContext(r),
    run: shortId(r.id),
    at: r.started_at ?? r.created_at,
    action: compact
      ? openRun(r)
      : r.can_retry_import && (
          <Button
            disabled={busy !== null}
            onClick={() => act(`import-${r.id}`, () => unwrap(api.POST("/v1/runs/{run_id}/retry-import", path(r.id))))}
          >
            Retry
          </Button>
        ),
  }));

  // Shown only: nothing to decide, and not counted in the total (nor on Home or the badge).
  const searches: Need[] = (inbox.searches ?? []).map((r) => ({
    key: r.id,
    icon: "search",
    kind: "Looking",
    item: (
      <span className="truncate" title={r.searching ?? undefined}>
        {r.searching}
      </span>
    ),
    context: runContext(r),
    run: shortId(r.id),
    at: r.started_at ?? r.created_at,
    action: null,
  }));

  const feedback: Need[] = inbox.feedback.map((d) => {
    const href = d.latest_version ? `/documents/${d.slug}/v/${d.latest_version}` : `/documents/${d.slug}`;
    const latest = d.items.map((f) => f.created_at).sort().at(-1);
    return {
      key: d.document_id,
      icon: "comment",
      kind: "Feedback",
      item: (
        <span className="tnum truncate" title={d.items.map((f) => `v${f.raised_on_version} · ${f.summary}`).join("\n")}>
          {d.open_count} open item{d.open_count === 1 ? "" : "s"}
        </span>
      ),
      context: <span className="block truncate">{d.title}</span>,
      at: latest,
      action: (
        <LinkButton href={href} aria-label={`Resolve ${d.title}`}>
          Resolve
        </LinkButton>
      ),
    };
  });

  return { checkpoints, approvals, overruns, lookups, imports, searches, feedback };
}

/**
 * The questions asked of the signed-in person (I3), one row each with the document they are
 * about: Home's Needs you and the Inbox's Questions group draw the same rows.
 */
export function questionNeeds(questions: Schemas["StakeholderQuestionOut"][], docs: DocumentSummary[]): Need[] {
  return questions.map((q) => {
    const doc = docs.find((d) => d.id === q.document_id);
    return {
      key: q.id,
      icon: "ask",
      kind: "Asked you",
      item: (
        <span className="truncate" title={q.prompt}>
          {q.prompt}
        </span>
      ),
      context: <span className="block truncate">{doc?.title ?? "–"}</span>,
      at: q.created_at,
      action: doc ? (
        <LinkButton href={`/documents/${doc.slug}`} aria-label={`Open ${doc.title}`}>
          Open
        </LinkButton>
      ) : null,
    };
  });
}
