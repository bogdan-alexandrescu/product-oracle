"use client";

import Link from "next/link";
import { useId, type ReactNode } from "react";

import { Button, Chip, confirmInPage, CostFigure, DataTable, Icon, InfoTip, LinkButton, type Column, type IconName } from "@/components/ds";
import { api, unwrap, type Schemas } from "@/lib/api/client";
import { formatDate, formatDateTime } from "@/lib/format";
import { BUILD_PARAM } from "@/components/NextDraft";
import { sectionHref } from "@/lib/section-link";

import { InboxActions, SuggestionPeek, type OnActed } from "./_actions";
import {
  CANCEL_AGAIN_CONFIRM,
  CHECKPOINT_LABEL,
  FINAL_STATUSES,
  orderHref,
  RETRY_CONFIRM,
  SENT_BACK_STATE,
  STOP_CANCELLING_CONFIRM,
  age,
  deliveryText,
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
  /** Whether it counts as an item (a question settled in place does not, until it moves to Done). */
  counted?: boolean;
  /** Drawn under the row, across it: the row opened in place (a question's answer form). */
  detail?: ReactNode;
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
    wrap: true,
    // D14: a feedback row's actions and their fields go under the row on a phone, full width.
    className: "max-[600px]:has-[[data-inbox-actions]]:order-5 max-[600px]:has-[[data-inbox-actions]]:basis-full",
    cell: (n) => (
      <span className="inline-flex flex-wrap justify-end gap-1.5 has-[[data-inbox-actions]]:flex has-[[data-inbox-actions]]:w-full">
        {n.action}
      </span>
    ),
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
  heading,
}: {
  title: string;
  testId: string;
  rows: Need[];
  compact?: boolean;
  /** Shown above the rows: a group that is not something to act on says what it is. */
  heading?: ReactNode;
}) {
  const headingId = useId();
  if (rows.length === 0) return null;
  return (
    <section aria-label={heading ? undefined : title} aria-labelledby={heading ? headingId : undefined} data-testid={testId}>
      {heading && (
        <h3
          id={headingId}
          data-testid={`${testId}-heading`}
          className="flex flex-wrap items-center gap-x-1.5 border-t border-line px-4 pt-3 pb-1 text-[13px] leading-4 font-semibold tracking-[0.02em] text-text2 max-[600px]:px-3"
        >
          {heading}
        </h3>
      )}
      <DataTable
        label={title}
        columns={compact ? NEED_COLUMNS_COMPACT : NEED_COLUMNS}
        rows={rows}
        rowKey={(n) => n.key}
        hideHeader
        rowProps={(n) => ({ "data-need": n.kind, "data-state": n.state })}
        detail={(n) => n.detail}
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
export type NeedGroup =
  | "checkpoints"
  | "deliveries"
  | "approvals"
  | "overruns"
  | "lookups"
  | "imports"
  | "revoke-failures"
  | "access-failures"
  | "report-failures"
  | "reports"
  | "strategy"
  | "oracle-actions"
  | "feedback"
  | "questions"
  | "searches"
  | "revising"
  | "decisions"
  | "launches"
  | "dates"
  | "shipped";
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

/**
 * One row per feedback item, in its state (the owner, 2026-10-20: one Inbox, no second
 * per-document list), and on Staged each document's 'N changes staged for draft N+1' row
 * first, with Build draft N+1.
 */
export function feedbackNeeds(
  inbox: InboxOut,
  seenBefore: string | null | undefined,
  onActed: OnActed,
  compact = false,
): StatedNeed[] {
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
    return {
      key: f.id,
      icon: state === "declined" ? "x" : state === "done" || state === "staged" ? "check" : "comment",
      kind: f.kind === "comment" ? "Comment" : f.kind === "section_review" ? "Section review" : "Feedback",
      state,
      counted: true,
      group: "feedback",
      item: (
        <>
          <SuggestionPeek href={href} summary={f.summary} text={live ? f.suggestion_text : null} />
          {f.section_key ? (
            <span className="flex-none font-mono text-[13px] text-text2">#{f.section_key}</span>
          ) : (
            // D13: feedback on the whole draft names no section.
            <span className="flex-none text-[13px] text-text2" data-testid="inbox-general">
              General
            </span>
          )}
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
          // D14: decide on Oracle's suggestion here; a remount per state and suggestion.
          <InboxActions key={`${f.id}-${state}-${f.suggestion_id ?? ""}`} f={f} href={href} compact={compact} onActed={onActed} />
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

const CONSOLE_HELD = "Blocking problems are open: fix or waive them, then confirm";

/** What Oracle still needs of a checkpoint answered in SwarmCloud's console. */
function consoleNeeds(c: NonNullable<InboxOut["checkpoints"][number]["console"]>): string {
  if (c.needs === "confirm") return "needs an approver to confirm";
  if (c.needs === "redo_or_continue") return `changes requested; choose Redo from ${c.redo_segment} or Continue`;
  if (c.needs === "unread") return "waiting to read the answer";
  return "the verdict could not be read";
}

type RevokeFailure = NonNullable<InboxOut["revoke_failures"]>[number];

/** Why the last attempt did not revoke, in the owner's words. */
function revokeOutcome(outcome: string | null | undefined, provider: string): string {
  if (outcome === "not_configured") return `Oracle's ${provider} sign-in app is not configured`;
  if (outcome === "unreadable") return "Oracle could not read its copy of the credential";
  return `${provider} refused or did not answer`;
}

/** Owners only: a provider revoke a removed member's disable could not make, with Retry and
 * Dismiss. Inbox and Home draw the same rows (the badge counts them). */
export function revokeNeeds(failures: RevokeFailure[], busy: string | null, act: Act): Need[] {
  return failures.map((f) => {
    const provider = f.provider_name ?? f.provider ?? "the provider";
    const why = [
      `${revokeOutcome(f.outcome, provider)}${f.last_error ? ` (${f.last_error})` : ""}`,
      `tried ${f.attempts} time${f.attempts === 1 ? "" : "s"}`,
      f.status === "pending"
        ? `retrying until ${formatDateTime(f.retry_until)}`
        : `stopped retrying ${formatDateTime(f.retry_until)}`,
    ].join(" · ");
    const path = { params: { path: { follow_up_id: f.id } } };
    return {
      key: f.id,
      icon: "lock",
      kind: "Couldn't revoke",
      item: (
        <>
          <span className="truncate" title={f.title}>
            {f.title}
          </span>
          <InfoTip label="this revoke" align="start">
            Oracle keeps a copy of the credential until the revoke succeeds or you dismiss this. Dismiss if you revoked
            the access at {provider} yourself.
          </InfoTip>
        </>
      ),
      context: (
        <span className="block truncate text-text2" title={why}>
          {why}
        </span>
      ),
      at: f.created_at,
      action: (
        <>
          <Button
            disabled={busy !== null}
            onClick={() =>
              act(`retry-${f.id}`, () => unwrap(api.POST("/v1/member-follow-ups/{follow_up_id}/retry", path)))
            }
          >
            Retry
          </Button>
          <Button
            variant="ghost"
            disabled={busy !== null}
            onClick={() =>
              act(`dismiss-${f.id}`, () => unwrap(api.POST("/v1/member-follow-ups/{follow_up_id}/dismiss", path)))
            }
          >
            Dismiss
          </Button>
        </>
      ),
    };
  });
}

type AccessFailure = NonNullable<InboxOut["access_failures"]>[number];

/** Owners only (#245): a change to someone's access to Oracle still failing after 24 hours,
 * retried once a day; Retry makes it now. It leaves once done or no longer needed. */
export function accessNeeds(failures: AccessFailure[], busy: string | null, act: Act): Need[] {
  return failures.map((f) => {
    const why = [
      f.last_error ?? "Google did not make the change",
      `since ${formatDateTime(f.created_at)}`,
      `tried ${f.attempts} time${f.attempts === 1 ? "" : "s"}`,
      ...(f.next_attempt_at ? [`next try ${formatDateTime(f.next_attempt_at)}`] : []),
    ].join(" · ");
    const path = { params: { path: { follow_up_id: f.id } } };
    return {
      key: f.id,
      icon: "lock",
      kind: f.owed,
      item: (
        <>
          <span className="truncate" title={f.email}>
            {f.email}
          </span>
          <InfoTip label="this access change" align="start">
            {f.kind === "iap_revoke"
              ? "This person may still be able to open Oracle. Oracle tries again once a day until the access is removed, or until they are a member or invited again."
              : "This member cannot open Oracle yet. Oracle tries again once a day until the access is granted, or until they are removed again."}
          </InfoTip>
        </>
      ),
      context: (
        <span className="block truncate text-text2" title={why}>
          {why}
        </span>
      ),
      at: f.created_at,
      action: (
        <Button
          disabled={busy !== null}
          onClick={() => act(`retry-${f.id}`, () => unwrap(api.POST("/v1/member-follow-ups/{follow_up_id}/retry", path)))}
        >
          Retry
        </Button>
      ),
    };
  });
}

type InboxReport = NonNullable<InboxOut["reports"]>[number];
type ReportFailure = NonNullable<InboxOut["report_failures"]>[number];

/**
 * Owners only (F6): the weekly alignment reports, New while unread and made after my last
 * visit, Open while unread, Done once opened (C1e). Open shows the report, which marks it read.
 */
export function reportNeeds(reports: InboxReport[], seenBefore: string | null | undefined): StatedNeed[] {
  return reports.map((r) => {
    const risky = r.summary.at_risk + r.summary.off_track;
    const label = `${r.title} · ${risky} at risk · ${r.summary.slips} ${r.summary.slips === 1 ? "slip" : "slips"}`;
    return {
      key: `report-${r.id}`,
      icon: "roadmap",
      kind: "Report",
      state: r.read ? "done" : isNew(r.created_at, seenBefore) ? "new" : "open",
      counted: true,
      group: "reports",
      item: (
        <Link href={`/plan/reports/${r.id}`} className="min-w-0 truncate hover:underline" title={r.headline}>
          {label}
        </Link>
      ),
      context: (
        <span className="block truncate text-text2" title={r.headline}>
          {r.headline}
        </span>
      ),
      at: r.created_at,
      action: (
        <LinkButton variant={r.read ? "ghost" : undefined} href={`/plan/reports/${r.id}`} aria-label="Open">
          Open
        </LinkButton>
      ),
    };
  });
}

/** Owners only (F6): a report Slack refused for 24 hours, with Retry and Dismiss. */
export function reportFailureNeeds(failures: ReportFailure[], busy: string | null, act: Act): Need[] {
  return failures.map((f) => {
    const path = { params: { path: { report_id: f.id } } };
    const why = `${f.channel ? `#${f.channel.name} · ` : ""}tried ${f.attempts} time${f.attempts === 1 ? "" : "s"}`;
    return {
      key: `report-failure-${f.id}`,
      icon: "alert",
      kind: "Couldn't post",
      item: (
        <Link href={`/plan/reports/${f.id}`} className="min-w-0 truncate hover:underline" title={f.title}>
          Report not posted to Slack · {f.error ?? "Slack refused it"}
        </Link>
      ),
      context: (
        <span className="block truncate text-text2" title={`${f.title} · ${why}`}>
          {f.title.replace("Report not posted to Slack · ", "")} · {why}
        </span>
      ),
      at: f.created_at,
      action: (
        <>
          <Button
            disabled={busy !== null}
            onClick={() => act(`report-retry-${f.id}`, () => unwrap(api.POST("/v1/alignment-reports/{report_id}/slack/retry", path)))}
          >
            Retry
          </Button>
          <Button
            variant="ghost"
            disabled={busy !== null}
            onClick={() => act(`report-dismiss-${f.id}`, () => unwrap(api.POST("/v1/alignment-reports/{report_id}/slack/dismiss", path)))}
          >
            Dismiss
          </Button>
        </>
      ),
    };
  });
}

type OracleAction = NonNullable<InboxOut["oracle_actions"]>[number];

/**
 * "Oracle did" (H11): what Oracle did on its own, for each person it told. Counted until I
 * open it (Done then, for me only); Undo when the behaviour that acted gave an undo route.
 */
export function oracleActionNeeds(actions: OracleAction[], busy: string | null, act: Act, seenBefore: string | null | undefined): StatedNeed[] {
  return actions.map((a) => {
    const path = { params: { path: { action_id: a.id } } };
    const href = typeof a.subject?.href === "string" && a.subject.href.startsWith("/") ? a.subject.href : null;
    const open = a.state === "open";
    return {
      key: `oracle-${a.id}`,
      icon: "check",
      kind: "Oracle did",
      state: open ? (isNew(a.created_at, seenBefore) ? "new" : "open") : "done",
      counted: true,
      group: "oracle-actions",
      item: (
        <>
          {href ? (
            <Link href={href} className="min-w-0 truncate hover:underline" title={a.summary}>
              {a.summary}
            </Link>
          ) : (
            <span className="min-w-0 truncate" title={a.summary}>
              {a.summary}
            </span>
          )}
          {a.undone_at && <Chip kind="na">Undone</Chip>}
        </>
      ),
      context: (
        <Link href="/settings/autonomy" className="block truncate text-text2 hover:underline" title={a.responsibility_title}>
          {a.responsibility_title}
        </Link>
      ),
      at: a.created_at,
      action: (
        <>
          {open && (
            <Button
              disabled={busy !== null}
              aria-label={`Open ${a.summary}`}
              onClick={() => act(`open-${a.id}`, () => unwrap(api.POST("/v1/oracle-actions/{action_id}/open", path)))}
            >
              Open
            </Button>
          )}
          {a.undo && !a.undone_at && (
            <Button
              variant="ghost"
              disabled={busy !== null}
              aria-label={`Undo ${a.summary}`}
              onClick={() => act(`undo-${a.id}`, () => unwrap(api.POST("/v1/oracle-actions/{action_id}/undo", path)))}
            >
              Undo
            </Button>
          )}
        </>
      ),
    };
  });
}

const dayFmt = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

/** F3: each proposed date basis, for the engineering leads (and owners while none is named):
 * Verify in place, Reject (with a reason) on Plan › Dates. */
export function dateNeeds(inbox: InboxOut, busy: string | null, act: Act): Need[] {
  return (inbox.dates ?? []).map((b) => {
    const day = dayFmt.format(new Date(`${b.supports_date}T00:00:00Z`));
    const path = { params: { path: { basis_id: b.id } } };
    return {
      key: `date-${b.id}`,
      icon: "roadmap",
      kind: "Date",
      item: (
        <span className="truncate" data-testid="inbox-date" title={`${b.reference} supports ${day} · ${b.prd.title}`}>
          {b.reference} supports {day} · {b.prd.title}
        </span>
      ),
      context: <span className="block truncate text-text2">Proposed for verification</span>,
      at: b.proposed_at,
      action: (
        <>
          <Button
            disabled={busy !== null}
            onClick={() =>
              act(`verify-${b.id}`, () => unwrap(api.POST("/v1/schedule-bases/{basis_id}/verify", { ...path, body: { note: null } })))
            }
          >
            Verify
          </Button>
          <LinkButton variant="ghost" href="/plan/dates">
            Reject
          </LinkButton>
        </>
      ),
    };
  });
}

/** Owners only (H4): open strategy drift findings, one row however many, opening Company ›
 * Strategy where each is read and waived. */
export function strategyNeeds(strategy: InboxOut["strategy"]): Need[] {
  if (!strategy) return [];
  const high = strategy.high ? ` · ${strategy.high} high` : "";
  return [
    {
      key: "strategy-drift",
      icon: "alert",
      kind: "Strategy drift",
      item: (
        <span className="truncate" title={`Strategy drift · ${strategy.new_findings} new${high}`}>
          Strategy drift · {strategy.new_findings} new
          {strategy.high > 0 && <span className="text-crit">{high}</span>}
        </span>
      ),
      context: <span className="block truncate text-text2">Goals and roadmap items against the product strategy</span>,
      at: strategy.since,
      action: (
        <LinkButton href={strategy.href} aria-label="Open strategy drift">
          Open
        </LinkButton>
      ),
    },
  ];
}

/**
 * The Inbox's rows, each with its action. `compact` (Home) gives an overrun, a stuck run and
 * a failed import one action that opens the run, where the rest are.
 */
export function inboxNeeds(inbox: InboxOut, busy: string | null, act: Act, compact = false) {
  // D3: a console approval held while blocking problems are open waits for a review.
  const held = (c: InboxOut["checkpoints"][number]) => c.console?.needs === "confirm" && !!c.gate && !c.gate.open;
  const checkpoints: Need[] = inbox.checkpoints.map((c) => ({
    key: c.id,
    icon: "flag",
    kind: "Checkpoint",
    item: (
      <>
        <span className="truncate">{CHECKPOINT_LABEL[c.kind]}</span>
        {held(c) ? (
          <Chip kind="warn" title={CONSOLE_HELD}>
            Console approval held
          </Chip>
        ) : c.console && (
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
        {held(c) && <span className="block truncate text-warn">{CONSOLE_HELD}</span>}
      </span>
    ),
    run: shortId(c.run_id),
    at: c.created_at,
    action: held(c) ? (
      // The run page's checkpoint row, until the kind's review screen ships (D1).
      <LinkButton href={`/runs/${c.run_id}#decide`}>Review</LinkButton>
    ) : (
      // The same verb as the runs list: the run page opens at the decision; a priority stop
      // opens its order next to the live ranking (C8), where it is decided too.
      <LinkButton href={orderHref(c) ?? `/runs/${c.run_id}#decide`}>Decide</LinkButton>
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
              if (await confirmInPage({ destructive: true, action: "Stop cancelling", message: STOP_CANCELLING_CONFIRM })) {
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
              if (await confirmInPage({ destructive: true, action: "Cancel again", message: CANCEL_AGAIN_CONFIRM })) {
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

  // Decided, not delivered to the run yet (owner, 2026-10-20): shown only, nothing to decide
  // (Oracle sends it again on every tick), not counted. The run, the review and SwarmCloud's
  // last answer; Open goes to the run.
  // Revising wins: Oracle's send-back means no human decision is owed, so a run in both
  // shows once, as Revising.
  const revisingRuns = new Set((inbox.revising ?? []).map((r) => r.id));
  const deliveries: Need[] = (inbox.deliveries ?? []).filter((c) => !revisingRuns.has(c.run_id)).map((c) => ({
    key: c.id,
    icon: "clock",
    kind: "Decision",
    item: (
      // Two lines, wrapped rather than cut: the review and its decision, then SwarmCloud's last answer.
      <span className="flex min-w-0 flex-col py-1" title={deliveryText(c)}>
        <span className="break-words">
          {CHECKPOINT_LABEL[c.kind]}: {c.status === "approved" ? "approved" : "changes requested"}
          {c.delivery?.decided_by_name && ` by ${c.delivery.decided_by_name}`}
        </span>
        {c.delivery?.last_error && (
          <span className="text-sm break-words text-text2" data-testid="delivery-error">
            Last: {c.delivery.last_error}
          </span>
        )}
      </span>
    ),
    context: (
      <Link href={`/runs/${c.run_id}`} className="block truncate hover:underline" title={[c.flow_title, c.segment_title, c.document_slug].filter(Boolean).join(" · ")}>
        <RunName run={c} />
      </Link>
    ),
    run: shortId(c.run_id),
    at: c.decided_at ?? c.created_at,
    action: <LinkButton href={`/runs/${c.run_id}`}>Open</LinkButton>,
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

  // A refused draft Oracle sent back to the writer itself (owner, 2026-10-20): the review's
  // state while the revision runs, as the run page shows it, never a decision request. Shown
  // only, like Looking: not counted in the total, on Home or by the badge.
  const revising: Need[] = (inbox.revising ?? []).map((r) => ({
    key: `revising-${r.id}`,
    icon: "clock",
    kind: "Revising",
    item: (
      <span className="truncate" title={r.sent_back ?? undefined} data-testid="inbox-revising-state">
        {SENT_BACK_STATE}
      </span>
    ),
    context: runContext(r),
    run: shortId(r.id),
    at: r.started_at ?? r.created_at,
    action: openRun(r),
  }));

  return { checkpoints, deliveries, approvals, overruns, lookups, imports, searches, revising };
}

/**
 * My sources that need attention: saved before a newer rule they break (more than 100 Slack
 * channels, a date out of range), so they are not synced until edited. GET /v1/sources
 * filtered here; each row opens the source on Settings › Sources, where Edit is.
 */
export function sourceNeeds(sources: Schemas["SourceOut"][]): Need[] {
  return sources
    .filter((s) => s.status === "needs_attention")
    .map((s) => ({
      key: s.id,
      icon: "sources",
      kind: "Source",
      item: (
        <span className="truncate" title={s.last_error ?? undefined}>
          {s.last_error ?? "Needs attention: edit this source to sync it again"}
        </span>
      ),
      context: <span className="block truncate">{s.name}</span>,
      at: s.updated_at,
      action: (
        <LinkButton href={`/settings/sources#source-${s.id}`} aria-label={`Edit ${s.name}`}>
          Edit
        </LinkButton>
      ),
    }));
}

/** H6 launch rows: Ready to launch and Notes to send (the launch's owner), Set tier (approvers),
 * each opening the launch; Shipped (a member's personal note) is shown only, carrying the note. */
export function launchNeeds(inbox: InboxOut): { counted: Need[]; shipped: Need[] } {
  const rows = inbox.launches ?? [];
  const need = (r: (typeof rows)[number]): Need => ({
    key: `launch-${r.reason}-${r.launch_id}`,
    icon: r.reason === "shipped_note" ? "check" : "flag",
    kind: r.reason === "ready" ? "Ready to launch" : r.reason === "set_tier" ? "Set tier" : r.reason === "notes_to_send" ? "Notes to send" : "Shipped",
    item: (
      <span className="truncate" title={r.title} data-testid="launch-need">
        {r.title}
      </span>
    ),
    context:
      r.reason === "shipped_note" && r.note ? (
        <span className="block truncate text-text2" title={r.note}>
          {r.note}
        </span>
      ) : (
        <span className="block truncate text-text2">Launches</span>
      ),
    at: r.at,
    action: (
      <LinkButton variant="secondary" href={`/roadmap/launches?launch=${r.launch_id}`}>
        Open
      </LinkButton>
    ),
  });
  return { counted: rows.filter((r) => r.counted).map(need), shipped: rows.filter((r) => !r.counted).map(need) };
}

/**
 * Every row of the one Inbox, each in its state (owner, 2026-10-20): checkpoints, cost
 * approvals, overruns, stuck runs, couldn't-import, couldn't-revoke and access changes still failing (owners), feedback items and the questions asked
 * of me are New or Open; feedback items also Staged, Declined or Done. Home's Needs you is
 * the New and Open rows, so the badge, Home and /inbox count the same items.
 */
export function allNeeds(
  inbox: InboxOut,
  asked: Need[],
  busy: string | null,
  act: Act,
  seenBefore: string | null | undefined,
  onActed: OnActed,
  compact = false,
): StatedNeed[] {
  const n = inboxNeeds(inbox, busy, act, compact);
  // A row may carry its own state and count (a question answered in place: ./_questions).
  const launches = launchNeeds(inbox);
  const stated = (rows: Need[], group: NeedGroup, counted = true): StatedNeed[] =>
    rows.map((r) => ({
      ...r,
      state: (r.state as InboxState | undefined) ?? (isNew(r.at, seenBefore) ? "new" : "open"),
      counted: r.counted ?? counted,
      group,
    }));
  return [
    ...stated(n.checkpoints, "checkpoints"),
    ...stated(n.approvals, "approvals"),
    ...stated(n.overruns, "overruns"),
    ...stated(n.lookups, "lookups"),
    ...stated(n.imports, "imports"),
    ...stated(revokeNeeds(inbox.revoke_failures ?? [], busy, act), "revoke-failures"),
    ...stated(accessNeeds(inbox.access_failures ?? [], busy, act), "access-failures"),
    ...stated(reportFailureNeeds(inbox.report_failures ?? [], busy, act), "report-failures"),
    ...reportNeeds(inbox.reports ?? [], seenBefore),
    ...stated(strategyNeeds(inbox.strategy), "strategy"),
    ...stated(dateNeeds(inbox, busy, act), "dates"),
    ...stated(launches.counted, "launches"),
    ...oracleActionNeeds(inbox.oracle_actions ?? [], busy, act, seenBefore),
    ...feedbackNeeds(inbox, seenBefore, onActed, compact),
    ...decisionNeeds(inbox, busy, act, seenBefore),
    ...stated(asked, "questions"),
    // Shown only, under Open: nothing to decide, not an item.
    ...stated(n.deliveries, "deliveries", false).map((r) => ({ ...r, state: "open" as const })),
    ...stated(n.searches, "searches", false).map((r) => ({ ...r, state: "open" as const })),
    ...stated(n.revising, "revising", false).map((r) => ({ ...r, state: "open" as const })),
    ...stated(launches.shipped, "shipped", false),
  ];
}

const DECISION_KIND: Record<InboxOut["decisions"][number]["reason"], string> = {
  needs_decision: "Decision needs you",
  review_due: "Review due",
  oracle_decided: "Oracle decided",
  informed: "Decided",
};

/**
 * The decision log's rows (H1): a proposal I decide (Open, Decide) and a review that has come
 * due (Reaffirm for 90 more days in place, Open) count; a decision made that I am informed of
 * is shown for a week, and what I just handled moves to Done. Checkpoint records add none.
 */
export function decisionNeeds(inbox: InboxOut, busy: string | null, act: Act, seenBefore: string | null | undefined): StatedNeed[] {
  return (inbox.decisions ?? []).map((d) => {
    const href = `/company/decisions?d=${d.number}`;
    const live = d.state !== "done";
    const label = `${DECISION_KIND[d.reason]} · ${d.ref} ${d.title}`;
    return {
      key: `decision-${d.id}-${d.reason}`,
      icon: "company",
      kind: "Decision",
      item: (
        <span className="truncate" title={label}>
          {d.reason === "informed" ? `${DECISION_KIND[d.reason]} · ${d.ref} ${d.title}` : label}
        </span>
      ),
      context: <span className="block truncate">{d.review_at && d.reason === "review_due" ? `Review was due ${formatDate(`${d.review_at}T12:00:00`)}` : "Decision log"}</span>,
      at: d.since,
      action: (
        <>
          {live && d.reason === "needs_decision" && <LinkButton href={`${href}&act=decide`}>Decide</LinkButton>}
          {live && d.reason === "review_due" && (
            <Button
              aria-label={`Reaffirm ${d.ref} for 90 more days`}
              disabled={busy !== null}
              onClick={() =>
                act(`reaffirm-${d.id}`, () =>
                  unwrap(
                    api.POST("/v1/decisions/{decision}/reviews", {
                      params: { path: { decision: String(d.number) } },
                      body: { verdict: "reaffirmed", note: "Reaffirmed from the Inbox for 90 more days" },
                    }),
                  ),
                )
              }
            >
              Reaffirm +90 days
            </Button>
          )}
          <LinkButton href={href} aria-label={`Open ${d.ref}`}>
            Open
          </LinkButton>
        </>
      ),
      state: d.state === "done" ? "done" : isNew(d.since, seenBefore) ? "new" : "open",
      counted: d.counts,
      group: "decisions" as const,
    };
  });
}

/** What the rail badge counts: the new and open items. */
export const waitingNeeds = (rows: StatedNeed[]) => rows.filter((r) => r.counted && (r.state === "new" || r.state === "open"));
