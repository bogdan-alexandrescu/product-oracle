"use client";

import Link from "next/link";
import type { ReactNode } from "react";

import { Button, Chip, confirmInPage, CostFigure, DataTable, Icon, LinkButton, type Column, type IconName } from "@/components/ds";
import { api, unwrap, type DocumentSummary, type Schemas } from "@/lib/api/client";
import { formatDateTime } from "@/lib/format";
import { BUILD_PARAM } from "@/components/NextDraft";
import { sectionHref } from "@/lib/section-link";

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
  /** The row's Inbox state (new, open, staged, declined, done), when it has one. */
  state?: string;
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
        rowProps={(n) => ({ "data-need": n.kind, "data-state": n.state })}
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

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The Inbox's state tabs (C1e, owner 2026-10-20), New first: the default tab on arrival. */
export type InboxState = "new" | "open" | "staged" | "declined" | "done";
export const STATE_TABS: { id: InboxState; label: string }[] = [
  { id: "new", label: "New" },
  { id: "open", label: "Open" },
  { id: "staged", label: "Staged" },
  { id: "declined", label: "Declined" },
  { id: "done", label: "Done" },
];

/**
 * A row of the one Inbox in its state and group. `counted`: an item, counted in its tab (and,
 * new or open, by the rail badge); a document's 'N changes staged' row and 'Looking' rows
 * are not items.
 */
export type NeedGroup = "checkpoints" | "approvals" | "overruns" | "lookups" | "imports" | "feedback" | "questions" | "searches";
export type StatedNeed = Need & { state: InboxState; counted: boolean; group: NeedGroup };

type FeedbackRow = InboxOut["items"][number];

/**
 * New on this visit: raised after my previous visit (`seenBefore`; null before the first,
 * when everything is new). What was new on arrival stays New until the next visit, though
 * arriving marked it seen.
 */
export function isNew(at: string | null | undefined, seenBefore: string | null | undefined): boolean {
  if (seenBefore === undefined) return false;
  return seenBefore === null || (!!at && at > seenBefore);
}

/** A feedback item's state this visit: the API's, with what was new on arrival kept New. */
export function visitState(item: FeedbackRow, seenBefore: string | null | undefined): InboxState {
  if (item.state === "open" && isNew(item.created_at, seenBefore)) return "new";
  return item.state;
}

/** The verb on an open item's button: what it waits for. */
export function reviewVerb(f: Pick<FeedbackRow, "kind" | "suggestion_status">): string {
  if (f.suggestion_status === "open") return "Review suggestions";
  if (f.kind === "comment") return "Review comments";
  return "Review";
}

/**
 * One row per feedback item, in its state (the owner, 2026-10-20: one Inbox, no second
 * per-document list), and on Staged each document's 'N changes staged for draft N+1' row
 * first, with Build draft N+1.
 */
export function feedbackNeeds(inbox: InboxOut, seenBefore: string | null | undefined): StatedNeed[] {
  const docLink = (slug: string, title: string | null | undefined) => (
    <Link href={`/documents/${slug}`} className="block truncate hover:underline">
      {title ?? slug}
    </Link>
  );
  const staged: StatedNeed[] = (inbox.staged ?? []).map((row) => ({
    key: `staged-${row.document_id}`,
    icon: "doc",
    kind: "Next draft",
    state: "staged",
    counted: false,
    group: "feedback",
    item: (
      <Link
        href={sectionHref(row.slug, row.latest_version ?? 1, null, { feedback: "staged" })}
        className="tnum truncate font-semibold hover:underline"
        data-testid="staged-row-label"
      >
        {plural(row.count, "change")} staged for draft {row.next_version}
      </Link>
    ),
    context: docLink(row.slug, row.title),
    at: null,
    action: (
      <LinkButton
        href={`/documents/${row.slug}/v/${row.latest_version}?${BUILD_PARAM}=1`}
        aria-label={`Build draft ${row.next_version} of ${row.title}`}
        data-testid="inbox-build-draft"
      >
        Build draft {row.next_version}
      </LinkButton>
    ),
  }));
  const items: StatedNeed[] = (inbox.items ?? []).map((f) => {
    const state = visitState(f, seenBefore);
    const slug = f.slug ?? "";
    const latest = f.latest_version ?? f.raised_on_version;
    const live = state === "new" || state === "open";
    const href = sectionHref(slug, state === "done" ? (f.addressed_in_version ?? latest) : latest, f.section_key, live ? { feedback: "open" } : state === "staged" ? { feedback: "staged" } : undefined);
    const outcome =
      state === "staged" ? (
        <Chip kind="now">Draft {f.staged_for_version}</Chip>
      ) : state === "declined" ? (
        <span className="truncate text-text2" title={f.resolution_note ?? undefined} data-testid="decline-note">
          {f.resolution_note ?? "Declined"}
        </span>
      ) : state === "done" ? (
        <Chip kind="pass">{f.addressed_in_version ? `v${f.addressed_in_version}` : "Closed"}</Chip>
      ) : null;
    const verb = reviewVerb(f);
    return {
      key: f.id,
      icon: state === "declined" ? "x" : state === "done" || state === "staged" ? "check" : "comment",
      kind: f.kind === "comment" ? "Comment" : f.kind === "section_review" ? "Section review" : "Feedback",
      state,
      counted: true,
      group: "feedback",
      item: (
        <>
          <Link href={href} className="min-w-0 truncate hover:underline" title={f.summary}>
            {f.summary}
          </Link>
          {f.section_key && <span className="flex-none font-mono text-[13px] text-text2">#{f.section_key}</span>}
          {outcome}
        </>
      ),
      context: slug ? docLink(slug, f.title) : <span className="block truncate">{f.title}</span>,
      at: live ? f.created_at : f.updated_at,
      action:
        state === "staged" ? (
          // One Build draft per document (its group row above); the item only opens itself.
          <LinkButton variant="ghost" href={href} aria-label={`Open ${f.summary}`}>
            Open
          </LinkButton>
        ) : live ? (
          <LinkButton href={href} aria-label={`${verb}: ${f.summary}`}>
            {verb}
          </LinkButton>
        ) : (
          <LinkButton variant="ghost" href={href} aria-label={`Open ${f.summary}`}>
            Open
          </LinkButton>
        ),
    };
  });
  // One group per document on Staged: its row (the single Build draft), then its staged items.
  const grouped = new Set<string>();
  const out: StatedNeed[] = [];
  for (const row of staged) {
    out.push(row);
    const docId = row.key.slice("staged-".length);
    for (const f of inbox.items ?? []) {
      if (f.document_id !== docId) continue;
      const it = items.find((i) => i.key === f.id);
      if (it && it.state === "staged") {
        out.push({ ...it, kind: "Staged change" });
        grouped.add(it.key);
      }
    }
  }
  return [...out, ...items.filter((i) => !grouped.has(i.key))];
}

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
            onClick={async () => {
              if (await confirmInPage({ action: "Retry", message: RETRY_CONFIRM })) {
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
            onClick={async () => {
              if (await confirmInPage({ action: "Stop cancelling", message: STOP_CANCELLING_CONFIRM })) {
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
            onClick={async () => {
              if (await confirmInPage({ action: "Cancel again", message: CANCEL_AGAIN_CONFIRM })) {
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

  return { checkpoints, approvals, overruns, lookups, imports, searches };
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

/**
 * Every row of the one Inbox, each in its state (owner, 2026-10-20): checkpoints, cost
 * approvals, overruns, stuck runs, couldn't-import, feedback items and the questions asked
 * of me are New or Open; feedback items also Staged, Declined or Done. Home's Needs you is
 * the New and Open rows, so the badge, Home and /inbox count the same items.
 */
export function allNeeds(
  inbox: InboxOut,
  asked: Need[],
  busy: string | null,
  act: Act,
  seenBefore: string | null | undefined,
  compact = false,
): StatedNeed[] {
  const n = inboxNeeds(inbox, busy, act, compact);
  const stated = (rows: Need[], group: NeedGroup, counted = true): StatedNeed[] =>
    rows.map((r) => ({ ...r, state: isNew(r.at, seenBefore) ? "new" : "open", counted, group }));
  return [
    ...stated(n.checkpoints, "checkpoints"),
    ...stated(n.approvals, "approvals"),
    ...stated(n.overruns, "overruns"),
    ...stated(n.lookups, "lookups"),
    ...stated(n.imports, "imports"),
    ...feedbackNeeds(inbox, seenBefore),
    ...stated(asked, "questions"),
    // Shown only, under Open: nothing to decide, not an item.
    ...stated(n.searches, "searches", false).map((r) => ({ ...r, state: "open" as const })),
  ];
}

/** What the rail badge counts: the new and open items. */
export const waitingNeeds = (rows: StatedNeed[]) => rows.filter((r) => r.counted && (r.state === "new" || r.state === "open"));
