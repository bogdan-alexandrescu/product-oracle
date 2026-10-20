"use client";

import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";

import { SuggestionCard, useSuggestionControls } from "@/components/SuggestionCard";
import { Avatar, Button, Chip, Empty, FilterChips, type ChipKind } from "@/components/ds";
import { LayerChip, Quote, SELECT, TEXTAREA, VerdictChip } from "@/components/review/parts";
import type { CommentOut, Suggestion } from "@/lib/api/client";
import {
  FEEDBACK_KIND_LABEL,
  FEEDBACK_KINDS,
  FEEDBACK_STATE_LABEL,
  FEEDBACK_STATES,
  type FeedbackEntry,
  type FeedbackKind,
  type FeedbackState,
} from "@/lib/feedback";
import { formatDateTime } from "@/lib/format";
import { sectionHref } from "@/lib/section-link";

/** A comment thread placed in its section: the heading, and whether its quote was found. */
export type PlacedComment = CommentOut & { heading: string; anchored: boolean };

export type FeedbackScope = "auto" | "section" | "all";
export type FeedbackFilters = { state: FeedbackState; scope: FeedbackScope; kind: FeedbackKind | "all" };
export const DEFAULT_FILTERS: FeedbackFilters = { state: "open", scope: "auto", kind: "all" };

const STATE_KIND: Record<FeedbackState, ChipKind> = { open: "acc", staged: "warn", declined: "na", done: "pass" };
const KIND_LABEL: Record<FeedbackKind, string> = { comment: "Comment", suggestion: "Suggestion", review: "Review" };

const plainClick = (e: MouseEvent) => e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;

type Ctx = {
  doc: string;
  n: number;
  headings: ReadonlyMap<string, string>;
  placed: ReadonlyMap<string, PlacedComment>;
  activeId: string | null;
  readOnly: boolean;
  canComment: boolean;
  canDecide: boolean;
  userId: string | null;
  showLayer: boolean;
  onGoTo: (key: string, version: number) => void;
  onShowComment: (c: PlacedComment) => void;
  onReply: (id: string, body: string) => Promise<void>;
  onResolve: (id: string, resolved: boolean) => Promise<void>;
  onChanged: (id: string) => void;
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

function SuggestionTools({ s, ctx, id, children }: { s: Suggestion; ctx: Ctx; id: string; children: (c: ReturnType<typeof useSuggestionControls>) => ReactNode }) {
  const controls = useSuggestionControls(s, ctx.canDecide && !ctx.readOnly, () => ctx.onChanged(id));
  return <>{children(controls)}</>;
}

/** One feedback item: kind and state, its actions at the top, then what was said and where. */
function FeedbackCard({ entry, ctx }: { entry: FeedbackEntry; ctx: Ctx }) {
  const { item, comment, kind, state } = entry;
  const [replying, setReplying] = useState(false);
  const placed = comment ? ctx.placed.get(comment.id) : undefined;
  const key = item.section_key;
  const heading = key ? ctx.headings.get(key) ?? key : null;
  const mine = !!comment && ctx.userId !== null && comment.author_id === ctx.userId;
  const commentActions =
    comment && !ctx.readOnly && ctx.canComment ? (
      <>
        {!replying && (
          <Button variant="ghost" icon="comment" onClick={() => setReplying(true)}>
            Reply
          </Button>
        )}
        {(ctx.canDecide || mine) && (
          <Button variant="ghost" icon="check" onClick={() => void ctx.onResolve(comment.id, !comment.resolved_at)}>
            {comment.resolved_at ? "Reopen" : "Resolve"}
          </Button>
        )}
      </>
    ) : null;

  const body = (suggestionActions: ReactNode, forms: ReactNode, editing: boolean) => (
    <li
      data-testid="feedback-item"
      data-kind={kind}
      data-state={state}
      data-feedback-id={item.id}
      data-comment-id={comment?.id}
      className={`border-b border-line py-3 last:border-b-0 ${
        comment && comment.id === ctx.activeId ? "-mx-5 bg-accent-soft px-5 shadow-[inset_4px_0_0_var(--accent)] max-[600px]:-mx-4 max-[600px]:px-4" : ""
      }`}
    >
      <div className="flex flex-wrap items-center gap-1.5" data-testid="feedback-head">
        <Chip kind="line">{KIND_LABEL[kind]}</Chip>
        {item.verdict && <VerdictChip verdict={item.verdict} />}
        <Chip kind={STATE_KIND[state]} data-testid="feedback-state-chip">
          {FEEDBACK_STATE_LABEL[state]}
        </Chip>
        <span className="flex-1" />
        <span className="flex flex-wrap items-center justify-end gap-1">
          {suggestionActions}
          {commentActions}
        </span>
      </div>
      {forms}
      {replying && comment && <ReplyForm onReply={(b) => ctx.onReply(comment.id, b)} onClose={() => setReplying(false)} />}

      {comment ? (
        <div data-testid="comment" data-comment-id={comment.id} className={`mt-2 flex items-start gap-2.5 ${comment.resolved_at ? "opacity-80" : ""}`}>
          <Avatar name={mine ? "You" : "Reviewer"} initials={mine ? "Me" : "R"} tone={mine ? "me" : "default"} />
          <div className="min-w-0 flex-1">
            {placed && (
              <button type="button" className="block w-full text-left" onClick={() => ctx.onShowComment(placed)} aria-label={`Show comment in ${placed.heading}`}>
                <span className="flex min-w-0 items-center gap-1.5">
                  <span className="min-w-0 truncate text-sm font-semibold text-accent-ink hover:underline">{placed.heading}</span>
                  {ctx.showLayer && <LayerChip layer={placed.layer} />}
                </span>
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
      ) : (
        <>
          <p className="mt-1.5 text-[15px] leading-[22px] break-words text-text">{item.summary}</p>
          {item.anchor && <Quote>{item.anchor.exact}</Quote>}
        </>
      )}
      {item.resolution_note && (
        <p className="mt-1 text-sm leading-5 break-words text-text2">
          <span className="font-semibold text-text">Resolution:</span> {item.resolution_note}
        </p>
      )}
      {item.suggestion && <SuggestionCard key={`${item.suggestion.id}|${item.suggestion.updated_at}`} suggestion={item.suggestion} editing={editing} />}
      <p className="tnum mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-text2">
        {key && heading && (
          <a
            href={sectionHref(ctx.doc, item.raised_on_version, key)}
            onClick={(e) => {
              if (!plainClick(e)) return;
              e.preventDefault();
              ctx.onGoTo(key, item.raised_on_version);
            }}
            data-testid="feedback-goto"
            className="min-w-0 truncate font-semibold text-accent-ink hover:underline"
            title={heading}
          >
            Go to {heading}
          </a>
        )}
        <span>
          raised on v{item.raised_on_version}
          {item.addressed_in_version != null && ` · addressed in v${item.addressed_in_version}`}
        </span>
      </p>
    </li>
  );

  if (item.suggestion && kind === "suggestion") {
    return (
      <SuggestionTools key={`${item.suggestion.id}|${item.suggestion.updated_at}`} s={item.suggestion} ctx={ctx} id={item.id}>
        {(c) => body(c.actions, c.forms, c.editing)}
      </SuggestionTools>
    );
  }
  return body(null, null, false);
}

/**
 * The Feedback tab: comments, Oracle suggestions and section reviews in ONE list, by state
 * (Open, Staged, Declined, Done) and scope (this section or all), with a kind filter. An
 * item acted on stays in view, in its new state, until a filter changes.
 */
export function FeedbackList({
  entries,
  scopeKeys,
  filters,
  setFilters,
  ...ctx
}: Ctx & {
  entries: FeedbackEntry[];
  /** The open section and the detail shown inside it; null: no section open. */
  scopeKeys: ReadonlySet<string> | null;
  filters: FeedbackFilters;
  setFilters: (f: FeedbackFilters) => void;
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
  const scope = filters.scope === "auto" ? (scopeKeys && sectionHas ? "section" : "all") : filters.scope;
  const ofKind = (e: FeedbackEntry) => filters.kind === "all" || e.kind === filters.kind;
  const inScope = (e: FeedbackEntry) => scope === "all" || inSection(e);
  const stateCount = (st: FeedbackState) => entries.filter((e) => e.state === st && ofKind(e) && inScope(e)).length;
  const scopeCount = (sc: "section" | "all") =>
    entries.filter((e) => e.state === filters.state && ofKind(e) && (sc === "all" || inSection(e))).length;
  const shown = entries.filter((e) => ofKind(e) && inScope(e) && (e.state === filters.state || kept.has(e.item.id)));

  const listRef = useRef<HTMLOListElement>(null);
  useEffect(() => {
    if (!ctx.activeId) return;
    listRef.current?.querySelector(`[data-comment-id="${ctx.activeId}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [ctx.activeId]);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-2">
        <FilterChips<FeedbackState>
          label="Feedback state"
          testId="feedback-state"
          value={filters.state}
          onChange={(state) => setFilters({ ...filters, state })}
          items={FEEDBACK_STATES.map((st) => ({ value: st, label: FEEDBACK_STATE_LABEL[st], count: stateCount(st) }))}
        />
        <div className="flex flex-wrap items-center gap-2">
          {scopeKeys && (
            <FilterChips<"section" | "all">
              label="Show"
              testId="inspector-scope"
              value={scope}
              onChange={(sc) => setFilters({ ...filters, scope: sc })}
              items={[
                { value: "section", label: "This section", count: scopeCount("section") },
                { value: "all", label: "All sections", count: scopeCount("all") },
              ]}
            />
          )}
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
        </div>
      </div>
      {shown.length === 0 ? (
        <Empty testId="feedback-empty">
          No {FEEDBACK_STATE_LABEL[filters.state].toLowerCase()} feedback{scope === "section" ? " on this section" : ""}
        </Empty>
      ) : (
        <ol ref={listRef} className="flex flex-col" aria-label="Feedback items">
          {shown.map((e) => (
            <FeedbackCard
              key={e.item.id}
              entry={e}
              ctx={{
                ...ctx,
                onResolve: async (id, resolved) => {
                  keep(e.item.id);
                  await ctx.onResolve(id, resolved);
                },
                onChanged: (id) => {
                  keep(id);
                  ctx.onChanged(id);
                },
              }}
            />
          ))}
        </ol>
      )}
    </div>
  );
}
