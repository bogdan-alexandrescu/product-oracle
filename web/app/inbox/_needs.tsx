"use client";

import Link from "next/link";
import type { ReactNode } from "react";

import { Button, Chip, CostFigure, DataTable, Icon, LinkButton, type Column, type IconName } from "@/components/ds";
import { api, unwrap, type DocumentSummary, type Schemas } from "@/lib/api/client";
import { formatDateTime } from "@/lib/format";

import { CHECKPOINT_LABEL, age, shortId, usd, type InboxOut, type RunSummary } from "../runs/_lib";

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
  c.key === "kind" ? { ...c, width: "164px" } : c.key === "context" ? { ...c, width: "24%" } : c.key === "act" ? { ...c, width: "200px" } : c,
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

type InboxDocument = InboxOut["feedback"][number];

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** What a document's open items wait for ("3 suggestions to accept or dismiss"), and the button's verb. */
export function feedbackWaits(d: InboxDocument): { parts: string[]; verb: string } {
  const c = d.counts ?? { suggestions: 0, accepted: 0, comments: 0, verdicts: 0, other: d.open_count };
  const parts = [
    c.suggestions > 0 && `${plural(c.suggestions, "suggestion")} to accept or dismiss`,
    c.accepted > 0 && `${plural(c.accepted, "accepted suggestion")} to refine`,
    c.comments > 0 && `${plural(c.comments, "comment")} to resolve`,
    c.verdicts > 0 && `${plural(c.verdicts, "section verdict")} to address`,
    c.other > 0 && `${plural(c.other, "item")} to address`,
  ].filter((p): p is string => !!p);
  const only = (n: number) => n > 0 && n === d.open_count;
  const verb = only(c.suggestions) ? "Review suggestions" : only(c.comments) ? "Review comments" : "Review feedback";
  return { parts: parts.length ? parts : [plural(d.open_count, "open item")], verb };
}

/** The latest version, its review panel on the open feedback, at the first open item's section. */
export function feedbackHref(d: InboxDocument): string {
  if (!d.latest_version) return `/documents/${d.slug}`;
  const at = d.first_section_key ? `#${encodeURIComponent(d.first_section_key)}` : "";
  return `/documents/${d.slug}/v/${d.latest_version}?feedback=open${at}`;
}

const path = (id: string) => ({ params: { path: { run_id: id } } });

/**
 * The Inbox's four kinds of rows, each with its action. `compact` (Home) gives an overrun
 * one Decide that opens the run, where Resume and Cancel are.
 */
export function inboxNeeds(inbox: InboxOut, busy: string | null, act: Act, compact = false) {
  const checkpoints: Need[] = inbox.checkpoints.map((c) => ({
    key: c.id,
    icon: "flag",
    kind: "Checkpoint",
    item: <span className="truncate">{CHECKPOINT_LABEL[c.kind]}</span>,
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

  const feedback: Need[] = inbox.feedback.map((d) => {
    const href = feedbackHref(d);
    const latest = d.items.map((f) => f.created_at).sort().at(-1);
    const { parts, verb } = feedbackWaits(d);
    return {
      key: d.document_id,
      icon: "comment",
      kind: "Feedback",
      item: (
        <span className="tnum truncate" title={d.items.map((f) => `v${f.raised_on_version} · ${f.summary}`).join("\n")}>
          {parts.join(" · ")}
        </span>
      ),
      context: <span className="block truncate">{d.title}</span>,
      at: latest,
      action: (
        <LinkButton href={href} aria-label={`${verb} ${d.title}`}>
          {verb}
        </LinkButton>
      ),
    };
  });

  return { checkpoints, approvals, overruns, feedback };
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
