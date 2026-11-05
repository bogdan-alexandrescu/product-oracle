"use client";

import Link from "next/link";

import { Button, Chip, InfoTip, LinkButton } from "@/components/ds";
import { api, unwrap, type Schemas } from "@/lib/api/client";
import { calendarDay } from "@/lib/dates";
import { formatDateRange, formatDateTime } from "@/lib/format";

import { isNew, type Act, type StatedNeed } from "./_needs";

type Proposal = Schemas["InboxSimpleChange"];
type DateSuggestion = Schemas["InboxSimpleDateSuggestion"];
type GoalSuggestion = Schemas["InboxSimpleGoalSuggestion"];
type Approval = Schemas["InboxSimpleApproval"];

/** The item's feature panel on its roadmap (Simple's one panel for a feature). */
const panelHref = (documentId: string, itemId: string) => `/simple/roadmap?roadmap=${documentId}&item=${itemId}`;

/** The feature's name, opening its feature panel when it is on a roadmap. */
function FeatureName({ name, itemId, documentId }: { name: string; itemId?: string | null; documentId?: string | null }) {
  if (!itemId || !documentId)
    return (
      <span className="min-w-0 truncate" title={name}>
        {name}
      </span>
    );
  return (
    <Link href={panelHref(documentId, itemId)} className="min-w-0 truncate font-medium text-accent-ink underline-offset-2 hover:underline" title={`Open ${name}'s panel`} data-testid="feature-name">
      {name}
    </Link>
  );
}

/** A PRD question's proposal (an answer, or who decides it): decided on Decisions. */
const onQuestion = (p: Pick<Proposal, "op">) => p.op === "decide_question" || p.op === "name_decider";

/** A feature ask on no roadmap: no page shows it until it is filed, so its Inbox row decides it (no Open). */
const askOnly = (p: Pick<Proposal, "op" | "document_id">) => p.op === "add_feature_ask" && !p.document_id;

/**
 * Where a proposal is decided: a PRD question's on Decisions, at that question; a one-pager
 * wording's on its one-pager, at that line; else its roadmap's Needs a decision when it has
 * one; else Priorities (a priority or an estimate). A feature ask on no roadmap has none.
 */
export function proposalHref(p: Pick<Proposal, "op" | "document_id" | "item_id" | "question_id" | "line_id">): string | null {
  if (onQuestion(p) && p.document_id) return `/simple/decisions?prd=${p.document_id}${p.question_id ? `&question=${p.question_id}` : ""}`;
  if (p.op === "edit_line" && p.document_id) return `/simple/one-pagers/${p.document_id}${p.line_id ? `?line=${encodeURIComponent(p.line_id)}` : ""}`;
  if (p.document_id) return `/simple/roadmap?roadmap=${p.document_id}&review=proposals`;
  if (askOnly(p)) return null;
  return p.item_id ? `/simple/priorities?show=${p.item_id}` : "/simple/priorities";
}

/** Where a proposal is decided, in words, for Open's label. */
const proposalWhere = (p: Proposal): string => (onQuestion(p) ? "in Decisions" : p.op === "edit_line" ? "on its one-pager" : p.document_id ? "on its roadmap" : "in Priorities");

/** What the row is on: its item, else its question (code and title) or one-pager line. */
const proposalName = (p: Proposal): string => p.item_title ?? (p.subject ? (p.op === "edit_line" ? `“${p.subject}”` : p.subject) : onQuestion(p) ? "A question" : p.op === "edit_line" ? "A one-pager line" : "An item");

const upper = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/** Who or what asked for it: a meeting by its name, Ask Oracle for a teammate, or the teammate. */
function askedBy(p: Proposal): string {
  if (p.from_meeting) return `asked for by the meeting ${p.from_meeting.title}`;
  if (p.from_ask) return `asked through Ask Oracle by ${p.by_name}`;
  return `asked for by ${p.by_name}`;
}

/**
 * inbox-meeting-proposals: every Simple proposal waiting on me (the API's `simple_proposals`):
 * one a meeting asked for on an item it does not review, one asked through Ask Oracle, one a
 * teammate made on the page. Each says the item by its name, what was asked in plain words, who
 * or what asked and when. Accept applies it as Needs a decision does, Decline leaves the item;
 * either way the row leaves the Inbox. Only someone who may decide it (its `can_decide`) gets
 * the buttons.
 */
export function proposalRows(proposals: Proposal[], busy: string | null, act: Act, seenBefore: string | null | undefined): StatedNeed[] {
  return proposals
    .map((p) => {
      const name = proposalName(p);
      const path = { params: { path: { change_id: p.id } }, body: {} };
      // The banner's words follow the row's kind (app/inbox/page.tsx ACTED).
      const words = onQuestion(p) ? "question-" : askOnly(p) ? "ask-" : "";
      const href = proposalHref(p);
      return {
        key: `proposal-${p.id}`,
        icon: "roadmap",
        kind: "Proposal",
        // The item cell keeps its room (it wraps): what was asked, by whom or what and when, under the name.
        item: (
          <>
            <FeatureName name={name} itemId={p.item_id} documentId={p.document_id} />
            <span className="block basis-full text-sm break-words whitespace-normal text-text2" data-testid="meeting-proposal-context">
              {upper(p.asked ?? "a change")} · {askedBy(p)} on {formatDateTime(p.at)}
            </span>
          </>
        ),
        context: <span className="block truncate text-text2">{p.from_meeting ? "Not on that meeting's agenda" : p.reason?.trim() || "Waiting for your decision"}</span>,
        at: p.at,
        state: isNew(p.at, seenBefore) ? "new" : "open",
        counted: true,
        group: "proposals",
        action: (
          <>
            {p.can_decide && (
              <>
                <Button disabled={busy !== null} onClick={() => act(`proposal-accept-${words}${p.id}`, () => unwrap(api.POST("/v1/simple/changes/{change_id}/accept", path)))}>
                  Accept
                </Button>
                <Button variant="ghost" disabled={busy !== null} onClick={() => act(`proposal-decline-${words}${p.id}`, () => unwrap(api.POST("/v1/simple/changes/{change_id}/decline", path)))}>
                  Decline
                </Button>
              </>
            )}
            {href && (
              <LinkButton href={href} aria-label={`Open ${name} ${proposalWhere(p)}`}>
                Open
              </LinkButton>
            )}
          </>
        ),
      };
    });
}

/**
 * inbox-meeting-proposals fix: Oracle's open date suggestions I may decide (the API's
 * `simple_date_suggestions`), one row per item: its name (opening its feature panel), the
 * dates and why; Open goes to the item on its roadmap with the suggestion open, where it is
 * accepted, edited or dismissed.
 */
/**
 * B-15: the planning horizon's last day, by the owner's rule (no roadmap states its own end).
 * A suggested date after it is a long guess: it carries a Far out chip.
 */
// A roadmap's own horizon end replaces this once the API carries one.
export const PLANNING_HORIZON_END = "2027-02-28";

export function dateSuggestionRows(rows: DateSuggestion[], seenBefore: string | null | undefined): StatedNeed[] {
  return rows.map((s) => ({
    key: `date-suggestion-${s.id}`,
    icon: "clock",
    kind: "Dates",
    item: (
      <>
        <FeatureName name={s.item_title} itemId={s.item_id} documentId={s.document_id} />
        <span className="block basis-full text-sm break-words whitespace-normal text-text2" data-testid="date-suggestion-context">
          Oracle suggests {formatDateRange(s.start_date, s.end_date)}
          {s.end_date > PLANNING_HORIZON_END && (
            <>
              {" "}
              <Chip kind="warn" className="align-middle" data-testid="date-suggestion-far-out">
                Far out
              </Chip>{" "}
              <InfoTip label="Far out" align="start" testId="date-suggestion-far-out-tip">
                Low confidence, after the planning horizon ({calendarDay(PLANNING_HORIZON_END, { month: "short", day: "numeric", year: "numeric" })})
              </InfoTip>
            </>
          )}
        </span>
      </>
    ),
    context: <span className="block truncate text-text2">{s.basis}</span>,
    at: s.at,
    state: isNew(s.at, seenBefore) ? "new" : "open",
    counted: true,
    group: "proposals",
    action: (
      <LinkButton href={`/simple/roadmap?roadmap=${s.document_id}&dates=${s.item_id}`} aria-label={`Open Oracle's dates for ${s.item_title}`}>
        Open
      </LinkButton>
    ),
  }));
}

/**
 * inbox-meeting-proposals fix: the open features suggested for goals whose suggestions I
 * decide (the API's `simple_goal_suggestions`): the feature and its goal, who suggested it;
 * Open goes to the goal's suggestions, where it is accepted or rejected.
 */
export function goalSuggestionRows(rows: GoalSuggestion[], seenBefore: string | null | undefined): StatedNeed[] {
  return rows.map((s) => {
    const where = `/simple/roadmap?${s.document_id ? `roadmap=${s.document_id}&` : ""}suggestions=${s.goal.id}`;
    return {
      key: `goal-suggestion-${s.id}`,
      icon: "flag",
      kind: "Suggestion",
      item: (
        <>
          <span className="min-w-0 truncate" title={s.title} data-testid="goal-suggestion-title">
            {s.title}
          </span>
          <span className="block basis-full text-sm break-words whitespace-normal text-text2" data-testid="goal-suggestion-context">
            {s.from_oracle ? "Oracle suggests it" : `${s.proposed_by_name ?? "A teammate"} suggests it`} for the goal {s.goal.title} on {formatDateTime(s.at)}
          </span>
        </>
      ),
      context: <span className="block truncate text-text2">{s.outcome || "Waiting for your decision"}</span>,
      at: s.at,
      state: isNew(s.at, seenBefore) ? "new" : "open",
      counted: true,
      group: "proposals",
      action: (
        <LinkButton href={where} aria-label={`Open the suggestions for ${s.goal.title}`}>
          Open
        </LinkButton>
      ),
    };
  });
}

/**
 * Simple S3b, inbox-meeting-proposals fix: roadmap versions from Simple drafts waiting for my
 * approval as a required reviewer (the API's `simple_approvals`): the roadmap by name, the
 * version, who sent it and when; Open goes to the roadmap at that draft (?draft=<id>, which the
 * roadmap reads to bring its banner into sight), whose Approve approves it.
 */
export function approvalRows(rows: Approval[], seenBefore: string | null | undefined): StatedNeed[] {
  return rows.map((a) => {
    const what = `${a.document.title}${a.version ? ` version ${a.version}` : ""}`;
    return {
      key: `simple-approval-${a.draft_id}`,
      icon: "roadmap",
      kind: "Approval",
      item: (
        <>
          <span className="min-w-0 truncate" title={what}>
            {what}
          </span>
          <span className="block basis-full text-sm break-words whitespace-normal text-text2" data-testid="simple-approval-context">
            Sent for review by {a.submitted_by_name ?? "a teammate"}
            {a.submitted_at ? ` on ${formatDateTime(a.submitted_at)}` : ""}
          </span>
        </>
      ),
      context: <span className="block truncate text-text2">{a.decider_approved ? "The decider approved it: waiting for you" : "Waiting for your approval"}</span>,
      at: a.submitted_at,
      state: isNew(a.submitted_at, seenBefore) ? "new" : "open",
      counted: true,
      // An approval: listed and counted with approvals (Home's Approvals), not with proposals.
      group: "roadmap-approvals",
      action: (
        <LinkButton href={`/simple/roadmap?roadmap=${a.document.id}&draft=${a.draft_id}`} aria-label={`Open ${what} to approve it`}>
          Open
        </LinkButton>
      ),
    };
  });
}
