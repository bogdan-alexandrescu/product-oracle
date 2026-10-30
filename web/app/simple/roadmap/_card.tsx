"use client";

import Link from "next/link";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { Button, SegmentedControl } from "@/components/ds";
import { FlowDetail, FlowThumb as FlowPicture } from "@/components/simple/Flow";
import { FlowPanel, type FlowSubject } from "@/components/simple/FlowVisual";
import { Icon, ICONS, Tabs } from "@/components/simple/FlowViews";
import { ItemTalk } from "@/components/simple/chat/ItemTalk";
import { askThread, itemTalkPage, type ChatCard } from "@/lib/api/simple-chat";
import { useScreenSubject } from "@/lib/screen-subject";

import { HORIZONS, type Horizon } from "./_board";
import {
  confidenceWord,
  milestoneInk,
  shortDay,
  sourceWord,
  statusWord,
  storedDates,
  type Change,
  type Flag,
  type Item,
} from "./_lib";

/** What a change asks the engine, built by the page and sent through `act`. */
export type Act = (
  what: string,
  body: Parameters<typeof import("./_lib").propose>[0],
) => Promise<void>;

const FIX_WORDS: Record<Flag["fixes"][number], string> = {
  shift_dependents: "Move the dependents",
  move_dependency: "Move the dependency",
  accept_risk: "Accept as risk",
};

/** fix4 qa-simple-roadmap-18: a reader who may not decide the item (a commenter) only
 * proposes the fix, and its button says so ("Propose: move the dependents"). */
const fixWords = (f: Flag["fixes"][number], decides: boolean): string =>
  decides ? FIX_WORDS[f] : `Propose: ${FIX_WORDS[f][0].toLowerCase()}${FIX_WORDS[f].slice(1)}`;

/** D14's one-click fixes of one flag: move the dependents, move the dependency, or accept
 * the risk with a note (the flag then stays amber). */
export function FixButtons({
  item,
  flag,
  items,
  act,
  canChange,
  inline = false,
}: {
  item: Item;
  flag: Flag;
  items: Map<string, Item>;
  act: Act;
  canChange: boolean;
  inline?: boolean;
}) {
  const [note, setNote] = useState<string | null>(null);
  if (!canChange) return null;
  const dep = flag.subject ? items.get(flag.subject) : undefined;
  const fix = (kind: "shift_dependents" | "move_dependency") => {
    if (!dep) return;
    void act(
      kind === "shift_dependents"
        ? `Moved what depends on '${dep.title}'`
        : `Moved '${dep.title}'`,
      {
        op: kind,
        target: { item_id: item.id, subject: dep.id },
        before: { [item.id]: storedDates(item), [dep.id]: storedDates(dep) },
        after: {},
      },
    );
  };
  if (note !== null)
    return (
      <form
        className={
          inline
            ? "flex items-center gap-1.5"
            : "mt-1 flex flex-wrap items-center gap-2"
        }
        onSubmit={(e) => {
          e.preventDefault();
          if (!note.trim()) return;
          void act("Accepted as a risk", {
            op: "accept_risk",
            target: {
              item_id: item.id,
              flag: flag.kind,
              subject: flag.subject ?? null,
            },
            before: { risk: null },
            after: { risk: { note: note.trim() } },
          });
          setNote(null);
        }}
      >
        <input
          autoFocus
          aria-label="Why it is an accepted risk"
          placeholder="One line: why it is fine"
          value={note}
          maxLength={500}
          onChange={(e) => setNote(e.target.value)}
          className={`${inline ? "h-6 w-56" : "h-8 min-w-0 flex-1"} rounded-lg border border-line-strong bg-surface px-2 text-sm`}
        />
        <Button
          type="submit"
          variant="solid"
          className={inline ? "!h-6 !px-2 !text-xs" : ""}
        >
          {item.can_decide ? "Save the risk" : "Propose the risk"}
        </Button>
        <Button
          variant="ghost"
          className={inline ? "!h-6 !px-2 !text-xs" : ""}
          onClick={() => setNote(null)}
        >
          Cancel
        </Button>
      </form>
    );
  return (
    <div
      className={inline ? "flex gap-1.5" : "mt-1 flex flex-wrap gap-1.5"}
      data-testid="fixes"
    >
      {flag.fixes.map((f) =>
        f === "accept_risk" ? (
          <Button
            key={f}
            className={inline ? "!h-6 !px-2 !text-xs" : ""}
            onClick={() => setNote("")}
          >
            {fixWords(f, item.can_decide)}
          </Button>
        ) : dep ? (
          <Button
            key={f}
            className={inline ? "!h-6 !px-2 !text-xs" : ""}
            onClick={() => fix(f)}
          >
            {fixWords(f, item.can_decide)}
          </Button>
        ) : null,
      )}
    </div>
  );
}

/** One flag: its one-line reason, red or amber (an accepted risk, with its note). */
export function FlagLine({ flag }: { flag: Flag }) {
  return (
    <p
      data-testid="flag-reason"
      data-state={flag.state}
      className={`text-sm ${flag.state === "red" ? "text-crit" : "text-warn"}`}
    >
      {flag.state === "red" ? "⚠ " : "Accepted risk: "}
      {flag.reason}
      {flag.risk_note && (
        <span className="text-text2"> · “{flag.risk_note}”</span>
      )}
    </p>
  );
}

/** The red callout by a broken bar, inside its own row: its one-line reason and its
 * one-click fixes (on a phone, the reason; the fixes are on the item's sheet). */
export function Callout({
  item,
  flag,
  items,
  act,
  canChange,
  x,
  y,
  h,
  compact,
  maxX,
  before,
}: {
  item: Item;
  flag: Flag;
  items: Map<string, Item>;
  act: Act;
  canChange: boolean;
  x: number;
  y: number;
  h: number;
  compact: boolean;
  /** #4, #5: the chart's own drawn width, so the callout (and its buttons) stay inside it
   * rather than run past the right edge or start cut off the left. */
  maxX: number;
  /** Where the bar starts, less a gap: a callout with no room on the right sits left of the bar. */
  before?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [left, setLeft] = useState(Math.max(4, x));
  useLayoutEffect(() => {
    const w = ref.current?.offsetWidth ?? 0;
    // Right of the bar when it fits; else left of the bar; else slid inside, never past either edge.
    if (x + w + 4 <= maxX) setLeft(Math.max(4, x));
    else if (before != null && before - w >= 4) setLeft(before - w);
    else setLeft(Math.max(4, Math.min(x, maxX - w - 4)));
  }, [x, before, maxX, flag.reason, compact]);
  return (
    <div
      ref={ref}
      data-testid="broken-callout"
      data-item={item.key}
      style={{ left, top: y + 3, minHeight: h - 6, maxWidth: Math.max(160, maxX - 8) }}
      className="pointer-events-none absolute z-10 flex flex-nowrap items-center gap-2 rounded-lg border border-crit bg-crit-bg px-2 py-1 [&_button]:pointer-events-auto"
    >
      {/* fix4 review (qa-simple-roadmap-6): a phone has no hover for a cut reason's full
       * words, so there the reason wraps inside the callout instead. */}
      <span
        className={`min-w-0 text-sm text-crit ${compact ? "max-w-[220px] leading-[18px] break-words" : "max-w-[360px] truncate"}`}
        title={flag.reason}
      >
        ⚠ {flag.reason}
      </span>
      {!compact && (
        <FixButtons
          item={item}
          flag={flag}
          items={items}
          act={act}
          canChange={canChange}
          inline
        />
      )}
    </div>
  );
}

/** Oracle's date suggestion: Accept · Edit dates · Dismiss (through the change engine). */
export function SuggestionPopover({
  item,
  canAct,
  onAccept,
  onEdit,
  onDismiss,
  onClose,
  style,
  above,
}: {
  item: Item;
  canAct: boolean;
  onAccept: () => void;
  onEdit: (start: string, end: string) => void;
  onDismiss: () => void;
  onClose: () => void;
  style: React.CSSProperties;
  /** qa-simple-roadmap-29: the bar's top in the chart (px): with no room below the bar
   * inside the chart, the popover opens above it, clear of the chart's foot and legend. */
  above?: number;
}) {
  const s = item.suggestion!;
  const [editing, setEditing] = useState(false);
  const [start, setStart] = useState(s.start_date);
  const [end, setEnd] = useState(s.end_date);
  const box = useRef<HTMLDivElement>(null);
  const [flip, setFlip] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = box.current;
    const parent = el?.offsetParent as HTMLElement | null;
    if (!el || !parent || above == null) return setFlip(null);
    const top = Number(style.top ?? 0);
    const h = el.offsetHeight;
    setFlip(top + h > parent.clientHeight && above - h >= 0 ? above - h : null);
  }, [above, style.top, editing]);
  return (
    <div
      ref={box}
      role="dialog"
      aria-label="Oracle's date suggestion"
      data-testid="suggestion-popover"
      data-side={flip != null ? "above" : "below"}
      style={flip != null ? { ...style, top: flip } : style}
      className="absolute z-30 w-[340px] max-w-[92vw] rounded-xl border border-line bg-surface p-3 shadow-tip"
    >
      <p className="text-sm font-semibold">
        Oracle suggests {shortDay(s.start_date)} – {shortDay(s.end_date)}
      </p>
      <p className="mt-1 text-sm text-text2">{s.basis}</p>
      {editing ? (
        <form
          className="mt-2 flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (end >= start) onEdit(start, end);
          }}
        >
          <label className="text-xs text-text2">
            Start
            <input
              type="date"
              value={start}
              onChange={(e) => setStart(e.target.value)}
              className="block h-8 rounded-lg border border-line-strong bg-surface px-2 text-sm text-text"
            />
          </label>
          <label className="text-xs text-text2">
            End
            <input
              type="date"
              value={end}
              min={start}
              onChange={(e) => setEnd(e.target.value)}
              className="block h-8 rounded-lg border border-line-strong bg-surface px-2 text-sm text-text"
            />
          </label>
          <Button type="submit" variant="solid">
            Save dates
          </Button>
        </form>
      ) : (
        canAct && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            <Button onClick={onAccept}>
              {s.can_decide ? "Accept" : "Propose these dates"}
            </Button>
            <Button onClick={() => setEditing(true)}>Edit dates</Button>
            {s.can_decide && (
              <Button variant="ghost" onClick={onDismiss}>
                Dismiss
              </Button>
            )}
          </div>
        )
      )}
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="absolute top-2 right-2 h-6 w-6 rounded text-text2 hover:bg-surface2"
      >
        ×
      </button>
    </div>
  );
}

function names(ids: string[], items: Map<string, Item>): string {
  const t = ids.map((id) => items.get(id)?.title).filter(Boolean);
  // fix4 qa-simple-roadmap-42: empty values read like "No owner yet", capitalised.
  return t.length ? t.join(", ") : "No other items";
}

const OP_WORDS: Record<string, string> = {
  move_dates: "Move the dates",
  change_horizon: "Change the horizon",
  cut: "Cut it",
  restore: "Restore it",
  edit_title: "Rename it",
  edit_outcome: "Change the outcome",
  accept_date_suggestion: "Accept Oracle's dates",
  accept_risk: "Accept a risk",
  shift_dependents: "Move the dependents",
  move_dependency: "Move the dependency",
  add_key_date: "Add a key date",
  edit_key_date: "Change a key date",
  remove_key_date: "Remove a key date",
  add_item: "Add an item",
  merge_item: "Merge a duplicate",
  keep_both: "Keep both",
  confirm_item: "Confirm the draft",
  cut_with_dependents: "Cut it and its dependents",
};

/** S7: a draft's likely duplicates, "Looks like <code> <title>", with Merge and Keep both
 * (merge_item, keep_both through the change engine: editors apply, others propose). */
export function LooksLike({
  item,
  act,
  canChange,
}: {
  item: Item;
  act: Act;
  canChange: boolean;
}) {
  if (!item.looks_like.length) return null;
  return (
    <div className="mt-2 space-y-1.5" data-testid="looks-like">
      {item.looks_like.map((m) => (
        <div
          key={m.id}
          className="flex flex-wrap items-center gap-2 rounded-lg bg-warn-bg px-2 py-1.5 text-sm text-warn"
          data-testid="looks-like-match"
        >
          <span className="min-w-0 flex-1">
            {/* fix4 qa-simple-roadmap-3: titles only, no codes. */}
            Looks like <b>{m.title}</b>
          </span>
          {canChange && (
            <Button
              className="!h-7"
              onClick={() =>
                void act(
                  `Merged '${item.title}' into ${m.title}`,
                  {
                    op: "merge_item",
                    target:
                      m.kind === "item"
                        ? { item_id: item.id, into_id: m.id }
                        : { item_id: item.id, feature_id: m.id },
                    before: {},
                    after: {},
                  },
                )
              }
            >
              Merge
            </Button>
          )}
        </div>
      ))}
      {canChange && (
        <Button
          className="!h-7"
          variant="ghost"
          onClick={() =>
            void act(
              `Kept '${item.title}' and ${item.looks_like.map((m) => m.title).join(", ")}`,
              {
                op: "keep_both",
                target: { item_id: item.id },
                before: { kept_both: false },
                after: {},
              },
            )
          }
        >
          Keep both
        </Button>
      )}
    </div>
  );
}

export const opWords = (op: string): string =>
  OP_WORDS[op] ?? op.replace(/_/g, " ");

/** fix5-cut-dependents: a draft's change-list row; a cut with its dependents names every item it cut
 * ("Cut Alert rules engine and its dependents Weekly alert digest and Mobile alert push"). */
export function changeRowWords(c: { op: string; titles?: string[] }): string {
  const [first, ...rest] = c.titles ?? [];
  if (c.op !== "cut_with_dependents" || !first) return opWords(c.op);
  const names = rest.length > 1 ? `${rest.slice(0, -1).join(", ")} and ${rest[rest.length - 1]}` : (rest[0] ?? "");
  return `Cut ${first} and its dependents${names ? ` ${names}` : ""}`;
}

/** Whether a proposal is for a new flow or feature (a draft item, D15's): only those carry
 * a flow thumbnail. */
export const featureProposal = (c: Change, items: Map<string, Item>): boolean =>
  !!items.get(String(c.target.item_id))?.draft;

/** A flow thumbnail (S10 draws the flows): opens the flow by widening the card in place. */
function FlowThumb({
  onOpen,
  label = "Open the flow",
  testId = "flow-thumb",
}: {
  onOpen: () => void;
  label?: string;
  testId?: string;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      aria-label={label}
      onClick={onOpen}
      className="flex h-9 w-12 flex-none items-center justify-center rounded border border-line bg-surface2"
    >
      <svg width="34" height="20" viewBox="0 0 34 20" aria-hidden>
        <rect
          x="1"
          y="6"
          width="8"
          height="8"
          rx="2"
          fill="none"
          stroke="var(--line-strong)"
        />
        <rect
          x="13"
          y="6"
          width="8"
          height="8"
          rx="2"
          fill="none"
          stroke="var(--line-strong)"
        />
        <rect
          x="25"
          y="6"
          width="8"
          height="8"
          rx="2"
          fill="none"
          stroke="var(--line-strong)"
        />
        <path d="M9 10 H13 M21 10 H25" stroke="var(--line-strong)" />
      </svg>
    </button>
  );
}

/** One of the card's parts ("WHY", "FLOW"): the mock-up's small-capitals heading over its body. */
function Part({ title, children, testId }: { title: string; children: React.ReactNode; testId?: string }) {
  return (
    <section className="mt-3" data-testid={testId}>
      <h3 className="text-[12px] leading-4 font-semibold tracking-[.06em] text-text2 uppercase">
        {title}
      </h3>
      {children}
    </section>
  );
}

/** Where the widened card sits beside its talk (pick C): 16 px from the page's top and foot, its
 * right edge 22 px inside the page (the rail and the Ask dock stay clear). */
function useTalkPlace(on: boolean): number {
  const [right, setRight] = useState(66);
  useLayoutEffect(() => {
    if (!on) return;
    const read = () => {
      const r = document.querySelector("main")?.getBoundingClientRect();
      setRight(r ? Math.max(8, Math.round(window.innerWidth - r.right) + 22) : 22);
    };
    read();
    window.addEventListener("resize", read);
    return () => window.removeEventListener("resize", read);
  }, [on]);
  return right;
}

/**
 * D8 as amended, drawn to the owner's pick C ("Wider card, talk beside the details",
 * simple-v3/talk/card-ask.html): a floating card by the bar (phones: a bottom sheet with a grab
 * handle) headed by the item's code and title, with its outcome, owner, dates and their source,
 * status, confidence, dependencies, top 3 reasons, open decisions, its flow (the flow pick's
 * row), the proposals on it, "Open the detailed view" and "Talk to Oracle". Talk to Oracle
 * widens the card to 840 px over the roadmap: the details on the left, the talk on the right
 * with its message box at the foot, "Hide the talk" beside the close. A phone's sheet gets two
 * tabs, Details | Talk to Oracle.
 */
export function FloatingCard({
  item,
  items,
  proposals,
  phone,
  style,
  act,
  canChange,
  onDecide,
  onClose,
  onHorizon,
  near,
}: {
  /** Roadmap-plus: the key dates the item ends within 2 weeks of, in words (none: no line). */
  near?: string | null;
  item: Item;
  items: Map<string, Item>;
  proposals: Change[];
  phone: boolean;
  style: React.CSSProperties;
  act: Act;
  canChange: boolean;
  onDecide: (c: Change, how: "accept" | "decline") => void;
  onClose: () => void;
  /** The board's horizon control (a phone cannot always drag a card to a column off the screen). */
  onHorizon?: (h: Horizon) => void;
}) {
  // The widened card's visual: a draft's own flow ("item", S7) or a proposal's visual (S10).
  const [wide, setWide] = useState<FlowSubject | "item" | null>(null);
  // roadmap-talk: the item's talk with Oracle, open beside the details (a phone: its tab).
  const [talk, setTalk] = useState(false);
  // The item's flow opened across the page (or its storyboard): the card steps out of its way.
  const [flowOpen, setFlowOpen] = useState(false);
  const openFlow = (w: FlowSubject | "item" | null) => {
    setWide(w);
    if (w && !phone) setTalk(false);
  };
  // fix4 qa-simple-roadmap-3: the card, its talk and the chat name the item by its title, no code.
  const about = item.title;
  const ref = useRef<HTMLDivElement>(null);
  // fix4 qa-simple-roadmap-16: the changes waiting in the item's talk (cards not yet applied,
  // proposed or discarded) are proposals on it too: one source, the talk's own thread, read
  // when the card opens and kept as the talk changes.
  const [talkCards, setTalkCards] = useState<{ id: string; cards: ChatCard[] } | null>(null);
  const onTalkCards = useCallback((cards: ChatCard[]) => setTalkCards({ id: item.id, cards }), [item.id]);
  useEffect(() => {
    let live = true;
    askThread(itemTalkPage(item.id))
      .then((t) => live && onTalkCards(t.messages.flatMap((m) => m.cards ?? [])))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [item.id, onTalkCards]);
  const waiting = talkCards && talkCards.id === item.id ? talkCards.cards.filter((c) => c.status === "open") : [];
  useScreenSubject(
    { kind: "roadmap_item", subject: { item_id: item.id, key: item.key } },
    item.title,
  );
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    ref.current?.focus();
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const dates = item.estimated
    ? `${shortDay(item.start.date)} – ${shortDay(item.end.date)} · Estimated by Oracle (the ${item.horizon} window)`
    : `${shortDay(item.start.date)} – ${shortDay(item.end.date)} · ${sourceWord(item.source)}`;
  const beside = talk && !phone;
  const talkRight = useTalkPlace(beside);
  // A widened card (a proposal's flow) keeps inside the roadmap, not the 380 px card's left.
  const [left, setLeft] = useState<number | null>(null);
  const baseLeft = typeof style.left === "number" ? style.left : null;
  useLayoutEffect(() => {
    const el = ref.current;
    const parent = el?.offsetParent as HTMLElement | null;
    if (phone || beside || !el || !parent || baseLeft == null) return setLeft(null);
    const room = parent.clientWidth - el.offsetWidth - 8;
    setLeft(baseLeft > room ? Math.max(0, room) : null);
  }, [wide, phone, beside, baseLeft]);

  const place = phone
    ? wide
      ? "fixed inset-0 z-50 flex h-dvh flex-col"
      : `fixed inset-x-0 bottom-0 z-50 flex flex-col rounded-t-2xl border-t h-[85dvh]`
    : beside
      ? "fixed z-40 flex w-[840px] flex-col rounded-xl border"
      : `absolute z-40 rounded-xl border p-4 ${wide ? "w-[760px]" : "w-[380px]"}`;
  const placeStyle: React.CSSProperties | undefined = phone
    ? undefined
    : beside
      ? { top: 16, bottom: 16, right: talkRight }
      : left == null
        ? style
        : { ...style, left };

  const head = (
    <div className="flex items-start gap-2">
      <h2 className="min-w-0 flex-1 text-[18px] leading-6 font-semibold break-words">
        {item.title}
        {item.draft && item.status !== "merged" && (
          <span
            className="ml-2 inline-block rounded-full bg-na-bg px-2 align-middle text-xs font-normal text-na"
            data-testid="draft-tag"
          >
            Draft
          </span>
        )}
      </h2>
      {beside && (
        <button
          type="button"
          onClick={() => setTalk(false)}
          className="inline-flex h-8 flex-none items-center rounded-lg px-3 text-[14px] leading-none font-semibold whitespace-nowrap text-accent-ink hover:bg-surface2"
        >
          Hide the talk
        </button>
      )}
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="grid h-7 w-7 flex-none place-items-center rounded-md text-text2 hover:bg-surface2"
      >
        <Icon d={ICONS.close} size={18} width={1.7} />
      </button>
    </div>
  );

  const flowPart = item.draft ? (
    item.status !== "merged" && (
      <Part title="Flow">
        <div className="mt-1 flex items-center gap-2">
          {item.flow ? (
            <button
              type="button"
              data-testid="item-flow-thumb"
              aria-label="Open the flow"
              onClick={() => openFlow(wide === "item" ? null : "item")}
              className="rounded-md border border-line bg-surface p-1"
            >
              <FlowPicture flow={item.flow} />
            </button>
          ) : (
            // fix4 review (qa-simple-roadmap-39): a draft has no flow to draw yet; it says why,
            // and where it is confirmed (Priorities' "Not ranked yet").
            <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span
                className="rounded-md border border-dashed border-line px-2 py-0.5 text-text2"
                data-testid="item-flow-none"
              >
                No flow yet. Once the draft is confirmed, Oracle can draw one.
              </span>
              {canChange && (
                <Link
                  href="/simple/priorities"
                  className="text-sm font-semibold text-accent-ink hover:underline"
                >
                  Confirm it in Priorities
                </Link>
              )}
            </span>
          )}
        </div>
      </Part>
    )
  ) : (
    <Part title="Flow" testId="card-flow">
      {/* fix4 qa-simple-roadmap-39: the same row (its thumbnail, or "Ask Oracle to draw it") on
       * a desktop, a phone and the card widened beside its talk; qa-simple-roadmap-3: no code. */}
      <FlowPanel
        key={`row-${item.id}`}
        row
        subject={{ kind: "feature", id: item.id }}
        openLabel="Open the item's flow"
        code={null}
        name={item.title}
        backLabel="Roadmap"
        onOpenChange={setFlowOpen}
      />
    </Part>
  );

  const details = (
    <>
      {item.drafting && (
        <p
          className="mt-1 text-sm text-accent-ink"
          role="status"
          data-testid="item-drafting"
        >
          Oracle is drafting…
        </p>
      )}
      {item.merged_into && (
        <p className="mt-1 text-sm text-text2" data-testid="item-merged">
          Merged into {item.merged_into.title}
        </p>
      )}
      <LooksLike item={item} act={act} canChange={canChange} />
      <div className={wide && !phone ? "grid grid-cols-2 gap-4" : ""}>
        <dl className="mt-2.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5">
          <dt className="text-text2">Outcome</dt>
          <dd data-testid="card-outcome">
            {item.outcome ?? (
              <span className="text-text2">Not written yet</span>
            )}
          </dd>
          <dt className="text-text2">Owner</dt>
          <dd data-testid="card-owner">
            {item.owner?.name ?? (
              <span className="text-text2">No owner yet</span>
            )}
          </dd>
          <dt className="text-text2">Dates</dt>
          <dd data-testid="card-dates">{dates}</dd>
          {item.slices.length > 0 && (
            <>
              <dt className="text-text2">Milestone</dt>
              <dd data-testid="card-milestone">
                {[
                  ...new Map(
                    item.slices.map((x) => [
                      x.milestone,
                      `${x.milestone} ${x.milestone_name}`,
                    ]),
                  ).values(),
                ].join(", ")}
              </dd>
              <dt className="text-text2">Slices</dt>
              <dd>
                <ul className="space-y-1" data-testid="card-slices">
                  {item.slices.map((x) => (
                    <li
                      key={x.code}
                      data-testid="card-slice"
                      className="flex gap-2"
                    >
                      <span
                        aria-hidden
                        className="mt-1.5 h-2.5 w-2.5 flex-none rounded-sm"
                        style={{ background: milestoneInk(x.milestone) }}
                      />
                      <span>
                        <b className="font-semibold">
                          {x.code} {x.name}
                        </b>
                        <span className="block text-sm text-text2">
                          {x.milestone} {x.milestone_name}
                          {x.start_date && x.end_date
                            ? ` · ${shortDay(x.start_date)} – ${shortDay(x.end_date)}`
                            : " · not dated yet"}
                          {x.pm_owned || x.effort_weeks == null
                            ? " · PM-owned"
                            : ` · ${x.effort_weeks} engineer-week${x.effort_weeks === 1 ? "" : "s"}`}
                          {x.estimated ? " · placed by Oracle" : ""}
                        </span>
                      </span>
                    </li>
                  ))}
                </ul>
              </dd>
            </>
          )}
          {near && (
            <>
              <dt className="text-text2">Near</dt>
              <dd data-testid="card-near">{near}</dd>
            </>
          )}
          {onHorizon && (
            <>
              <dt className="self-center text-text2">Horizon</dt>
              <dd data-testid="card-horizon">
                <SegmentedControl<Horizon>
                  label="Horizon"
                  size="sm"
                  value={item.horizon}
                  onChange={(h) => h !== item.horizon && onHorizon(h)}
                  items={HORIZONS.map((h) => ({
                    value: h.key,
                    label: h.label,
                  }))}
                />
              </dd>
            </>
          )}
          <dt className="text-text2">Status</dt>
          <dd data-testid="card-status">{statusWord(item.status)}</dd>
          <dt className="text-text2">Confidence</dt>
          <dd data-testid="card-confidence">{item.confidence ? confidenceWord(item.confidence) : "Not rated"}</dd>
          <dt className="text-text2">Depends on</dt>
          <dd data-testid="card-depends">{names(item.depends_on, items)}</dd>
          <dt className="text-text2">Needed by</dt>
          <dd data-testid="card-needed">{names(item.needed_by, items)}</dd>
        </dl>
        <div>
          {item.flags.length > 0 && (
            <section className="mt-3 space-y-1" data-testid="card-flags">
              {item.flags.map((f) => (
                <div key={`${f.kind}-${f.subject}`}>
                  <FlagLine flag={f} />
                  {f.state === "red" && (
                    <FixButtons
                      item={item}
                      flag={f}
                      items={items}
                      act={act}
                      canChange={canChange}
                    />
                  )}
                </div>
              ))}
            </section>
          )}
          <Part title="Why">
            {item.reasons.length ? (
              <ul
                className="mt-1 list-disc pl-[18px]"
                data-testid="card-reasons"
              >
                {item.reasons.slice(0, 3).map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            ) : (
              <p className="text-text2">No reasons on record yet</p>
            )}
          </Part>
          <Part title="Open decisions">
            {item.open_decisions.length ? (
              <ul className="mt-1" data-testid="card-decisions">
                {item.open_decisions.map((d) => (
                  <li key={d.id}>
                    <Link
                      href={`/company/decisions?d=${d.id}`}
                      className="text-accent-ink hover:underline"
                    >
                      {/* fix4 qa-simple-roadmap-3: the decision by its title, no "D-7". */}
                      {d.title}
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-text2">No open decisions</p>
            )}
          </Part>
          {item.decided_in.length > 0 && (
            <Part title="Decided">
              <ul className="mt-1" data-testid="card-decided-in">
                {item.decided_in.map((d) => (
                  <li key={d.id}>
                    {/* fix4 qa-simple-roadmap-3: under "Decided", the decision by its title alone. */}
                    <Link
                      href={`/simple/decisions#d-${d.number}`}
                      className="text-accent-ink hover:underline"
                    >
                      {d.title}
                    </Link>
                  </li>
                ))}
              </ul>
            </Part>
          )}
          {flowPart}
          <Part title="Proposals on it">
            {waiting.length > 0 && (
              <ul className="mt-1 space-y-1" data-testid="card-talk-proposals">
                {waiting.map((c) => (
                  <li key={c.id} className="flex items-center gap-2" data-testid="card-talk-proposal">
                    <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
                      {c.summary} ·{" "}
                      <span className="text-text2">waiting in your talk with Oracle</span>
                    </span>
                    {!talk && (
                      <Button className="!h-7" onClick={() => setTalk(true)}>
                        Open the talk
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {proposals.length ? (
              <ul className="mt-1 space-y-2" data-testid="card-proposals">
                {proposals.map((c) => (
                  <li key={c.id} className="flex items-center gap-2">
                    {featureProposal(c, items) && (
                      <FlowThumb
                        onOpen={() =>
                          openFlow(
                            wide !== "item" && wide?.id === c.id
                              ? null
                              : { kind: "change", id: c.id },
                          )
                        }
                      />
                    )}
                    <span className="min-w-0 flex-1">
                      {opWords(c.op)} ·{" "}
                      <span className="text-text2">{c.by_name}</span>
                    </span>
                    {c.can_decide && (
                      <>
                        <Button onClick={() => onDecide(c, "accept")}>
                          Accept
                        </Button>
                        <Button
                          variant="ghost"
                          onClick={() => onDecide(c, "decline")}
                        >
                          Decline
                        </Button>
                      </>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              !waiting.length && <p className="text-text2">No proposals waiting</p>
            )}
          </Part>
        </div>
        {wide && (
          <section
            data-testid="flow-view"
            className={`mt-3 ${phone ? "" : "col-span-2"}`}
          >
            <h3 className="font-semibold">
              The flow and the screen it touches
            </h3>
            {wide === "item" ? (
              <>
                {item.flow ? (
                  <FlowDetail flow={item.flow} />
                ) : (
                  <p
                    className="mt-1 text-sm text-text2"
                    data-testid="flow-empty"
                  >
                    No flow yet: Oracle has not drawn a user flow or a
                    wireframe for this proposal.
                  </p>
                )}
                <Button
                  variant="ghost"
                  className="mt-2"
                  onClick={() => openFlow(null)}
                >
                  Close the flow
                </Button>
              </>
            ) : (
              <FlowPanel
                key={`${wide.kind}-${wide.id}`}
                subject={wide}
                onClose={() => openFlow(null)}
              />
            )}
          </section>
        )}
      </div>
      <div className="mt-4 flex flex-wrap gap-2 border-t border-line pt-3">
        <Link
          href={`/plan?item=${encodeURIComponent(item.key)}${item.prd ? `&prd=${item.prd.id}` : ""}`}
          className="inline-flex h-8 items-center rounded-lg border border-line-strong bg-surface px-3 text-[14px] leading-none font-semibold whitespace-nowrap hover:bg-surface2"
        >
          Open the detailed view
        </Link>
        {!talk && !phone && (
          <button
            type="button"
            onClick={() => setTalk(true)}
            className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-accent bg-accent px-3 text-[14px] leading-none font-semibold whitespace-nowrap text-on-accent hover:bg-accent-ink"
          >
            <Icon d={ICONS.ask} size={16} />
            Talk to Oracle
          </button>
        )}
      </div>
    </>
  );

  const talkPanel = (
    <ItemTalk itemId={item.id} about={about} phone={phone} onCards={onTalkCards} />
  );

  return (
    <>
      {/* #47: the card floats over the chart with nothing to say it has the page's
       * attention; a dimmed backdrop on desktop (a phone's sheet already reads as modal),
       * clicking it closes the card like the close button. */}
      {!phone && (
        <div
          aria-hidden
          data-testid="floating-card-backdrop"
          className="fixed inset-0 z-[35] bg-black/30"
          onClick={(e) => {
            // fix4 review: the rail is dimmed under the backdrop, yet a click on one of its
            // links still goes there (not only closes the card).
            const link = document
              .elementsFromPoint(e.clientX, e.clientY)
              .map((el) => el.closest<HTMLElement>('[data-testid="simple-nav"] a, [data-testid="simple-nav"] button'))
              .find(Boolean);
            onClose();
            link?.click();
          }}
        />
      )}
      <div
        ref={ref}
        tabIndex={-1}
        role="dialog"
        aria-label={item.title}
        data-testid="floating-card"
        data-sheet={phone ? "bottom" : "float"}
        data-wide={wide ? "true" : "false"}
        data-talk={talk ? "true" : "false"}
        data-flow-open={flowOpen ? "true" : "false"}
        style={placeStyle}
        className={`${place} ${phone ? "max-w-none overflow-hidden" : "max-w-[calc(100vw-16px)]"} border-line bg-surface text-[15px] leading-[22px] text-text shadow-tip outline-none ${!phone && !beside ? "overflow-y-auto" : ""} ${flowOpen && !phone ? "pointer-events-none opacity-0" : ""}`}
      >
      {phone ? (
        <>
          {!wide && (
            <span
              aria-hidden
              className="mx-auto mt-2 mb-1 block h-1 w-10 flex-none rounded-sm bg-line-strong opacity-60"
            />
          )}
          <div
            className={`flex-none border-b border-line px-4 pb-2.5 ${wide ? "pt-3.5" : "pt-1.5"}`}
          >
            {head}
            <Tabs
              label="The item"
              className="mt-2.5"
              value={talk ? "talk" : "details"}
              onChange={(t) => setTalk(t === "talk")}
              items={[
                { value: "details", label: "Details" },
                { value: "talk", label: "Talk to Oracle" },
              ]}
            />
          </div>
          {talk ? (
            <div
              role="tabpanel"
              aria-label="Talk to Oracle"
              className="flex min-h-0 flex-1 flex-col"
            >
              {talkPanel}
            </div>
          ) : (
            <div
              role="tabpanel"
              aria-label="Details"
              className="min-h-0 flex-1 overflow-y-auto px-4 pb-4"
            >
              {details}
            </div>
          )}
        </>
      ) : beside ? (
        <>
          <div className="flex-none border-b border-line px-4 pt-3.5 pb-2.5">
            {head}
          </div>
          <div className="grid min-h-0 flex-1 grid-cols-[390px_minmax(0,1fr)]">
            <div className="min-h-0 overflow-y-auto border-r border-line px-4 pt-1 pb-3">
              {details}
            </div>
            <div className="flex min-h-0 min-w-0 flex-col">{talkPanel}</div>
          </div>
        </>
      ) : (
        <>
          {head}
          {details}
        </>
      )}
    </div>
    </>
  );
}
