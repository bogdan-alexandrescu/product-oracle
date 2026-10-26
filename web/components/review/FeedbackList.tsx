"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

import { AgentStagedNote, FromQuestionLink, SectionLink, StageForAgents, TriageActions, type GoTo } from "@/components/FeedbackPanel";
import {
  SuggestionActions,
  SuggestionCard,
  SuggestionForm,
  useSuggestionDecision,
  type SuggestionDecision as SuggestionDecisionState,
} from "@/components/SuggestionCard";
import { DiscussionList, type DiscussionRow } from "@/components/discuss/DiscussionList";
import { Avatar, Button, Chip, Empty, FilterChips, type ChipKind } from "@/components/ds";
import { LayerChip, Quote, SELECT, TEXTAREA, VerdictChip } from "@/components/review/parts";
import { ErrorNote } from "@/components/ui";
import type { CommentOut, Suggestion } from "@/lib/api/client";
import {
  FEEDBACK_KIND_LABEL,
  FEEDBACK_KINDS,
  FEEDBACK_STATE_LABEL,
  FEEDBACK_STATES,
  GENERAL_FEEDBACK_MAX,
  isGeneralFeedback,
  type FeedbackEntry,
  type FeedbackKind,
  type FeedbackState,
} from "@/lib/feedback";
import { formatDateTime } from "@/lib/format";

/** A comment thread placed in its section: the heading, and whether its quote was found. */
export type PlacedComment = CommentOut & { heading: string; anchored: boolean };

export type FeedbackScope = "auto" | "section" | "all" | "general";
export type FeedbackFilters = { state: FeedbackState; scope: FeedbackScope; kind: FeedbackKind | "all" };
export const DEFAULT_FILTERS: FeedbackFilters = { state: "open", scope: "auto", kind: "all" };

const STATE_KIND: Record<FeedbackState, ChipKind> = { open: "acc", staged: "warn", declined: "na", done: "pass" };
const KIND_LABEL: Record<FeedbackKind, string> = { comment: "Comment", suggestion: "Suggestion", review: "Review", discussion: "Discussion" };

type Ctx = {
  doc: string;
  n: number;
  headings: ReadonlyMap<string, string>;
  placed: ReadonlyMap<string, PlacedComment>;
  activeId: string | null;
  readOnly: boolean;
  canComment: boolean;
  canDecide: boolean;
  /**
   * The role's capabilities have answered (or failed): until then canDecide is not known, and
   * no Resolve is offered, as the author's would resolve only the thread, not the item.
   */
  rolesReady: boolean;
  userId: string | null;
  showLayer: boolean;
  /** Section links open here (the full document when the brief hides them). */
  goTo: GoTo;
  onShowComment: (c: PlacedComment) => void;
  onReply: (id: string, body: string) => Promise<void>;
  onResolve: (id: string, resolved: boolean) => Promise<void>;
  /** A decision on a suggestion: the item stays in view in its new state. */
  onChanged: (id: string) => void;
  /** Resolve / Reopen: the item leaves a list it no longer belongs to. */
  onTriaged?: () => void;
};

function ReplyForm({ onReply, onClose }: { onReply: (body: string) => Promise<void>; onClose: () => void }) {
  const [body, setBody] = useState("");
  const [saving, setSaving] = useState(false);
  const submit = async () => {
    if (!body.trim()) return;
    setSaving(true);
    try {
      await onReply(body.trim());
      setBody("");
      onClose();
    } finally {
      setSaving(false);
    }
  };
  return (
    <form
      className="mt-2 flex w-full flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <textarea
        autoFocus
        aria-label="Reply"
        rows={2}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void submit();
          if (e.key === "Escape") onClose();
        }}
        className={TEXTAREA}
      />
      <div className="flex gap-2">
        <Button type="submit" variant="solid" disabled={saving || !body.trim()}>
          Reply
        </Button>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/** Feedback on the whole draft (D13): a remark that belongs to no one section. */
function GeneralForm({ onAdd, onClose }: { onAdd: (body: string) => Promise<void>; onClose: () => void }) {
  const [body, setBody] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const text = body.trim();
  const submit = async () => {
    if (!text || text.length > GENERAL_FEEDBACK_MAX) return;
    setSaving(true);
    setError(null);
    try {
      await onAdd(text);
      setBody("");
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not add the feedback");
    } finally {
      setSaving(false);
    }
  };
  return (
    <form
      data-testid="general-feedback-form"
      className="flex w-full flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <textarea
        autoFocus
        aria-label="Comment on the whole draft"
        placeholder="Feedback on the whole draft, not one section"
        rows={3}
        maxLength={GENERAL_FEEDBACK_MAX}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void submit();
          if (e.key === "Escape") onClose();
        }}
        className={TEXTAREA}
      />
      {error && <ErrorNote>{error}</ErrorNote>}
      <div className="flex gap-2">
        <Button type="submit" variant="solid" disabled={saving || !text}>
          Add
        </Button>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/** The approver's decision on an open suggestion (ffb19 lane: SuggestionActions / SuggestionForm). */
function SuggestionDecision({
  s,
  onChanged,
  children,
}: {
  s: Suggestion;
  onChanged: () => void;
  children: (d: SuggestionDecisionState) => ReactNode;
}) {
  const d = useSuggestionDecision(s, onChanged);
  return <>{children(d)}</>;
}

/**
 * One feedback item: its section link and chips, then its actions (Accept / Edit and accept /
 * Dismiss for an open suggestion; Reply and Resolve / Reopen for the rest), then what was said.
 */
function FeedbackCard({ entry, ctx }: { entry: FeedbackEntry; ctx: Ctx }) {
  const { item, comment, kind, state } = entry;
  const [replying, setReplying] = useState(false);
  const placed = comment ? ctx.placed.get(comment.id) : undefined;
  const mine = !!comment && ctx.userId !== null && comment.author_id === ctx.userId;
  const general = isGeneralFeedback(item);
  const generalMine = general && ctx.userId !== null && item.author_id === ctx.userId;
  const live = !ctx.readOnly;
  const onChanged = () => ctx.onChanged(item.id);
  const openSuggestion = !!item.suggestion && item.suggestion.status === "open" && item.status === "open";

  const card = (d: SuggestionDecisionState | null) => {
    const deciding = !!d && ctx.canDecide && live;
    // An approver resolves or reopens any item (the item and its thread); a comment's author
    // resolves their own thread.
    const triage =
      live && ctx.rolesReady && !(deciding && openSuggestion) ? (
        ctx.canDecide ? (
          <TriageActions item={item} onChanged={ctx.onTriaged ?? onChanged} />
        ) : mine && comment ? (
          <Button variant="solid" icon="check" onClick={() => void ctx.onResolve(comment.id, !comment.resolved_at)}>
            {comment.resolved_at ? "Reopen" : "Resolve"}
          </Button>
        ) : null
      ) : null;
    // An open suggestion shows only its own actions; the thread's come back once it is decided.
    const reply =
      comment && live && ctx.canComment && !replying && !(deciding && openSuggestion) ? (
        <Button variant="ghost" icon="comment" onClick={() => setReplying(true)}>
          Reply
        </Button>
      ) : null;
    // D12: an open answer (no section text to accept) can go to the agents instead.
    const actions =
      deciding && openSuggestion ? (
        <>
          <SuggestionActions d={d!} />
          <StageForAgents item={item} onChanged={onChanged} />
        </>
      ) : null;
    const hasActions = !!(actions || triage || reply);
    return (
      <li
        data-testid="feedback-item"
        data-kind={kind}
        data-state={state}
        data-status={item.status}
        data-feedback-id={item.id}
        data-comment-id={comment?.id}
        className={`scroll-mt-16 border-b border-line py-3 last:border-b-0 ${
          comment && comment.id === ctx.activeId ? "-mx-5 bg-accent-soft px-5 shadow-[inset_4px_0_0_var(--accent)] max-[600px]:-mx-4 max-[600px]:px-4" : ""
        }`}
      >
        <div className="flex flex-wrap items-center gap-1.5" data-testid="feedback-head">
          {item.section_key && <SectionLink item={item} doc={ctx.doc} current={ctx.n} goTo={ctx.goTo} />}
          {/* Raised on an earlier version whose section this one no longer has: counted in the head, shown here. */}
          {item.section_key && !ctx.headings.has(item.section_key) && (
            <Chip kind="warn" data-testid="feedback-section-removed">
              Section removed
            </Chip>
          )}
          {general && (
            <Chip kind="line" data-testid="feedback-general-chip">
              General
            </Chip>
          )}
          {!(general && kind === "comment") && <Chip kind="line">{KIND_LABEL[kind]}</Chip>}
          {item.verdict && <VerdictChip verdict={item.verdict} />}
          <Chip kind={STATE_KIND[state]} data-testid="feedback-state-chip">
            {FEEDBACK_STATE_LABEL[state]}
          </Chip>
        </div>
        {hasActions && (
          <div className="mt-2 flex flex-wrap items-center gap-1.5" data-testid="feedback-actions">
            {actions}
            {triage}
            {reply}
          </div>
        )}
        {deciding && openSuggestion && <SuggestionForm d={d!} />}
        {replying && comment && <ReplyForm onReply={(b) => ctx.onReply(comment.id, b)} onClose={() => setReplying(false)} />}

        {comment ? (
          <div data-testid="comment" data-comment-id={comment.id} className={`mt-2 flex items-start gap-2.5 ${comment.resolved_at ? "opacity-80" : ""}`}>
            <Avatar name={mine ? "You" : "Reviewer"} initials={mine ? "Me" : "R"} tone={mine ? "me" : "default"} />
            <div className="min-w-0 flex-1">
              {placed && (
                <button
                  type="button"
                  className="block w-full text-left"
                  onClick={() => ctx.onShowComment(placed)}
                  aria-label={`Show comment in ${placed.heading}`}
                >
                  {ctx.showLayer && <LayerChip layer={placed.layer} />}
                  {placed.anchor && <Quote>{placed.anchor.exact}</Quote>}
                  {!placed.anchored && (
                    <span className="mt-1 block">
                      <Chip kind="warn">Quote not found</Chip>
                    </span>
                  )}
                </button>
              )}
              <p className="mt-1.5 text-[15px] leading-[22px] break-words whitespace-pre-wrap text-text">{comment.body}</p>
              <p className="tnum mt-1 flex flex-wrap items-center gap-2 text-[13px] text-text2">
                {formatDateTime(comment.created_at)}
                {comment.resolved_at && <Chip kind="pass">Resolved</Chip>}
              </p>
              {comment.replies.length > 0 && (
                <ol className="mt-2 flex flex-col gap-2 border-l-2 border-line pl-3">
                  {comment.replies.map((r: CommentOut) => (
                    <li key={r.id}>
                      <p className="text-[15px] leading-[22px] break-words whitespace-pre-wrap text-text">{r.body}</p>
                      <p className="tnum text-[13px] text-text2">{formatDateTime(r.created_at)}</p>
                    </li>
                  ))}
                </ol>
              )}
            </div>
          </div>
        ) : general ? (
          <div className="mt-2 flex items-start gap-2.5">
            <Avatar name={generalMine ? "You" : "Reviewer"} initials={generalMine ? "Me" : "R"} tone={generalMine ? "me" : "default"} />
            <div className="min-w-0 flex-1">
              <p className="text-[13px] leading-4 font-semibold text-text2" data-testid="feedback-author">
                {generalMine ? "You" : "Reviewer"}
              </p>
              <p className="mt-1 text-[15px] leading-[22px] break-words whitespace-pre-wrap text-text">{item.summary}</p>
              <p className="tnum mt-1 text-[13px] text-text2">{formatDateTime(item.created_at)}</p>
            </div>
          </div>
        ) : (
          <>
            <p className="mt-1.5 text-[15px] leading-[22px] break-words text-text">{item.summary}</p>
            {item.anchor && <Quote>{item.anchor.exact}</Quote>}
          </>
        )}
        <FromQuestionLink item={item} />
        <AgentStagedNote item={item} />
        {item.resolution_note && (
          <p className="mt-1 text-sm leading-5 break-words text-text2">
            <span className="font-semibold text-text">Resolution:</span> {item.resolution_note}
          </p>
        )}
        {item.suggestion && <SuggestionCard suggestion={item.suggestion} canDecide={ctx.canDecide} editing={d?.mode === "edit"} />}
        <p className="tnum mt-1.5 text-[13px] text-text2">
          raised on v{item.raised_on_version}
          {item.addressed_in_version != null && ` · addressed in v${item.addressed_in_version}`}
        </p>
      </li>
    );
  };

  if (item.suggestion) {
    // Remounts when the suggestion changes, so the editor starts from the saved text.
    return (
      <SuggestionDecision key={`${item.suggestion.id}|${item.suggestion.updated_at}`} s={item.suggestion} onChanged={onChanged}>
        {(d) => card(d)}
      </SuggestionDecision>
    );
  }
  return card(null);
}

/**
 * The Feedback tab: comments, Oracle suggestions and section reviews in ONE list, by state
 * (Open, Staged, Declined, Done) and scope (this section, all, or General: the whole-draft
 * items), with a kind filter; commenters add whole-draft feedback at its top. A
 * suggestion just decided stays in view, in its new state, until a filter changes; a
 * resolved item leaves the Open list at once. Discussions (G1) are the fourth kind, behind
 * their own chip: the document's discussions, never counted as open feedback.
 */
export function FeedbackList({
  entries,
  scopeKeys,
  filters,
  setFilters,
  focus = false,
  onFocused,
  generalOpen = false,
  setGeneralOpen,
  onGeneral,
  discussions,
  ...ctx
}: Ctx & {
  /** The document's discussions (G1), shown under the Discussion chip; absent: no chip. */
  discussions?: { rows: DiscussionRow[] | null; onOpen: (id: string) => void };
  /** "Comment on the whole draft" is open (the header's action opens it too). */
  generalOpen?: boolean;
  setGeneralOpen?: (open: boolean) => void;
  /** Adds a whole-draft item; absent: no entry (read-only or below commenter). */
  onGeneral?: (body: string) => Promise<void>;
  entries: FeedbackEntry[];
  /** The open section and the detail shown inside it; null: no section open. */
  scopeKeys: ReadonlySet<string> | null;
  filters: FeedbackFilters;
  setFilters: (f: FeedbackFilters) => void;
  /** Arriving at the open feedback (?feedback=open): bring the first item into view, once. */
  focus?: boolean;
  onFocused?: () => void;
}) {
  // Items changed here stay listed (in their new state) until the filters change.
  const [kept, setKept] = useState<Set<string>>(() => new Set());
  const filterKey = `${filters.state}|${filters.scope}|${filters.kind}|${[...(scopeKeys ?? [])].join(",")}`;
  const [keptFor, setKeptFor] = useState(filterKey);
  if (keptFor !== filterKey) {
    setKeptFor(filterKey);
    setKept(new Set());
  }
  const keep = (id: string) => setKept((k) => new Set(k).add(id));

  const inSection = (e: FeedbackEntry) => !!scopeKeys && !!e.item.section_key && scopeKeys.has(e.item.section_key);
  const sectionHas = entries.some(inSection);
  // "auto": this section, or every section when this one has no feedback at all.
  // "This section" with no section open reads as every section.
  const scope =
    filters.scope === "auto" ? (scopeKeys && sectionHas ? "section" : "all") : filters.scope === "section" && !scopeKeys ? "all" : filters.scope;
  const ofKind = (e: FeedbackEntry) => filters.kind === "all" || e.kind === filters.kind;
  const scoped = (e: FeedbackEntry, sc: "section" | "all" | "general") =>
    sc === "all" || (sc === "general" ? isGeneralFeedback(e.item) : inSection(e));
  const inScope = (e: FeedbackEntry) => scoped(e, scope);
  const stateCount = (st: FeedbackState) => entries.filter((e) => e.state === st && ofKind(e) && inScope(e)).length;
  const scopeCount = (sc: "section" | "all" | "general") =>
    entries.filter((e) => e.state === filters.state && ofKind(e) && scoped(e, sc)).length;
  const shown = entries.filter((e) => ofKind(e) && inScope(e) && (e.state === filters.state || kept.has(e.item.id)));

  const listRef = useRef<HTMLOListElement>(null);
  // Arriving at the open feedback: the first item at the top of the panel, its actions in view.
  const ready = shown.length > 0;
  useEffect(() => {
    if (!focus || !ready) return;
    const el = listRef.current?.querySelector<HTMLElement>("[data-testid=feedback-item]");
    if (!el) return;
    const box = el.closest<HTMLElement>("[role=tabpanel]");
    if (box && box.scrollHeight > box.clientHeight + 1 && getComputedStyle(box).overflowY !== "visible") {
      // The panel scrolls inside itself: bring the item up when its actions are below the fold.
      const offset = el.getBoundingClientRect().top - box.getBoundingClientRect().top;
      if (offset > box.clientHeight - 120) box.scrollTop += offset - 8;
    }
    const top = el.getBoundingClientRect().top;
    if (top < 0 || top > window.innerHeight * 0.6) el.scrollIntoView({ block: "start" });
    onFocused?.();
  }, [focus, ready, onFocused]);
  useEffect(() => {
    if (!ctx.activeId) return;
    listRef.current?.querySelector(`[data-comment-id="${ctx.activeId}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [ctx.activeId]);

  const discussing = filters.kind === "discussion";
  const discussionChip = discussions && (
    <button
      type="button"
      data-testid="feedback-discussions"
      aria-pressed={discussing}
      onClick={() => setFilters({ ...filters, kind: discussing ? "all" : "discussion" })}
      className={`flex h-8 flex-none items-center gap-2 rounded-full border px-3 text-sm font-medium max-[639px]:h-11 ${
        discussing ? "border-accent bg-accent text-on-accent" : "border-line-strong text-text hover:bg-surface2"
      }`}
    >
      Discussion
      <b className={`tnum font-semibold ${discussing ? "text-on-accent" : "text-text2"}`}>{discussions.rows?.length ?? "–"}</b>
    </button>
  );
  if (discussing && discussions) {
    return (
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          {discussionChip}
          <KindSelect filters={filters} setFilters={setFilters} />
        </div>
        {discussions.rows ? <DiscussionList rows={discussions.rows} onOpen={discussions.onOpen} version={ctx.n} /> : null}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {onGeneral &&
        (generalOpen ? (
          <GeneralForm
            onAdd={async (body) => {
              await onGeneral(body);
              setFilters({ ...filters, state: "open", scope: "general" });
            }}
            onClose={() => setGeneralOpen?.(false)}
          />
        ) : (
          <div>
            <Button icon="comment" onClick={() => setGeneralOpen?.(true)} data-testid="general-feedback-open">
              Comment on the whole draft
            </Button>
          </div>
        ))}
      <div className="flex flex-col gap-2">
        <FilterChips<FeedbackState>
          label="Feedback state"
          testId="feedback-state"
          value={filters.state}
          onChange={(state) => setFilters({ ...filters, state })}
          items={FEEDBACK_STATES.map((st) => ({ value: st, label: FEEDBACK_STATE_LABEL[st], count: stateCount(st) }))}
        />
        <div className="flex flex-wrap items-center gap-2">
          <FilterChips<"section" | "all" | "general">
            label="Show"
            testId="inspector-scope"
            value={scope}
            onChange={(sc) => setFilters({ ...filters, scope: sc })}
            items={[
              ...(scopeKeys ? [{ value: "section" as const, label: "This section", count: scopeCount("section") }] : []),
              { value: "all", label: "All sections", count: scopeCount("all") },
              { value: "general", label: "General", count: scopeCount("general") },
            ]}
          />
          {discussionChip}
          <KindSelect filters={filters} setFilters={setFilters} />
        </div>
      </div>
      {shown.length === 0 ? (
        <Empty testId="feedback-empty">
          No {FEEDBACK_STATE_LABEL[filters.state].toLowerCase()} feedback
          {scope === "section" ? " on this section" : scope === "general" ? " on the whole draft" : ""}
        </Empty>
      ) : (
        <ol ref={listRef} className="flex flex-col" aria-label="Feedback items">
          {shown.map((e) => (
            <FeedbackCard
              key={e.item.id}
              entry={e}
              ctx={{
                ...ctx,
                onChanged: (id) => {
                  keep(id);
                  ctx.onChanged(id);
                },
                onTriaged: () => ctx.onChanged(e.item.id),
              }}
            />
          ))}
        </ol>
      )}
    </div>
  );
}

function KindSelect({ filters, setFilters }: { filters: FeedbackFilters; setFilters: (f: FeedbackFilters) => void }) {
  return (
    <label className="flex min-w-0 flex-1 basis-32">
      <span className="sr-only">Kind</span>
      <select
        aria-label="Filter by kind"
        data-testid="feedback-kind"
        value={filters.kind}
        onChange={(e) => setFilters({ ...filters, kind: e.target.value as FeedbackKind | "all" })}
        className={`${SELECT} w-full max-[639px]:h-11`}
      >
        <option value="all">All kinds</option>
        {FEEDBACK_KINDS.map((k) => (
          <option key={k} value={k}>
            {FEEDBACK_KIND_LABEL[k]}
          </option>
        ))}
      </select>
    </label>
  );
}
