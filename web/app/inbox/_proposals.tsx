"use client";

import Link from "next/link";

import { Button, Chip, InfoTip, LinkButton } from "@/components/ds";
import { api, unwrap, type Schemas } from "@/lib/api/client";
import { useItemCode } from "@/components/simple/WaitingItems";
import { calendarDay } from "@/lib/dates";
import { formatDateRange, formatDateTime } from "@/lib/format";

import { isNew, type Act, type StatedNeed } from "./_needs";

type Proposal = Schemas["InboxSimpleChange"];
type DateSuggestion = Schemas["InboxSimpleDateSuggestion"];
type GoalSuggestion = Schemas["InboxSimpleGoalSuggestion"];
type Approval = Schemas["InboxSimpleApproval"];
type TrackSuggestion = Schemas["InboxSimpleTrackSuggestion"];

/** The item's feature panel on its roadmap (Simple's one panel for a feature). */
const panelHref = (documentId: string, itemId: string) => `/simple/roadmap?roadmap=${documentId}&item=${itemId}`;

/** The feature's name, opening its feature panel when it is on a roadmap. */
function FeatureName({ name, itemId, documentId }: { name: string; itemId?: string | null; documentId?: string | null }) {
  // simple-home-qa-nov12 #4: the item's code before its name, as its panel reads it.
  const code = useItemCode(itemId);
  const chip = code && <code className="simple-code mr-1">{code}</code>;
  if (!itemId || !documentId)
    return (
      <span className="min-w-0 truncate" title={name}>
        {chip}
        {name}
      </span>
    );
  return (
    <Link href={panelHref(documentId, itemId)} className="min-w-0 truncate font-medium text-accent-ink underline-offset-2 hover:underline" title={`Open ${name}'s panel`} data-testid="feature-name">
      {chip}
      {name}
    </Link>
  );
}

/** A PRD question's proposal (an answer, or who decides it): decided on Decisions. */
const onQuestion = (p: Pick<Proposal, "op">) => p.op === "decide_question" || p.op === "name_decider";

/** A feature ask on no roadmap: no page shows it until it is filed, so its Inbox row decides it (no Open). */
const askOnly = (p: Pick<Proposal, "op" | "document_id">) => p.op === "add_feature_ask" && !p.document_id;

/** A change to a one-pager: a line's wording, or a number fix in a PRD section (set_section_number). */
const onOnePager = (p: Pick<Proposal, "op">) => p.op === "edit_line" || p.op === "set_section_number";

/**
 * Where a proposal is decided: a PRD question's on Decisions, at that question; a one-pager
 * wording's on its one-pager, at that line, a number fix's at the PRD section it changes; else
 * its roadmap's Needs a decision when it has one; else Priorities (a priority or an estimate).
 * A feature ask on no roadmap has none.
 */
export function proposalHref(p: Pick<Proposal, "op" | "document_id" | "item_id" | "question_id" | "line_id" | "section">): string | null {
  if (onQuestion(p) && p.document_id) return `/simple/decisions?prd=${p.document_id}${p.question_id ? `&question=${p.question_id}` : ""}`;
  if (p.op === "edit_line" && p.document_id) return `/simple/one-pagers/${p.document_id}${p.line_id ? `?line=${encodeURIComponent(p.line_id)}` : ""}`;
  if (p.op === "set_section_number" && p.document_id) return `/simple/one-pagers/${p.document_id}${p.section ? `?section=${encodeURIComponent(p.section)}` : ""}`;
  if (p.document_id) return `/simple/roadmap?roadmap=${p.document_id}&review=proposals`;
  if (askOnly(p)) return null;
  return p.item_id ? `/simple/priorities?show=${p.item_id}` : "/simple/priorities";
}

/** Where a proposal is decided, in words, for Open's label. */
const proposalWhere = (p: Proposal): string => (onQuestion(p) ? "in Decisions" : onOnePager(p) ? "on its one-pager" : p.document_id ? "on its roadmap" : "in Priorities");

/** What the row is on: its item, else its question (code and title), one-pager line or section number ("Section number on Guided setup: Use 6"). */
const proposalName = (p: Proposal): string =>
  p.item_title ??
  (p.subject ? (p.op === "edit_line" ? `“${p.subject}”` : p.subject) : onQuestion(p) ? "A question" : p.op === "edit_line" ? "A one-pager line" : p.op === "set_section_number" ? "A section number" : "An item");

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
              {/* Below its chip: over neither its own date line nor the row above's Open. */}
              <InfoTip label="Far out" align="start" side="bottom" testId="date-suggestion-far-out-tip">
                Low confidence, after the planning horizon ({calendarDay(PLANNING_HORIZON_END, { month: "short", day: "numeric", year: "numeric" })})
              </InfoTip>
            </>
          )}
        </span>
      </>
    ),
    // simple-home-qa-nov12 #6: on a phone the why sits behind its (i), not printed on every row.
    context: (
      <>
        <span className="block truncate text-text2 max-[600px]:hidden" data-testid="date-suggestion-basis">
          {s.basis}
        </span>
        <span className="min-[601px]:hidden">
          <InfoTip label={`Why these dates for ${s.item_title}`} align="start" testId="date-suggestion-basis-tip">
            {s.basis}
          </InfoTip>
        </span>
      </>
    ),
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

/** tracks-goal: a change to a track, through the change engine (a decider applies it; one who is not proposes it). */
const trackChange = (body: Record<string, unknown>) => unwrap(api.POST("/v1/simple/changes", { body: { before: {}, ...body } as Schemas["SimpleChangeIn"] }));

/**
 * tracks-goal (owner Nov 9): a newly accepted PRD of mine on no track (the API's
 * `simple_track_suggestions`). Oracle suggests the track that fits it best: Confirm puts the PRD
 * on it, Pick a track on another, New track starts one by the PRD's name. Until then its
 * features show in the Roadmap's No track band.
 */
export function trackSuggestionRows(rows: TrackSuggestion[], busy: string | null, act: Act, seenBefore: string | null | undefined): StatedNeed[] {
  return rows.map((s) => {
    const onto = (trackId: string) => act(`track-suggestion-${s.id}`, () => trackChange({ op: "edit_track", target: { track_id: trackId }, after: { add_prd_id: s.prd.id } }));
    const others = s.tracks.filter((t) => t.id !== s.track?.id);
    // Asked of a track someone else decides: it waits for them (no actions, not counted) until
    // they accept (it leaves) or decline (the suggestion is back).
    const asked = s.proposed;
    return {
      key: `track-suggestion-${s.id}`,
      icon: "roadmap",
      kind: "Track",
      item: (
        <>
          <span className="min-w-0 truncate" title={s.prd.title} data-testid="track-suggestion-title">
            {s.prd.title}
          </span>
          {asked ? (
            <span className="block basis-full" data-testid="track-suggestion-proposed" title={`Asked to put ${s.prd.title} on ${asked.track?.title ?? asked.title}`}>
              <Chip>{asked.to_name ? `Proposed to ${asked.to_name}` : "Proposed"}</Chip>
            </span>
          ) : (
            <span className="block basis-full text-sm break-words whitespace-normal text-text2" data-testid="track-suggestion-context">
              {s.track ? `Oracle suggests the track ${s.track.title}` : "On no track"}
            </span>
          )}
        </>
      ),
      context: <span className="block truncate text-text2">Its features show under No track</span>,
      at: s.at,
      state: isNew(s.at, seenBefore) ? "new" : "open",
      counted: !asked,
      group: "proposals",
      action: asked ? null : (
        <>
          {s.track && (
            <Button disabled={busy !== null} onClick={() => onto(s.track!.id)} aria-label={`Put ${s.prd.title} on ${s.track.title}`}>
              Confirm
            </Button>
          )}
          {others.length > 0 && (
            <select
              aria-label={`Pick a track for ${s.prd.title}`}
              disabled={busy !== null}
              value=""
              onChange={(e) => e.target.value && void onto(e.target.value)}
              className="h-8 rounded-lg border border-line bg-surface px-2 text-sm"
            >
              <option value="">Pick a track</option>
              {others.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.title}
                </option>
              ))}
            </select>
          )}
          <Button variant="ghost" disabled={busy !== null} onClick={() => act(`track-suggestion-${s.id}`, () => trackChange({ op: "add_track", target: {}, after: { title: s.prd.title, prd_ids: [s.prd.id] } }))}>
            New track
          </Button>
        </>
      ),
    };
  });
}

/**
 * Simple S3b, inbox-meeting-proposals fix: roadmap versions from Simple drafts waiting for my
 * approval as a required reviewer (the API's `simple_approvals`): the roadmap by name, the
 * version, who sent it and when; Open goes to the roadmap at that draft (?draft=<id>, which the
 * roadmap reads to bring its banner into sight), whose Approve approves it. A PRD's draft
 * (inbox-prd-approval-open) opens on its one-pager, whose working-draft banner has Approve.
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
        <LinkButton
          href={a.document_kind === "prd" ? `/simple/one-pagers/${encodeURIComponent(a.document.slug)}?draft=${a.draft_id}` : `/simple/roadmap?roadmap=${a.document.id}&draft=${a.draft_id}`}
          aria-label={`Open ${what} to approve it`}
        >
          Open
        </LinkButton>
      ),
    };
  });
}
