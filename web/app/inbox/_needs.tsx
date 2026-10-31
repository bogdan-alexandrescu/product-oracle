"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useId, useState, type ReactNode } from "react";

import { Button, Chip, CodeText, confirmInPage, CostFigure, DataTable, Icon, InfoTip, LinkButton, type Column, type IconName } from "@/components/ds";
import { api, unwrap, type Schemas } from "@/lib/api/client";
import { addDays, displayZone, formatInZone, zoneInstant } from "@/lib/dates";
import { formatAge, formatDate, formatDateTime, formatMoney, plural } from "@/lib/format";
import { runLabel } from "@/lib/labels";
import { useMe, type Operation } from "@/lib/me";
import { errorMessage } from "@/lib/use-query";
import { BUILD_PARAM } from "@/components/NextDraft";
import { sectionHref } from "@/lib/section-link";
import {
  acceptTrackAlertDate,
  alertSentence,
  firstSafeAction,
  HEALTH_WORD,
  inboxTracks,
  keepTrackAlert,
  planHref,
  reopenTrackAlert,
  type InboxTrack,
  type TrackAlertOut,
} from "@/lib/api/track-alerts";

import { calendarDay } from "@/lib/dates";

import { InboxActions, SuggestionPeek, type OnActed } from "./_actions";
import {
  CANCEL_AGAIN_CONFIRM,
  briefsCheck,
  CHECKPOINT_LABEL,
  datesCheck,
  datesToDecide,
  FINAL_STATUSES,
  orderHref,
  RETRY_CONFIRM,
  reviewHref,
  SENT_BACK_STATE,
  STOP_CANCELLING_CONFIRM,
  deliveryText,
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
  at?: string | null;
  action: ReactNode;
  /** The row's Inbox state (new, open, staged, declined, done), when it has one. */
  state?: string;
  /** Whether it counts as an item (a question settled in place does not, until it moves to Done). */
  counted?: boolean;
  /**
   * qa-company-4: only another role acts on it (Owners decide): shown under "For your
   * information", never counted as waiting on me.
   */
  fyi?: boolean;
  /** Drawn under the row, across it: the row opened in place (a question's answer form). */
  detail?: ReactNode;
  /**
   * #305: Oracle's text the row quotes. The row keeps it plain (one link, its tooltip);
   * "Show the text" opens it under the row with each known code carrying the card.
   */
  quote?: string | null;
  /** Next to the age: the wait's time left ("19 h left"). */
  left?: string | null;
  /** The Age tooltip when `at` is a calendar day (no time): the day as written ("Oct 12"). */
  atTip?: string;
  /** D9: rows drawn indented under this one (Inbox only, never Home); not items of their own. */
  children?: Need[];
  /** The parent's key, on a child row. */
  childOf?: string;
};

/**
 * How long a row has waited, in one unit (formatAge: "5m", "3h", "1d", "2w"); nothing for a
 * row with no time or one still ahead (a ritual's due time), never a dash.
 */
function ageOf(at: string | null | undefined): string {
  if (!at) return "";
  const t = new Date(at).getTime();
  if (Number.isNaN(t) || t > Date.now()) return "";
  return formatAge(t);
}

/** A cost in dollars ("$53.00"), or that there is none yet. */
const money = (v: number | null | undefined) => (v == null ? "no estimate" : formatMoney(v));

export const NEED_COLUMNS: Column<Need>[] = [
  {
    key: "kind",
    header: "Kind",
    width: "170px",
    phone: "meta",
    // A child row's kind cell is empty: the left rule ties it to its parent.
    className: "max-[600px]:has-[[data-child-rule]]:hidden",
    cell: (n) =>
      n.childOf ? (
        <span data-child-rule aria-hidden className="ml-2 block h-7 border-l-2 border-line-strong" />
      ) : (
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
    // The item's text keeps its room: a chip or a note goes to a second line rather than cut it.
    cell: (n) => (
      <span
        className={`flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1 ${n.childOf ? "text-[14px] max-[600px]:border-l-2 max-[600px]:border-line-strong max-[600px]:pl-2" : ""}`}
      >
        {n.item}
      </span>
    ),
  },
  { key: "context", header: "For", width: "24%", phone: "meta", narrow: "hide", cell: (n) => n.context },
  {
    key: "age",
    header: "Age",
    width: "56px",
    align: "right",
    phone: "meta",
    cell: (n) => (
      <span className="tnum text-text2" title={n.atTip ?? (n.at ? formatDateTime(n.at) : undefined)}>
        {ageOf(n.at)}
        {n.left && (
          <span className="block text-[12px] leading-4 text-warn max-[600px]:ml-1.5 max-[600px]:inline" data-testid="need-left">
            {n.left}
          </span>
        )}
      </span>
    ),
  },
  {
    key: "act",
    header: <span className="sr-only">Action</span>,
    // Wide enough for a row's actions on one line (qa-company-9): the primary, then the rest.
    width: "340px",
    align: "right",
    phone: "action",
    wrap: true,
    // D14: a feedback row's actions and their fields go under the row on a phone, full width;
    // so do a child row's fix and Open (D9).
    className:
      "max-[600px]:has-[[data-inbox-actions]]:order-5 max-[600px]:has-[[data-inbox-actions]]:basis-full max-[600px]:has-[[data-child-actions]]:order-5 max-[600px]:has-[[data-child-actions]]:basis-full",
    cell: (n) => (
      <span
        data-row-actions
        className="inline-flex flex-wrap items-center justify-end gap-1.5 min-[601px]:flex-nowrap min-[601px]:[&>a]:whitespace-nowrap min-[601px]:[&>button]:whitespace-nowrap has-[[data-inbox-actions]]:flex has-[[data-inbox-actions]]:w-full has-[[data-child-actions]]:flex has-[[data-child-actions]]:w-full"
      >
        {n.action}
      </span>
    ),
  },
];

/** qa-company-27: on Home's narrow lines a long item or "For" wraps to a second line, then ends in an ellipsis (its title holds the rest). */
const WRAP_TWO = "[&_.truncate]:line-clamp-2 [&_.truncate]:whitespace-normal [&_.truncate]:break-words";

/** Home's narrower lines: one action each. */
export const NEED_COLUMNS_COMPACT: Column<Need>[] = NEED_COLUMNS.map((c) =>
  c.key === "kind"
    ? {
        ...c,
        width: "150px",
        // qa-shell-23: on a phone the last line's "More" comes before its "+N more in Inbox", as on a desktop.
        className: `${c.className ?? ""} max-[600px]:has-[[data-needs-more]]:order-0`,
        cell: (n) => (n.key === "more" ? <span data-needs-more className="contents">{c.cell(n)}</span> : c.cell(n)),
      }
    : c.key === "item"
      ? { ...c, wrap: true, className: `${c.className ?? ""} ${WRAP_TWO}` }
      : c.key === "context"
        ? { ...c, width: "24%", narrow: undefined, wrap: true, className: `${c.className ?? ""} ${WRAP_TWO}` }
        : c.key === "act"
          ? { ...c, width: "180px" }
          : c,
);

/**
 * qa-company-20: Sources that need attention: its reason wraps rather than being cut.
 */
export const SOURCE_COLUMNS: Column<Need>[] = NEED_COLUMNS.map((c) =>
  // qa4-work-35: the same widths as the table above, so For and Age line up.
  c.key === "item" ? { ...c, wrap: true } : c,
);

export function NeedTable({
  title,
  testId,
  rows,
  compact = false,
  heading,
  columns,
}: {
  title: string;
  testId: string;
  rows: Need[];
  compact?: boolean;
  /** Columns of its own (Sources that need attention); else the Inbox's, or Home's when compact. */
  columns?: Column<Need>[];
  /** Shown above the rows: a group that is not something to act on says what it is. */
  heading?: ReactNode;
}) {
  const headingId = useId();
  const [shown, setShown] = useState<ReadonlySet<string>>(new Set());
  if (rows.length === 0) return null;
  const toggle = (key: string) =>
    setShown((s) => {
      const next = new Set(s);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  // D9: each row's children right under it (Home passes none).
  const flat = rows.flatMap((r) => [r, ...(r.children ?? []).map((c) => ({ ...c, childOf: r.key }))]);
  const drawn = flat.map((n) =>
    n.quote
      ? {
          ...n,
          item: (
            <>
              {n.item}
              <button
                type="button"
                aria-label="Show the text"
                aria-expanded={shown.has(n.key)}
                onClick={() => toggle(n.key)}
                // qa-company-36: a target of at least 32 px, on a phone too.
                className="-my-1 inline-grid size-8 flex-none place-items-center rounded-goal text-text2 hover:bg-surface2 hover:text-text"
                data-testid="need-quote-toggle"
              >
                <Icon name={shown.has(n.key) ? "chevron-up" : "chevron-down"} />
              </button>
            </>
          ),
        }
      : n,
  );
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
        columns={columns ?? (compact ? NEED_COLUMNS_COMPACT : NEED_COLUMNS)}
        rows={drawn}
        rowKey={(n) => n.key}
        hideHeader
        rowProps={(n) => ({ "data-need": n.childOf ? n.kind || "Checkpoint item" : n.kind, "data-state": n.state, "data-child-of": n.childOf })}
        detail={(n) =>
          n.quote && shown.has(n.key) ? (
            <>
              <p className="text-text2 [overflow-wrap:anywhere]" data-testid="need-quote">
                <CodeText text={n.quote} />
              </p>
              {n.detail}
            </>
          ) : (
            n.detail
          )
        }
      />
    </section>
  );
}

/** Home's count of one kind of item (qa-company-40): a link to the Inbox, where they are. */
export function CountChip({ label, n, testId }: { label: string; n: number; testId?: string }) {
  return (
    <Link href="/inbox" title={`Open the Inbox: ${plural(n, "item")}`} data-testid={testId} className="rounded-full hover:underline hover:brightness-95">
      <Chip kind="line">
        {label} <b className="tnum">{n}</b>
      </Chip>
    </Link>
  );
}

/** A run by its human name ("Usage alerts PRD · Roadmap from an approved PRD"), never its slug. */
function RunName({ run }: { run: Pick<RunSummary, "flow_title" | "document_slug" | "document_kind"> }) {
  const name = runLabel(run);
  return (
    <span className="min-w-0 truncate" title={name}>
      {name}
    </span>
  );
}

/**
 * What the signed-in person may do (lib/me's can, and their id for the items they started):
 * a row draws only the actions they can take. Everything, when a caller passes none.
 */
export type Perms = {
  can: (op: Operation, onItem?: boolean) => boolean;
  userId: string | null;
  /** The capabilities have loaded: until then no row is set aside as another role's. */
  ready?: boolean;
};
const ALL: Perms = { can: () => true, userId: null, ready: true };

/** The signed-in person's Perms, for allNeeds. */
export function usePerms(): Perms {
  const { can, me, capsReady } = useMe();
  return { can, userId: me?.user_id ?? null, ready: capsReady };
}

/** Who acts on a row the signed-in person cannot act on: said in the action's place. */
function ByRole({ who, title }: { who: string; title?: string }) {
  return (
    <span className="text-[13px] whitespace-nowrap text-text2" title={title} data-testid="need-by-role">
      {who}
    </span>
  );
}

export type Act = (key: string, call: () => Promise<unknown>) => Promise<void>;

/** The Inbox's state tabs (C1e, owner 2026-10-20), New first: the default tab on arrival. */
export type InboxState = "new" | "open" | "staged" | "declined" | "done";
export const STATE_TABS: { id: InboxState; label: string }[] = [
  { id: "new", label: "New" },
  // "Seen", not "Open": Open is every row's action (qa-company-48).
  { id: "open", label: "Seen" },
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
  | "tracks"
  | "deliveries"
  | "approvals"
  | "overruns"
  | "lookups"
  | "imports"
  | "revoke-failures"
  | "access-failures"
  | "share-revocations"
  | "access-requests"
  | "report-failures"
  | "reports"
  | "strategy"
  | "oracle-actions"
  | "discussions"
  | "feedback"
  | "questions"
  | "searches"
  | "revising"
  | "decisions"
  | "launches"
  | "requests"
  | "dates"
  | "rituals"
  | "metrics"
  | "outcomes"
  | "webhooks"
  | "reminders"
  | "minutes"
  | "shipped"
  | "fyi";
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
  perms: Perms = ALL,
): StatedNeed[] {
  // Accept, Decline and Stage for agents are an approver's (the API's route roles).
  const mayDecide = perms.can("accept_suggestion") && perms.can("update_feedback");
  // qa-company-4: an open item only an approver decides is for my information, not counted.
  const othersDecide = perms.ready !== false && !mayDecide;
  const docLink = (slug: string, title: string | null | undefined) => (
    <Link href={`/documents/${slug}`} className="block truncate hover:underline" title={title ?? slug}>
      {title ?? slug}
    </Link>
  );
  // qa-company-16: a document's staged row is as old as its latest staged change.
  const stagedAt = (docId: string) =>
    (inbox.items ?? [])
      .filter((f) => f.document_id === docId && f.state === "staged")
      .map((f) => f.updated_at)
      .sort()
      .at(-1) ?? null;
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
        title={`${plural(row.count, "change")} staged for draft ${row.next_version}`}
        data-testid="staged-row-label"
      >
        {plural(row.count, "change")} staged for draft {row.next_version}
      </Link>
    ),
    context: docLink(row.slug, row.title),
    at: stagedAt(row.document_id),
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
      quote: state === "declined" ? f.resolution_note : null,
      // qa-company-4: an item only an approver decides is not waiting on me.
      counted: !(live && othersDecide),
      group: live && othersDecide ? "fyi" : "feedback",
      item: (
        <>
          <SuggestionPeek href={href} summary={f.summary} text={live ? f.suggestion_text : null} />
          {/* The row names no section key (qa-company-11): its link opens the section. D13:
              feedback on the whole draft says so. */}
          {!f.section_key && (
            <span className="flex-none text-[13px] text-text2" data-testid="inbox-general">
              General
            </span>
          )}
          {outcome}
        </>
      ),
      context: slug ? docLink(slug, f.title) : <span className="block truncate" title={f.title ?? undefined}>{f.title}</span>,
      at: live ? f.created_at : f.updated_at,
      action:
        state === "staged" ? (
          // One Build draft per document (its group row above); the item only opens itself.
          // qa-company-29: a row's only action is its bordered one.
          <LinkButton href={href} aria-label={`Open ${f.summary}`}>
            Open
          </LinkButton>
        ) : live && !compact && mayDecide ? (
          // D14: decide on Oracle's suggestion here; a remount per state and suggestion.
          <InboxActions key={`${f.id}-${state}-${f.suggestion_id ?? ""}`} f={f} href={href} onActed={onActed} />
        ) : live ? (
          // Home (qa-company-10), and a role that cannot decide: one Open, where the item is decided.
          <LinkButton href={href} aria-label={`Open ${f.summary}`} title={mayDecide ? undefined : "Approvers decide feedback"}>
            Open
          </LinkButton>
        ) : (
          <LinkButton href={href} aria-label={`Open ${f.summary}`}>
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

type ShareRevocation = NonNullable<InboxOut["share_revocations"]>[number];

/**
 * Owners only (O5-Q10): share links Oracle revoked because their creator left or was
 * demoted, or their document was trashed or limited. Re-share opens the document's Share
 * sheet in the first link's audience; Dismiss clears the row.
 */
export function shareRevocationNeeds(rows: ShareRevocation[], busy: string | null, act: Act): Need[] {
  return rows.map((r) => {
    const first = r.links[0];
    const labels = r.links.map((l) => `${l.label} (${l.document_title})`).join(", ");
    const key = `share-revoked-${first?.id ?? r.revoked_at}`;
    return {
      key,
      icon: "lock",
      kind: "Links revoked",
      item: (
        <span className="truncate" title={r.title}>
          {r.title}
        </span>
      ),
      context: (
        <span className="block truncate text-text2" title={labels}>
          {labels}
        </span>
      ),
      at: r.revoked_at,
      action: (
        <>
          {first && (
            <LinkButton href={`/documents/${first.document}?share=${first.audience}`}>Re-share</LinkButton>
          )}
          <Button
            variant="ghost"
            disabled={busy !== null}
            onClick={() => act(key, () => unwrap(api.POST("/v1/share-links/dismiss", { body: { ids: r.links.map((l) => l.id) } })))}
          >
            Dismiss
          </Button>
        </>
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

type InboxDiscussion = NonNullable<InboxOut["discussions"]>[number];

/** A link with `param` added to its query, before any #anchor. */
export function withParam(url: string, param: string): string {
  const [path, ...anchor] = url.split("#");
  return `${path}${path.includes("?") ? "&" : "?"}${param}${anchor.length ? `#${anchor.join("#")}` : ""}`;
}

/** A subject's link opened on one of its discussions (G6). */
export const discussionHref = (url: string, id: string) => withParam(url, `discussion=${id}`);

function DiscussionTitle({ d, text }: { d: Pick<InboxDiscussion, "visibility">; text: string }) {
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <span className="min-w-0 truncate" title={text}>
        {text}
      </span>
      {d.visibility === "private" && (
        <span title="Private" className="inline-flex flex-none text-text2" data-testid="discussion-private-lock">
          <Icon name="lock" size={16} />
          <span className="sr-only">Private</span>
        </span>
      )}
    </span>
  );
}

const DISCUSSION_KIND: Record<InboxDiscussion["kind"], string> = {
  invited: "Invited",
  mentioned: "Mentioned you",
  changes_proposed: "Discussion",
};

/**
 * G6: the discussions waiting on me, one row each, New or Open until done: Invited (Join, or
 * Read for viewers), Mentioned you (the excerpt in quotes, Open) and, for approvers, a
 * discussion's changes proposed (Review changes opens the thread at its changes card).
 */
export function discussionNeeds(inbox: InboxOut, seenBefore: string | null | undefined): StatedNeed[] {
  return (inbox.discussions ?? []).map((r) => {
    const done = r.state === "done";
    const state: InboxState = done ? "done" : isNew(r.at, seenBefore) ? "new" : "open";
    const base = { key: `discussion-${r.id}`, icon: "comment" as const, kind: DISCUSSION_KIND[r.kind], at: r.at, state, counted: true, group: "discussions" as const };
    if (r.kind === "invited")
      return {
        ...base,
        item: <DiscussionTitle d={r} text={r.title} />,
        context: (
          <span className="block truncate" title={r.subject_label}>
            {r.subject_label}
            {r.by && <span className="text-text2"> · by {r.by.name}</span>}
          </span>
        ),
        action: (
          <LinkButton variant={done ? "ghost" : "primary"} href={r.subject_url}>
            {r.can_write ? "Join" : "Read"}
          </LinkButton>
        ),
      };
    if (r.kind === "mentioned")
      return {
        ...base,
        item: (
          <span className="min-w-0 truncate" title={r.excerpt ?? ""}>
            “{r.excerpt ?? ""}”
          </span>
        ),
        context: (
          <span className="flex min-w-0 items-center gap-1 truncate" title={`${r.title} · ${r.subject_label}`}>
            <DiscussionTitle d={r} text={r.title} />
            <span className="truncate text-text2">· {r.subject_label}</span>
          </span>
        ),
        action: (
          <LinkButton variant={done ? "ghost" : undefined} href={r.subject_url} aria-label={`Open ${r.title}`}>
            Open
          </LinkButton>
        ),
      };
    const people = [...r.people, ...(r.people_more ? [`+${r.people_more}`] : [])].join(", ");
    return {
      ...base,
      item: <DiscussionTitle d={r} text={`${r.title} · ${plural(r.count ?? 0, "change")} proposed`} />,
      context: (
        <span className="block truncate text-text2" title={people}>
          {people}
        </span>
      ),
      action: <LinkButton href={withParam(r.subject_url, "changes=1")}>Review changes</LinkButton>,
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

/** Something written like a code ("G-B", "F-28", "R-12"): its expanded text names it. */
export const CODE_LIKE = /\b[A-Z]{1,3}-[A-Z0-9]{1,5}\b/;

/**
 * "Oracle did" (H11): what Oracle did on its own, for each person it told. Counted until I
 * open it (Done then, for me only); Undo when the behaviour that acted gave an undo route.
 */
export function oracleActionNeeds(actions: OracleAction[], busy: string | null, act: Act, seenBefore: string | null | undefined): StatedNeed[] {
  return actions.map((a) => {
    const path = { params: { path: { action_id: a.id } } };
    const href = typeof a.subject?.href === "string" && a.subject.href.startsWith("/") ? a.subject.href : null;
    const open = a.state === "open";
    const codes = CODE_LIKE.test(a.summary);
    const line = codes ? "min-w-0 truncate" : "min-w-0";
    return {
      key: `oracle-${a.id}`,
      icon: "check",
      kind: "Oracle did",
      // qa-company-30: "Show the text" only where it adds something: Oracle's text names codes
      // (#305, each carrying its card there). Otherwise the line wraps, all of it read in place.
      quote: codes ? a.summary : null,
      state: open ? (isNew(a.created_at, seenBefore) ? "new" : "open") : "done",
      counted: true,
      group: "oracle-actions",
      item: (
        <>
          {href ? (
            <Link href={href} className={`${line} hover:underline`} title={codes ? a.summary : undefined} data-testid="oracle-did-summary">
              {a.summary}
            </Link>
          ) : (
            <span className={line} title={codes ? a.summary : undefined} data-testid="oracle-did-summary">
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

/** F3: each proposed date basis, for the engineering leads (and owners while none is named):
 * Verify in place, Reject (with a reason) on Plan › Dates. */
export function dateNeeds(inbox: InboxOut, busy: string | null, act: Act): Need[] {
  return (inbox.dates ?? []).map((b) => {
    const day = calendarDay(b.supports_date);
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
 * A checkpoint row's name; the Engineering check says its document, features and blocking
 * questions, the Engineering dates its document, Now items and the dates left to decide (F4).
 */
function checkpointSummary(c: InboxOut["checkpoints"][number]): string {
  const dates = datesCheck(c);
  if (dates) {
    const n = dates.items.length;
    return [c.segment_title ?? CHECKPOINT_LABEL[c.kind], c.document_slug ?? dates.prd?.document, `${n} Now item${n === 1 ? "" : "s"}`, `${datesToDecide(c)} to decide`]
      .filter(Boolean)
      .join(" · ");
  }
  const check = briefsCheck(c);
  if (!check) return CHECKPOINT_LABEL[c.kind];
  const n = check.features.length;
  const blocking = (c.gate?.left ?? []).filter((x) => x.code === "blocking_question").length;
  return [c.segment_title ?? CHECKPOINT_LABEL[c.kind], c.document_slug, `${n} feature${n === 1 ? "" : "s"}`, ...(blocking ? [`${blocking} blocking`] : [])]
    .filter(Boolean)
    .join(" · ");
}

type InboxCheckpointRow = InboxOut["checkpoints"][number];
type InboxSummary = NonNullable<InboxCheckpointRow["summary"]>;
type InboxChild = InboxSummary["children"][number];
type DraftAction = NonNullable<InboxChild["staged"]>;

/**
 * D9: the child rows I fixed on this visit, by `{checkpoint}-{item}`, each at its row's place:
 * the Inbox's three rows hold only items still needing me, so the page keeps the row I just
 * fixed, done with Undo, until I undo it or leave.
 */
export type FixedHere = {
  rows: Record<string, { child: InboxChild; at: number }>;
  set: (key: string, row: { child: InboxChild; at: number } | null) => void;
};

/** The Inbox page's FixedHere. */
export function useFixedHere(): FixedHere {
  const [rows, setRows] = useState<FixedHere["rows"]>({});
  return {
    rows,
    set: (key, row) =>
      setRows((now) => {
        const rest = Object.fromEntries(Object.entries(now).filter(([k]) => k !== key));
        return row ? { ...rest, [key]: row } : rest;
      }),
  };
}

/** The wait's time left, as the decision header words it. */
const timeLeft = (s: number) => (s >= 3600 ? `${Math.floor(s / 3600)} h left` : `${Math.max(1, Math.floor(s / 60))} min left`);

const HORIZON_WORD: Record<string, string> = { now: "Now", next: "Next", later: "Later" };

/** What a staged or suggested action does, in the words of its fix (`done`: after it is staged). */
function actionWords(a: Pick<DraftAction, "kind" | "field" | "value">, done: boolean): string {
  if (a.kind === "accept") return done ? "Accepted" : "Accept";
  if (a.kind === "drop") return done ? "Dropped" : "Drop";
  if (a.kind === "edit" && a.field === "horizon") {
    const h = HORIZON_WORD[String(a.value)] ?? String(a.value);
    return done ? `Moved to ${h}` : `Move to ${h}`;
  }
  if (a.kind === "edit" && a.field === "milestone_date") return done ? "Date removed" : "Remove date";
  if (a.kind === "edit" && a.field === "depends_on") return done ? "Dependency removed" : "Remove dependency";
  if (a.kind === "edit" && a.field === "order") return done ? "Order fixed" : "Fix order";
  return a.field ? `${a.kind} ${a.field}` : a.kind;
}

/**
 * D9: up to three items of a roadmap items checkpoint, each with its first reason, its safe
 * fix (staged in one click, undone in one) and Open, then "+k more · h handled".
 */
/** D9's child row: the item on the kind's review screen (D1 `?item=`), else the run page's decision. */
function itemHref(c: InboxCheckpointRow, item: string): string {
  const screen = reviewHref(c);
  return screen ? `${screen}?item=${encodeURIComponent(item)}` : `/runs/${c.run_id}?item=${encodeURIComponent(item)}#decide`;
}

function childNeeds(c: InboxCheckpointRow, summary: InboxSummary, busy: string | null, act: Act, fixed?: FixedHere): Need[] {
  const review = reviewHref(c) ?? `/runs/${c.run_id}#decide`;
  // The rows I fixed on this visit stay in their places, done; the rest are the API's.
  const mine = Object.entries(fixed?.rows ?? {}).filter(([k]) => k.startsWith(`${c.id}-`));
  const children = summary.children.filter((child) => !fixed?.rows[`${c.id}-${child.item}`]);
  for (const [, row] of mine.sort((a, b) => a[1].at - b[1].at)) children.splice(Math.min(row.at, children.length), 0, row.child);
  const rows: Need[] = children.map((child, at) => ({
    key: `${c.id}-${child.item}`,
    icon: "flag",
    kind: "",
    item: (
      <>
        <span className="truncate" data-testid="child-title" title={child.title ?? child.item}>
          {child.title ?? child.item}
        </span>
        <Chip kind={child.reason.severity === "blocking" ? "crit" : "warn"} title={child.reason.text}>
          {child.reason.label}
        </Chip>
      </>
    ),
    context: (
      <span className="block truncate text-[14px] text-text2" title={child.reason.text}>
        {child.reason.text}
      </span>
    ),
    action: <ChildActions key={`${child.item}-${child.staged?.id ?? ""}`} c={c} child={child} at={at} busy={busy} act={act} fixed={fixed} />,
  }));
  if (summary.more > 0) {
    rows.push({
      key: `${c.id}-more`,
      icon: "flag",
      kind: "",
      item: (
        <Link href={review} className="truncate text-[14px] hover:underline" data-testid="child-more">
          +{summary.more} more · {summary.handled} handled
        </Link>
      ),
      context: null,
      action: null,
    });
  }
  return rows;
}

/** A child row's fix, a commenter's suggestion with Stage, or what was staged with Undo; then Open. */
function ChildActions({
  c,
  child,
  at,
  busy,
  act,
  fixed,
}: {
  c: InboxCheckpointRow;
  child: InboxChild;
  at: number;
  busy: string | null;
  act: Act;
  fixed?: FixedHere;
}) {
  // Optimistic: the row reads done while the stage lands; an error puts it back, said inline.
  const [staging, setStaging] = useState(false);
  const [undoing, setUndoing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const path = { run_id: c.run_id, checkpoint_id: c.id };
  const run = (key: string, call: () => Promise<unknown>, reset: () => void) => {
    setError(null);
    void act(key, () => call().catch((e) => setError(errorMessage(e)))).finally(reset);
  };
  const row = `${c.id}-${child.item}`;
  // Staged: the row stays here, done with Undo, though the item leaves the Inbox's three rows.
  const keep = (review: Schemas["CheckpointReview"], found: (a: DraftAction) => boolean) => {
    const staged = review.items.find((i) => i.key === child.item)?.actions?.find((a) => a.state === "staged" && found(a));
    if (staged) fixed?.set(row, { child: { ...child, staged }, at });
  };
  const staged = child.staged && !undoing ? child.staged : null;
  const fix = child.fix;
  const title = child.title ?? child.item;
  return (
    <span data-child-actions className="inline-flex flex-wrap items-center justify-end gap-1.5 max-[600px]:w-full max-[600px]:[&>*]:w-full">
      {staged || (staging && fix) ? (
        <>
          <span className="text-[14px] text-pass" data-testid="child-done">
            ✓ {staged ? actionWords(staged, true) : fix ? actionWords(fix.action, true) : ""}
          </span>
          {staged && (
            <Button
              variant="ghost"
              disabled={busy !== null}
              aria-label={`Undo ${actionWords(staged, true)} on ${title}`}
              onClick={() => {
                setUndoing(true);
                // Undone: the row goes back to the API's once the Inbox has reloaded.
                let undone = false;
                run(
                  `undo-${staged.id}`,
                  () =>
                    unwrap(api.DELETE("/v1/runs/{run_id}/checkpoints/{checkpoint_id}/actions/{action_id}", { params: { path: { ...path, action_id: staged.id } } })).then(() => {
                      undone = true;
                    }),
                  () => {
                    setUndoing(false);
                    if (undone) fixed?.set(row, null);
                  },
                );
              }}
            >
              Undo
            </Button>
          )}
        </>
      ) : child.suggested ? (
        <>
          <span className="text-[14px] text-text2" data-testid="child-suggested">
            Suggested: {actionWords(child.suggested, false)}
          </span>
          <Button
            disabled={busy !== null}
            aria-label={`Stage ${actionWords(child.suggested, false)} on ${title}`}
            onClick={() => {
              const id = child.suggested!.id;
              run(
                `stage-${id}`,
                () =>
                  unwrap(api.POST("/v1/runs/{run_id}/checkpoints/{checkpoint_id}/actions/{action_id}/stage", { params: { path: { ...path, action_id: id } } })).then((review) =>
                    keep(review, (a) => a.id === id),
                  ),
                () => undefined,
              );
            }}
          >
            Stage
          </Button>
        </>
      ) : (
        fix && (
          <Button
            disabled={busy !== null}
            aria-label={`${fix.label} for ${title}`}
            onClick={() => {
              setStaging(true);
              const a = fix.action;
              run(
                `fix-${c.id}-${child.item}`,
                () =>
                  unwrap(
                    api.POST("/v1/runs/{run_id}/checkpoints/{checkpoint_id}/actions", {
                      params: { path },
                      body: { item_key: a.item, kind: a.kind, field: a.field ?? null, value: a.value ?? null, answers: [child.reason.code] },
                    }),
                  ).then((review) => keep(review, (x) => x.kind === a.kind && (x.field ?? null) === (a.field ?? null))),
                () => setStaging(false),
              );
            }}
          >
            {fix.label}
          </Button>
        )
      )}
      <LinkButton variant="ghost" href={itemHref(c, child.item)} aria-label={`Open ${title}`}>
        Open
      </LinkButton>
      {error && (
        <span role="alert" className="basis-full text-right text-[13px] text-crit max-[600px]:text-left" data-testid="child-error">
          {error}
        </span>
      )}
    </span>
  );
}

/** The run page's question before cancelling (app/runs/_run-detail.tsx). */
const CANCEL_RUN_CONFIRM = "Cancel this run? Agents still working are stopped.";

/** Who a role is, said of the people holding it: "Approvers decide". */
const ROLE_WORD: Record<InboxOut["checkpoints"][number]["approver_role"], string> = {
  viewer: "Viewers",
  commenter: "Commenters",
  approver: "Approvers",
  owner: "Owners",
};

/**
 * Confirm the baseline's line (qa-company-12): what still needs the person, or that every
 * item is handled; never "0 need you".
 */
function baselineLabel(title: string, summary: { need_you: number; blocking: number; handled: number }): string {
  if (summary.need_you === 0 && summary.blocking === 0) {
    // qa4-work-38: it still waits on an approval, so the line says what is needed.
    return summary.handled > 0 ? `${title}: all ${plural(summary.handled, "item")} handled, approve to continue` : `${title}: approve to continue`;
  }
  const parts = [summary.need_you > 0 && `${summary.need_you} need you`, summary.blocking > 0 && `${summary.blocking} not decided`].filter(Boolean);
  return `${title}: ${parts.join(", ")}`;
}

/**
 * The Inbox's rows, each with its action. `compact` (Home) gives an overrun, a stuck run and
 * a failed import one action that opens the run, where the rest are.
 */
export function inboxNeeds(inbox: InboxOut, busy: string | null, act: Act, compact = false, fixed?: FixedHere, perms: Perms = ALL, onActed?: OnActed) {
  // What the signed-in person may do on a run (qa-company-3): its starter may manage it too.
  const may = (op: Operation, r: { created_by?: string | null }) => perms.can(op, !!perms.userId && r.created_by === perms.userId);
  // D3: a console approval held while blocking problems are open waits for a review.
  const isHeld = (c: InboxOut["checkpoints"][number]) => c.console?.needs === "confirm" && !!c.gate && !c.gate.open;
  const checkpoints: Need[] = inbox.checkpoints.map((c) => {
    const summary = c.summary ?? null;
    const counted = !!summary && c.kind === "roadmap_items";
    const held = summary?.console_held ? " · console approval held" : "";
    const label = counted
      ? summary.need_you === 0 && summary.blocking === 0
        ? "Roadmap items · ready to approve"
        : `Roadmap items · ${summary.need_you} need you`
      : c.kind === "baseline_confirm" && summary
        ? // B2: Confirm the baseline's counts, read from the run's rows; none left is said so (qa-company-12).
          baselineLabel(CHECKPOINT_LABEL[c.kind], summary)
        : checkpointSummary(c);
    const from = counted && summary.source ? `from ${summary.source.title} v${summary.source.version}` : null;
    const wait = summary?.wait;
    const review = `/runs/${c.run_id}#decide`;
    return {
      key: c.id,
      icon: "flag",
      kind: "Checkpoint",
      item: (
        <>
          <span className="truncate" data-testid="checkpoint-label" title={`${label}${held}`}>
            {label}
            {held}
          </span>
          {counted && summary.blocking > 0 && (
            <Chip kind="crit" data-testid="checkpoint-blocking">
              {summary.blocking} blocking
            </Chip>
          )}
          {counted && summary.blocking === 0 && summary.need_you > 0 && summary.to_confirm > 0 && (
            <Chip kind="warn" data-testid="checkpoint-to-confirm">
              {summary.to_confirm} to confirm
            </Chip>
          )}
          {isHeld(c) ? (
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
      context:
        counted && (summary.title || from) ? (
          <span className="block truncate" title={[summary.title, from].filter(Boolean).join(" · ")}>
            {[summary.title ?? c.segment_title ?? c.flow_title, from].filter(Boolean).join(" · ")}
            {isHeld(c) && <span className="block truncate text-warn">{CONSOLE_HELD}</span>}
          </span>
        ) : (
          // The run by its human name, never its slug (qa-company-11).
          <span className="block truncate" title={[c.segment_title, runLabel(c)].filter(Boolean).join(" · ")}>
            {c.segment_title ?? c.flow_title}
            {/* qa-company-17: the document's whole title ("Investor update · October 2026"), not cut at its own "·". */}
            {c.document_slug && <span className="ml-1.5 text-sm text-text2">{runLabel({ ...c, flow_title: "" }).replace(/ · $/, "")}</span>}
            {isHeld(c) && <span className="block truncate text-warn">{CONSOLE_HELD}</span>}
          </span>
        ),
      at: c.created_at,
      left: wait?.state === "open" && wait.seconds_left != null ? timeLeft(wait.seconds_left) : null,
      ...(c.can_decide ? {} : { counted: false, fyi: true }),
      action: !c.can_decide ? (
        // qa-company-3: a role that cannot decide reads the review; who decides is said.
        <>
          <ByRole who={`${ROLE_WORD[c.approver_role]} decide`} title={c.cannot_approve ?? `Only ${ROLE_WORD[c.approver_role].toLowerCase()} can decide this`} />
          <LinkButton href={c.kind === "baseline_confirm" ? `/baseline?run=${c.run_id}` : (reviewHref(c) ?? review)}>
            Open
          </LinkButton>
        </>
      ) : c.kind === "baseline_confirm" ? (
        // B2: the run's review opens in the Baseline, filtered to the run.
        <LinkButton href={`/baseline?run=${c.run_id}`}>Review</LinkButton>
      ) : isHeld(c) ? (
        // A held console approval is confirmed on the kind's review screen (D1, C7), else the run page.
        <LinkButton href={reviewHref(c) ?? review}>Review</LinkButton>
      ) : counted ? (
        // D1: the Roadmap items review screen.
        <LinkButton href={reviewHref(c) ?? review}>Review items</LinkButton>
      ) : reviewHref(c) ? (
        // F4: the Engineering check and the Engineering dates have their own review screens.
        <LinkButton href={reviewHref(c)!}>Review</LinkButton>
      ) : (
        // The same verb as the runs list: the run page opens at the decision; a priority stop
        // opens its order next to the live ranking (C8), where it is decided too; a PRD or
        // roadmap review opens its version (D10); a feature set opens its review screen (C7).
        <LinkButton href={reviewHref(c) ?? orderHref(c) ?? c.review_link ?? `/runs/${c.run_id}#decide`}>Decide</LinkButton>
      ),
      children: counted && !compact ? childNeeds(c, summary, busy, act, fixed) : undefined,
    };
  });

  const runContext = (r: RunSummary) => (
    <Link href={`/runs/${r.id}`} className="block truncate hover:underline">
      <RunName run={r} />
    </Link>
  );
  const openRun = (r: RunSummary) => <LinkButton href={`/runs/${r.id}`}>Open</LinkButton>;

  const approvals: Need[] = inbox.approvals.map((r) => ({
    key: r.id,
    icon: "coin",
    kind: "Cost approval",
    item: (
      <>
        <span className="truncate">Start run</span>
        <CostFigure usd={r.estimate_usd} est prominent />
        <span className="sr-only">Estimated {money(r.estimate_usd)}, over the $50 approval threshold.</span>
      </>
    ),
    context: (
      <Link href={`/runs/${r.id}`} className="block truncate hover:underline">
        <RunName run={r} />
      </Link>
    ),
    at: r.created_at,
    ...(perms.ready === false || may("approve_run", r) ? {} : { counted: false, fyi: true }),
    action: !may("approve_run", r) ? (
      // qa-company-3: owners approve spend; anyone else sees the request, read-only.
      <>
        <ByRole who="Owners approve" title="Only an owner can approve a run's cost" />
        {openRun(r)}
      </>
    ) : (
      <Button
        aria-label={`Approve ${money(r.estimate_usd)}`}
        disabled={busy !== null}
        onClick={async () => {
          // qa-company-1 (round 3): spend is asked first, naming the amount, on Home as in the
          // Inbox; once approved, the page says so (the Inbox's act says it; Home's notice here).
          const amount = r.estimate_usd == null ? null : formatMoney(r.estimate_usd);
          // The threshold is the API's own (the flow catalog's), never a figure written here.
          const catalog = amount ? await unwrap(api.GET("/v1/flows")).catch(() => null) : null;
          const threshold = catalog ? `the ${formatMoney(catalog.approval_threshold_usd)} approval threshold` : "the approval threshold";
          const asked = await confirmInPage({
            action: amount ? `Approve ${amount}` : "Approve run",
            message: `Start ${runLabel(r)}? ${amount ? `Its estimated cost, ${amount}, is over ${threshold}.` : "It has no cost estimate yet."} The run starts at once.`,
          });
          if (!asked) return;
          void act(`approve-${r.id}`, async () => {
            await unwrap(api.POST("/v1/runs/{run_id}/approve", path(r.id)));
            if (compact) onActed?.({ id: `approve-${r.id}`, message: "Approved: run started" });
          });
        }}
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
          Spent {money(r.spent_usd)} of {money(r.estimate_usd)} estimated
        </span>
      </>
    ),
    context: (
      <Link href={`/runs/${r.id}`} className="block truncate hover:underline">
        <RunName run={r} />
      </Link>
    ),
    at: r.started_at ?? r.created_at,
    ...(perms.ready === false || may("resume_run", r) || may("cancel_run", r) ? {} : { counted: false, fyi: true }),
    // Home (qa-company-10): one Open, the run's page holds Resume and Cancel run.
    action: compact ? (
      openRun(r)
    ) : !may("resume_run", r) && !may("cancel_run", r) ? (
      <>
        <ByRole who="Owners decide" title="Only an owner can resume or cancel this run" />
        {openRun(r)}
      </>
    ) : (
      <>
        {may("resume_run", r) && (
          <Button
            disabled={busy !== null}
            onClick={() => act(`resume-${r.id}`, () => unwrap(api.POST("/v1/runs/{run_id}/resume", path(r.id))))}
          >
            Resume
          </Button>
        )}
        {may("cancel_run", r) && (
          <Button
            variant={may("resume_run", r) ? "ghost" : "secondary"}
            disabled={busy !== null}
            onClick={async () => {
              // qa-company-1: asked first, as the run page does.
              if (await confirmInPage({ destructive: true, action: "Cancel run", message: CANCEL_RUN_CONFIRM })) {
                void act(`cancel-${r.id}`, () => unwrap(api.POST("/v1/runs/{run_id}/cancel", path(r.id))));
              }
            }}
          >
            Cancel run
          </Button>
        )}
      </>
    ),
  }));

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
    at: r.started_at ?? r.created_at,
    action: compact ? (
      openRun(r)
    ) : (
      <>
        {r.can_retry && may("retry_run", r) && (
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
        {r.can_stop_cancelling && may("stop_cancelling_run", r) && (
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
        {r.can_retry_lookup && may("retry_lookup_run", r) && (
          <Button
            disabled={busy !== null}
            onClick={() => act(`lookup-${r.id}`, () => unwrap(api.POST("/v1/runs/{run_id}/retry-lookup", path(r.id))))}
          >
            Retry lookup
          </Button>
        )}
        {(may("cancel_again_run", r) ? (r.cancel_again ?? []) : []).map((wid, _, all) => (
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
        {r.can_dismiss_overrun && may("dismiss_overrun_run", r) && (
          <Button
            variant="ghost"
            disabled={busy !== null}
            onClick={() => act(`dismiss-${r.id}`, () => unwrap(api.POST("/v1/runs/{run_id}/dismiss-overrun", path(r.id))))}
          >
            Dismiss
          </Button>
        )}
        {!FINAL_STATUSES.includes(r.status) && may("cancel_run", r) && (
          <Button
            variant="ghost"
            disabled={busy !== null}
            onClick={async () => {
              if (await confirmInPage({ destructive: true, action: "Cancel run", message: CANCEL_RUN_CONFIRM })) {
                void act(`cancel-${r.id}`, () => unwrap(api.POST("/v1/runs/{run_id}/cancel", path(r.id))));
              }
            }}
          >
            Cancel run
          </Button>
        )}
        {openRun(r)}
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
    at: r.started_at ?? r.created_at,
    action: compact
      ? openRun(r)
      : r.can_retry_import && may("retry_import_run", r) ? (
          <Button
            disabled={busy !== null}
            onClick={() => act(`import-${r.id}`, () => unwrap(api.POST("/v1/runs/{run_id}/retry-import", path(r.id))))}
          >
            Retry
          </Button>
        ) : (
          openRun(r)
        ),
  }));

  // Owners only (owner, 2026-10-25): runs that finished with no document, why and what to do.
  const noDocuments: Need[] = (inbox.no_documents ?? []).map((r) => ({
    key: `no-document-${r.id}`,
    icon: "alert",
    kind: "No document",
    item: (
      <span className="truncate" title={r.no_document ?? undefined} data-testid="inbox-no-document">
        {r.no_document}
      </span>
    ),
    context: runContext(r),
    at: r.finished_at ?? r.started_at ?? r.created_at,
    action: openRun(r),
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
      <Link href={`/runs/${c.run_id}`} className="block truncate hover:underline" title={runLabel(c)}>
        <RunName run={c} />
      </Link>
    ),
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
    at: r.started_at ?? r.created_at,
    action: openRun(r),
  }));

  return { checkpoints, deliveries, approvals, overruns, lookups, imports, noDocuments, searches, revising };
}

/**
 * My sources that need attention: saved before a newer rule they break (more than 100 Slack
 * channels, a date out of range), so they are not synced until edited. GET /v1/sources
 * filtered here; each row opens the source on Settings › Sources, where Edit is.
 */
export function sourceNeeds(sources: Schemas["SourceOut"][], mayEdit = true): Need[] {
  return sources
    .filter((s) => s.status === "needs_attention")
    .map((s) => ({
      key: s.id,
      icon: "sources",
      kind: "Source",
      item: (
        // qa-company-20: the reason wraps to a second line rather than cut mid-sentence.
        <span className="line-clamp-2 min-w-0 break-words whitespace-normal" title={s.last_error ?? undefined} data-testid="source-need-text">
          {s.last_error ?? (mayEdit ? "Needs attention: edit this source to sync it again" : "Needs attention: it syncs again once it is edited")}
        </span>
      ),
      context: (
        <span className="block truncate" title={s.name}>
          {s.name}
        </span>
      ),
      at: s.updated_at,
      // qa-company-44: a role that cannot edit sources reads the row, with no Edit.
      action: mayEdit ? (
        <LinkButton href={`/settings/sources#source-${s.id}`} aria-label={`Edit ${s.name}`}>
          Edit
        </LinkButton>
      ) : (
        <ByRole who="View only" title="Your role cannot edit sources: commenters and above can" />
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
 * H10 request rows: Replies to send (the filer and the decider) and Asked again N times since
 * you said no (the decision's approver: Keep the no, Reopen) count; Answer to your request
 * (the member who asked) is shown only, carrying the reply, until its Open marks it opened.
 */
export function requestNeeds(inbox: InboxOut, busy: string | null, act: Act): { counted: Need[]; shown: Need[] } {
  const rows = inbox.requests ?? [];
  const href = (id: string) => `/requests?request=${id}`;
  const need = (r: (typeof rows)[number]): Need => {
    const label =
      r.reason === "replies_to_send"
        ? `Replies to send · ${r.count ?? 0} · ${r.title}`
        : r.reason === "asked_again"
          ? `Asked again ${r.count ?? 0} ${r.count === 1 ? "time" : "times"} since you said no · ${r.title}`
          : `Answer to your request · ${r.title}`;
    return {
      key: `request-${r.reason}-${r.request_id}`,
      icon: r.reason === "answer" ? "check" : "flag",
      kind: r.reason === "answer" ? "Answer" : "Request",
      item: (
        <span className="truncate" title={label} data-testid="request-need">
          {label}
        </span>
      ),
      context:
        r.reason === "answer" && r.body ? (
          <span className="block truncate text-text2" title={r.body} data-testid="request-answer">
            {r.body}
          </span>
        ) : (
          // qa-onboarding-27: no bare decision code in Needs you.
          <span className="block truncate text-text2">Requests</span>
        ),
      at: r.at,
      action: (
        <>
          {r.reason === "asked_again" && <AskedAgainActions requestId={r.request_id} title={r.title} busy={busy} act={act} />}
          {r.reason === "answer" && r.reply_id ? (
            <OpenAnswer replyId={r.reply_id} href={href(r.request_id)} busy={busy} act={act} />
          ) : (
            <LinkButton variant="secondary" href={href(r.request_id)}>
              Open
            </LinkButton>
          )}
        </>
      ),
    };
  };
  return { counted: rows.filter((r) => r.counts).map(need), shown: rows.filter((r) => !r.counts).map(need) };
}

/**
 * Answer to your request's Open (owner 2026-10-24): marks the answer opened, which ends the
 * row, and opens the request.
 */
function OpenAnswer({ replyId, href, busy, act }: { replyId: string; href: string; busy: string | null; act: Act }) {
  const router = useRouter();
  return (
    <Button
      disabled={busy !== null}
      onClick={() =>
        act(`open-answer-${replyId}`, async () => {
          await unwrap(api.POST("/v1/request-replies/{reply_id}/opened", { params: { path: { reply_id: replyId } } }));
          router.push(href);
        })
      }
    >
      Open
    </Button>
  );
}

/** Asked again: Keep the no with the person's own note (a reaffirmed review), or Reopen. */
function AskedAgainActions({ requestId, title, busy, act }: { requestId: string; title: string; busy: string | null; act: Act }) {
  const [keeping, setKeeping] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const fieldId = useId();
  const path = { params: { path: { request_id: requestId } } };
  const run = (key: string, call: () => Promise<unknown>) => {
    setError(null);
    void act(key, () => call().catch((e) => setError(errorMessage(e))));
  };
  const errorLine = error && (
    <span role="alert" className="basis-full text-right text-[13px] text-crit max-[600px]:text-left">
      {error}
    </span>
  );
  if (keeping) {
    return (
      <form
        className="flex w-full flex-col items-stretch gap-1.5 py-1 text-left whitespace-normal"
        onSubmit={(e) => {
          e.preventDefault();
          run(`keep-no-${requestId}`, () => unwrap(api.POST("/v1/requests/{request_id}/keep-no", { ...path, body: { note: note.trim() } })));
        }}
      >
        <label htmlFor={fieldId} className="text-[13px] leading-4 font-semibold text-text2">
          Why keep the no
        </label>
        <input
          id={fieldId}
          autoFocus
          value={note}
          maxLength={2000}
          onChange={(e) => setNote(e.target.value)}
          onKeyDown={(e) => e.key === "Escape" && setKeeping(false)}
          className="h-8 w-full min-w-0 rounded-lg border border-line-strong bg-surface px-2 text-sm"
        />
        {errorLine}
        <span className="flex justify-end gap-1.5 max-[600px]:flex-col">
          <Button type="submit" disabled={busy !== null || !note.trim()} className="max-[600px]:w-full">
            Keep the no
          </Button>
          <Button variant="ghost" disabled={busy !== null} onClick={() => setKeeping(false)} className="max-[600px]:w-full">
            Cancel
          </Button>
        </span>
      </form>
    );
  }
  return (
    <>
      <Button disabled={busy !== null} aria-label={`Keep the no on ${title}`} onClick={() => setKeeping(true)}>
        Keep the no
      </Button>
      <Button
        disabled={busy !== null}
        onClick={() =>
          run(`reopen-${requestId}`, async () => {
            const request = await unwrap(api.GET("/v1/requests/{request_id}", path));
            return unwrap(api.POST("/v1/requests/{request_id}/reopen", { ...path, body: { lock_version: request.lock_version, reason: "Asked again since we said no" } }));
          })
        }
      >
        Reopen
      </Button>
      {errorLine}
    </>
  );
}

const ritualWhen = (iso: string) => formatInZone(iso, displayZone(), { weekday: "short", hour: "numeric", minute: "2-digit" });

/**
 * H2 ritual rows: Pre-read ready (the owner and attendees, until they open it), Record notes
 * (the ritual's owner, after the end) and Ritual failed to prepare (owners, with Retry). Each
 * opens the occurrence; a failed one opens Company › Rituals.
 */
export function ritualNeeds(inbox: InboxOut, busy: string | null, act: Act): StatedNeed[] {
  return (inbox.rituals ?? []).map((r) => {
    const label =
      r.reason === "pre_read"
        ? `Pre-read ready · ${r.title} · ${ritualWhen(r.due_at)}`
        : r.reason === "record_notes"
          ? `Record notes · ${r.title}`
          : `Ritual failed to prepare · ${r.title}`;
    return {
      key: `ritual-${r.reason}-${r.occurrence_id}`,
      icon: "company",
      kind: "Ritual",
      item: (
        <span className="truncate" title={label} data-testid="ritual-need">
          {label}
        </span>
      ),
      context: <span className="block truncate text-text2">Rituals</span>,
      at: r.due_at,
      action:
        r.reason === "failed" ? (
          <Button
            disabled={busy !== null}
            onClick={() => act(`ritual-retry-${r.ritual_id}`, () => unwrap(api.POST("/v1/rituals/{ritual_id}/prepare", { params: { path: { ritual_id: r.ritual_id } } })))}
          >
            Retry
          </Button>
        ) : (
          <LinkButton variant="secondary" href={`/company/rituals/${r.occurrence_id}`} aria-label="Open">
            Open
          </LinkButton>
        ),
      state: r.state,
      counted: r.counts,
      group: "rituals" as const,
    };
  });
}

/**
 * H5 metric rows, all counted: Explain a variance and Find out (the metric's owner; each
 * opens the metrics review that lists it) and Metric not read for a day (owners; opens the
 * metric). Days are calendar days of the Company time zone. New until the visit after: a row
 * is raised as its day begins in the Company time zone (Find out on its due day, the others
 * once the week has ended), compared with my previous visit as instants.
 */
export function metricNeeds(inbox: InboxOut, seenBefore: string | null | undefined): StatedNeed[] {
  return (inbox.metrics ?? []).map((r) => {
    const day = r.due_on ?? r.week_start;
    const raised = Date.parse(zoneInstant(r.due_on ?? addDays(r.week_start, 7), "00:00", displayZone()));
    const fresh = seenBefore !== undefined && (seenBefore === null || raised > Date.parse(seenBefore));
    const label =
      r.reason === "explain"
        ? `Explain a variance · ${r.metric_title} · week of ${calendarDay(r.week_start)}`
        : r.reason === "find_out"
          ? `Find out · ${r.metric_title} · due ${r.due_on ? calendarDay(r.due_on) : "now"}`
          : `Metric not read for a day · ${r.metric_title}`;
    const href = r.reason !== "pull_failed" && r.occurrence_id ? `/company/rituals/${r.occurrence_id}` : `/company/metrics?metric=${r.metric_id}`;
    return {
      key: `metric-${r.reason}-${r.variance_id ?? r.metric_id}`,
      icon: "flag",
      kind: "Metric",
      item: (
        <span className="truncate" title={label} data-testid="metric-need">
          {label}
        </span>
      ),
      context: <span className="block truncate text-text2">Company › Metrics</span>,
      at: day,
      atTip: calendarDay(day),
      action: (
        <LinkButton variant="secondary" href={href} aria-label="Open">
          Open
        </LinkButton>
      ),
      state: fresh ? ("new" as const) : ("open" as const),
      counted: r.counts,
      group: "metrics" as const,
    };
  });
}

/** H3 outcome rows: Add predictions (the roadmap's approver) and Outcome check due (the
 * record's owner) count; Oracle recorded (H11 at Act within limits) is shown, with Change. */
export function outcomeNeeds(inbox: InboxOut): { counted: Need[]; shown: Need[] } {
  const rows = inbox.outcomes ?? [];
  const need = (r: (typeof rows)[number]): Need => ({
    key: `outcome-${r.reason}-${r.id}`,
    icon: r.reason === "oracle_recorded" ? "check" : "flag",
    kind: r.reason === "needs_prediction" ? "Add predictions" : r.reason === "check_due" ? "Outcome check due" : "Oracle recorded",
    item: (
      <span className="truncate" title={r.title} data-testid="outcome-need">
        {r.title}
      </span>
    ),
    context: <span className="block truncate text-text2">Plan › Outcomes</span>,
    at: r.due_on,
    action: (
      <LinkButton variant="secondary" href={`/plan/outcomes?outcome=${r.id}`}>
        {r.reason === "oracle_recorded" ? "Change" : "Open"}
      </LinkButton>
    ),
  });
  return { counted: rows.filter((r) => r.counts).map(need), shown: rows.filter((r) => !r.counts).map(need) };
}

/**
 * Every row of the one Inbox, each in its state (owner, 2026-10-20): checkpoints, cost
 * approvals, overruns, stuck runs, couldn't-import, couldn't-revoke and access changes still failing (owners), access requests (owners and approvers), feedback items and the questions asked
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
  fixed?: FixedHere,
  /** A5: the access request rows (./_access), decided in place. */
  accessRequests: Need[] = [],
  /** What the signed-in person may do (usePerms): rows draw only those actions. */
  perms: Perms = ALL,
): StatedNeed[] {
  const n = inboxNeeds(inbox, busy, act, compact, fixed, perms, onActed);
  // A row may carry its own state and count (a question answered in place: ./_questions).
  const launches = launchNeeds(inbox);
  const requests = requestNeeds(inbox, busy, act);
  const outcomes = outcomeNeeds(inbox);
  const stated = (rows: Need[], group: NeedGroup, counted = true): StatedNeed[] =>
    rows.map((r) => ({
      ...r,
      state: (r.state as InboxState | undefined) ?? (isNew(r.at, seenBefore) ? "new" : "open"),
      counted: r.counted ?? counted,
      group: r.fyi ? "fyi" : group,
    }));
  return [
    ...stated(n.checkpoints, "checkpoints"),
    ...discussionNeeds(inbox, seenBefore),
    ...trackNeeds(inboxTracks(inbox), busy, act, seenBefore, compact),
    ...stated(n.approvals, "approvals"),
    ...stated(n.overruns, "overruns"),
    ...stated(n.lookups, "lookups"),
    ...stated(n.imports, "imports"),
    // A run that finished with no document: the same group, its draft not imported.
    ...stated(n.noDocuments, "imports"),
    ...stated(revokeNeeds(inbox.revoke_failures ?? [], busy, act), "revoke-failures"),
    ...stated(accessNeeds(inbox.access_failures ?? [], busy, act), "access-failures"),
    ...stated(shareRevocationNeeds(inbox.share_revocations ?? [], busy, act), "share-revocations"),
    ...stated(reportFailureNeeds(inbox.report_failures ?? [], busy, act), "report-failures"),
    ...reportNeeds(inbox.reports ?? [], seenBefore),
    ...stated(strategyNeeds(inbox.strategy), "strategy"),
    ...stated(dateNeeds(inbox, busy, act), "dates"),
    ...stated(launches.counted, "launches"),
    ...stated(requests.counted, "requests"),
    ...ritualNeeds(inbox, busy, act),
    ...metricNeeds(inbox, seenBefore),
    ...stated(outcomes.counted, "outcomes"),
    ...oracleActionNeeds(inbox.oracle_actions ?? [], busy, act, seenBefore),
    ...feedbackNeeds(inbox, seenBefore, onActed, compact, perms),
    ...decisionNeeds(inbox, busy, act, seenBefore),
    ...stated(accessRequests, "access-requests"),
    ...stated(asked, "questions"),
    // Shown only, under Open: nothing to decide, not an item.
    ...stated(n.deliveries, "deliveries", false).map((r) => ({ ...r, state: "open" as const })),
    ...stated(n.searches, "searches", false).map((r) => ({ ...r, state: "open" as const })),
    ...stated(n.revising, "revising", false).map((r) => ({ ...r, state: "open" as const })),
    ...stated(launches.shipped, "shipped", false),
    ...stated(requests.shown, "requests", false),
    ...stated(outcomes.shown, "outcomes", false).map((r) => ({ ...r, state: "open" as const })),
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
    // qa-onboarding-27: the decision by its title, never its bare code ("D-5").
    const label = `${DECISION_KIND[d.reason]} · ${d.title}`;
    return {
      key: `decision-${d.id}-${d.reason}`,
      icon: "company",
      kind: "Decision",
      item: (
        <span className="truncate" title={label}>
          {label}
        </span>
      ),
      context: <span className="block truncate">{d.review_at && d.reason === "review_due" ? `Review was due ${formatDate(d.review_at)}` : "Decision log"}</span>,
      at: d.since,
      action: (
        <>
          {live && d.reason === "needs_decision" && <LinkButton href={`${href}&act=decide`}>Decide</LinkButton>}
          {live && d.reason === "review_due" && (
            <Button
              aria-label={`Reaffirm ${d.title} for 90 more days`}
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
          <LinkButton href={href} aria-label={`Open ${d.title}`}>
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

// --- F2 Track health: one row per track, its open alerts under it -----------------------

const ALERT_KIND: Record<TrackAlertOut["kind"], string> = {
  date_slip: "Date slip",
  overdue: "Overdue",
  cancelled: "Cancelled",
  ahead: "Started early",
  unplanned: "Not on the roadmap",
  blocked: "Blocked",
  stale: "May be stale",
  prd_moved: "PRD moved on",
};

const alertTitle = (a: TrackAlertOut) => a.item_title ?? a.item_key ?? a.prd.title;

/**
 * F2: the Inbox's track rows. A track with open alerts is one row, "<PRD> · At risk · N need
 * you" with Open in Plan, and (on the Inbox, not Home) up to three alerts under it, each with
 * its first safe action and Open, then "+N more · N kept". Kept and resolved alerts are Done
 * rows, with the note they were kept with.
 */
export function trackNeeds(
  tracks: InboxTrack[],
  busy: string | null,
  act: Act,
  seenBefore: string | null | undefined,
  compact = false,
): StatedNeed[] {
  const out: StatedNeed[] = [];
  for (const t of tracks) {
    const need = t.counts.open + t.counts.new;
    if (need > 0) {
      const label = `${t.prd.title} · ${(t.health && HEALTH_WORD[t.health]) || "At risk"} · ${need} need you`;
      const kinds = [...new Set(t.alerts.map((a) => ALERT_KIND[a.kind]))].join(", ");
      const children: Need[] = t.alerts.map((a) => ({
        key: `track-alert-${a.id}`,
        icon: "flag",
        kind: "Track alert",
        item: (
          <>
            <span className="truncate" data-testid="child-title" title={alertTitle(a)}>
              {alertTitle(a)}
            </span>
            <Chip kind="warn">{ALERT_KIND[a.kind]}</Chip>
          </>
        ),
        context: (
          <span className="block truncate text-[14px] text-text2" title={alertSentence(a)} data-testid="track-alert-detail">
            {alertSentence(a)}
          </span>
        ),
        action: <TrackAlertActions key={`${a.id}-${a.state}`} a={a} busy={busy} act={act} />,
      }));
      if (t.more > 0 || t.counts.kept > 0) {
        children.push({
          key: `track-${t.track_id}-more`,
          icon: "flag",
          kind: "Track alert",
          item: (
            <Link href="/plan" className="truncate text-[14px] hover:underline" data-testid="child-more">
              {[t.more > 0 ? `+${t.more} more` : null, t.counts.kept > 0 ? `${t.counts.kept} kept` : null].filter(Boolean).join(" · ")}
            </Link>
          ),
          context: null,
          action: null,
        });
      }
      out.push({
        key: `track-${t.track_id}`,
        icon: "roadmap",
        kind: "Track",
        item: (
          <span className="truncate" data-testid="track-label" title={label}>
            {label}
          </span>
        ),
        context: (
          <span className="block truncate" title={kinds}>
            {kinds}
          </span>
        ),
        at: t.newest_at,
        action: (
          <LinkButton href={t.alerts[0] ? planHref(t.alerts[0]) : "/plan"} aria-label={`Open ${t.prd.title} in Plan`}>
            Open in Plan
          </LinkButton>
        ),
        // What was new on arrival stays New this visit, as the other rows.
        state: (seenBefore === undefined ? t.counts.new > 0 : t.alerts.some((a) => isNew(a.opened_at, seenBefore))) ? "new" : "open",
        counted: true,
        group: "tracks",
        children: compact ? undefined : children,
      });
    }
    for (const a of t.done) {
      const outcome = a.state === "kept" ? (a.note ? `Kept · ${a.note}` : "Kept") : "Resolved";
      out.push({
        key: `track-alert-${a.id}`,
        icon: "check",
        kind: "Track",
        item: (
          <>
            <span className="truncate" title={alertSentence(a)}>
              {alertTitle(a)} · {alertSentence(a)}
            </span>
            <span className="flex-none truncate text-[14px] text-text2" data-testid="track-alert-outcome" title={outcome}>
              {outcome}
            </span>
          </>
        ),
        context: <span className="block truncate">{a.prd.title}</span>,
        at: a.kept_at ?? a.resolved_at ?? a.opened_at,
        action: (
          <span data-child-actions className="inline-flex flex-wrap items-center justify-end gap-1.5 max-[600px]:w-full max-[600px]:[&>*]:w-full">
            {a.actions.includes("reopen") && (
              <Button
                disabled={busy !== null}
                aria-label={`Reopen ${alertTitle(a)}`}
                onClick={() => act(`reopen-${a.id}`, () => reopenTrackAlert(a.id))}
              >
                Reopen
              </Button>
            )}
            <LinkButton variant={a.actions.includes("reopen") ? "ghost" : "secondary"} href={planHref(a)} aria-label={`Open ${alertTitle(a)}`}>
              Open
            </LinkButton>
          </span>
        ),
        state: "done",
        counted: true,
        group: "tracks",
      });
    }
  }
  return out;
}

/** A track alert's first safe action (Accept new date, Review or Keep watching, with an optional note) and Open. */
function TrackAlertActions({ a, busy, act }: { a: TrackAlertOut; busy: string | null; act: Act }) {
  const [keeping, setKeeping] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const fieldId = useId();
  const title = alertTitle(a);
  const first = firstSafeAction(a);
  const run = (key: string, call: () => Promise<unknown>) => {
    setError(null);
    void act(key, () => call().catch((e) => setError(errorMessage(e))));
  };
  const errorLine = error && (
    <span role="alert" className="basis-full text-right text-[13px] text-crit max-[600px]:text-left" data-testid="child-error">
      {error}
    </span>
  );
  if (keeping) {
    return (
      <form
        data-child-actions
        data-testid="track-keep-field"
        className="flex w-full flex-col items-stretch gap-1.5 py-1 text-left whitespace-normal"
        onSubmit={(e) => {
          e.preventDefault();
          run(`keep-${a.id}`, () => keepTrackAlert(a.id, note.trim() || null));
        }}
      >
        <label htmlFor={fieldId} className="text-[13px] leading-4 font-semibold text-text2">
          Note (optional)
        </label>
        <input
          id={fieldId}
          autoFocus
          value={note}
          maxLength={500}
          onChange={(e) => setNote(e.target.value)}
          onKeyDown={(e) => e.key === "Escape" && setKeeping(false)}
          className="h-8 w-full min-w-0 rounded-lg border border-line-strong bg-surface px-2 text-sm"
        />
        {errorLine}
        <span className="flex justify-end gap-1.5 max-[600px]:flex-col">
          <Button type="submit" disabled={busy !== null} className="max-[600px]:w-full">
            Keep watching
          </Button>
          <Button variant="ghost" disabled={busy !== null} onClick={() => setKeeping(false)} className="max-[600px]:w-full">
            Cancel
          </Button>
        </span>
      </form>
    );
  }
  return (
    <span data-child-actions className="inline-flex flex-wrap items-center justify-end gap-1.5 max-[600px]:w-full max-[600px]:[&>*]:w-full">
      {first === "accept_date" && (
        <Button
          disabled={busy !== null}
          aria-label={`Accept new date for ${title}`}
          onClick={() => run(`accept-${a.id}`, () => acceptTrackAlertDate(a.id))}
        >
          Accept new date
        </Button>
      )}
      {first === "review" && <LinkButton href={planHref(a)}>Review</LinkButton>}
      {first === "keep" && (
        <Button disabled={busy !== null} aria-label={`Keep watching ${title}`} onClick={() => setKeeping(true)}>
          Keep watching
        </Button>
      )}
      {first !== "keep" && a.actions.includes("keep") && (
        <Button variant="ghost" disabled={busy !== null} aria-label={`Keep watching ${title}`} onClick={() => setKeeping(true)}>
          Keep watching
        </Button>
      )}
      <LinkButton variant="ghost" href={planHref(a)} aria-label={`Open ${title}`}>
        Open
      </LinkButton>
      {errorLine}
    </span>
  );
}
