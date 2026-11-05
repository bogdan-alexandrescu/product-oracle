"use client";

import { createContext, useContext, useEffect, useRef, useState } from "react";

import { shortDay, sourceWord, spanWords } from "@/app/simple/roadmap/_lib";
import { FlowDetail, FlowThumb } from "@/components/simple/Flow";
import { api, unwrap } from "@/lib/api/client";
import { applyCard, CORRECT_FIELDS, discardCard, FLOW_OPS, isActionPreview, sendApplied, sendCardChanged, sendPreview, undoCard, type ActionPreview, type ChatCard as Card, type ChatPreview } from "@/lib/api/simple-chat";
import { useMe } from "@/lib/me";
import { OP_WORDS } from "@/lib/simple-home";
import { errorMessage } from "@/lib/use-query";

const detail = (e: unknown) => errorMessage(e).replace(/ \(\d{3}\)$/, "");

/** qa-simple-roadmap-26: a move's before/after in the app's month-first words ("Nov 14 –
 * Dec 24"), not the day-first text the reader typed into the chat. `before`/`after` carry
 * the raw dates for a move_dates card; any other op keeps its own words. */
function changeWords(card: Card): { before: string; after: string } | null {
  const b = card.before;
  const a = card.after;
  if (card.op === "move_dates" && typeof b.start_date === "string" && typeof b.end_date === "string" && typeof a.start_date === "string" && typeof a.end_date === "string") {
    return { before: spanWords(b.start_date, b.end_date), after: spanWords(a.start_date, a.end_date) };
  }
  // fix4 qa-simple-roadmap-26: a move of an item with no dates of its own still reads Before →
  // After, like the item talk's move card. walkc-meeting r2 (5b): its Before says the dates
  // the item shows now and where they come from (the engineering lead's, the tracker's),
  // "Estimated by Oracle" only when they are Oracle's estimate.
  if (!card.change_words && card.op === "move_dates" && typeof a.start_date === "string" && typeof a.end_date === "string") {
    const p = card.preview && !isActionPreview(card.preview) && card.preview.kind === "dates" ? card.preview.current : undefined;
    const before = p && p.source !== "estimated" ? `${spanWords(p.start_date, p.end_date)} · ${sourceWord(p.source)}` : "Estimated by Oracle";
    return { before, after: spanWords(a.start_date, a.end_date) };
  }
  return card.change_words ?? null;
}

/** qa4-simple-roadmap-41: one flag by its item, kind and subject (the same flag before and after a change). */
export const flagKey = (itemId: string, kind: string, subject: string | null | undefined): string => `${itemId}|${kind}|${subject ?? ""}`;

/**
 * qa4-simple-roadmap-41: the item card's talk. `known` holds the red flags the roadmap shows
 * now (flagKey); a change card there lists only the flags its change brings, not the ones the
 * items already had, and drops the fixes of those. Its Preview also says in words what the
 * roadmap's ghost shows, since the card covers the roadmap. Outside an item's talk: null.
 */
export const ItemTalkContext = createContext<{ known: ReadonlySet<string> } | null>(null);

/** qa4-simple-roadmap-41: a roadmap ghost in words ("On the roadmap: Adaptive pacing moves to
 * Nov 30 – Dec 11"). walkc-meeting r2 (5c): away from the roadmap (a meeting's chat, the Ask
 * panel) nothing draws the ghost, so the card says it ("After this change: ..."). */
function ghostWords(p: ChatPreview, title: string, lead: string): string | null {
  if (!p) return null;
  switch (p.kind) {
    case "dates":
      return `${lead}: ${title} moves to ${spanWords(p.start_date, p.end_date)}`;
    case "horizon":
      return `${lead}: ${title} moves to ${p.horizon[0].toUpperCase()}${p.horizon.slice(1)}`;
    case "title":
      return `${lead}: ${title} is renamed “${p.title}”`;
    case "milestone":
      return `${lead}: ${title} moves to ${p.name} (${shortDay(p.date)})`;
    case "cut":
      return `${lead}: ${title} goes below the line, cut`;
  }
  return null;
}

/** "Ann", "Ann and Bo", "Ann, Bo and Cy". */
function listWords(names: string[]): string {
  return names.length < 2 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

const proposedWords = (to: string) => `Proposed to ${to}; they decide`;

/** roadmap-talk: Correct's labelled fields. */
const FIELD_LABELS: Record<(typeof CORRECT_FIELDS)[number], string> = { title: "Title", goal: "Goal", milestone: "Milestone", start_date: "Start", end_date: "End", owner: "Owner" };

/** A chat action's Preview in words: what Apply changes (it has no roadmap ghost). */
export function actionWords(p: ActionPreview): string[] {
  switch (p.kind) {
    case "owner":
    case "decider":
      return [`${p.kind === "owner" ? "Owner" : "Decider"}: ${p.before_name ?? "none"} → ${p.person_name}`];
    case "decision":
      // On Ask a commenter's decision is a proposal: its decider confirms it.
      if (p.proposed_to) return [`Decision: ${p.text}`, proposedWords(p.proposed_to), "On the Decisions page, open until they decide"];
      return [`Decision: ${p.text} — decided by ${p.decider_name}`, p.where === "meeting" ? "In this meeting's decisions" : "On the Decisions page"];
    case "note":
      return [`Adds to the minutes' notes: ${p.text}`];
    case "question":
      return [`Adds to the open questions: ${p.text}`];
    case "agenda":
      return [p.move === "next" ? `${p.item_title} is taken next` : `${p.item_title} is skipped`];
    case "suggestion":
      // Filed as the person's own suggestion: it lands under People in the goal's drawer.
      return [
        `Suggests ${p.title} for ${p.goal_title}: ${p.outcome}`,
        ...p.looks_like.map((m) => `Looks like ${`${m.code} ${m.title}`.trim()}`),
        "Under People in the goal's suggestions; the decider accepts or rejects it",
      ];
  }
}

/**
 * One change card (Simple S9): what it changes, the constraint check as if applied (red, with
 * each one-line reason), its one-click fixes, and Preview / Apply (or Propose) / Discard by the
 * reader's own rights (`may`; null: disabled, with why). Preview ghosts the change on the
 * roadmap (the "simple:preview" event); after Apply the card says who applied or proposed it,
 * with Undo while applied. `actionsOnly` (the walk, whose step says the item and its problem
 * once above the card): the card holds just its actions, no summary, item line or red reasons,
 * and no Apply or Discard a fix or Skip already offers.
 */
export function ChatCard({
  card: initial,
  onChanged,
  onCorrecting,
  actionsOnly = false,
}: {
  card: Card;
  onChanged?: (card: Card) => void;
  /** roadmap-talk: the values typed into this card's open Correct form (null: closed), for its line's Apply all. */
  onCorrecting?: (cardId: string, values: Record<string, string | null> | null) => void;
  actionsOnly?: boolean;
}) {
  // The thread polls: a newer copy of the card (another tab applied it) replaces ours.
  const [local, setLocal] = useState<{ from: Card; card: Card } | null>(null);
  const card = local && local.from === initial ? local.card : initial;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);
  // A chat action's Preview: its description, shown in the card.
  const [described, setDescribed] = useState(false);
  const [wide, setWide] = useState(false);
  const [routedTo, setRoutedTo] = useState<string[] | null>(null);
  // roadmap-talk: Correct opens the card's fields, prefilled with Oracle's reading.
  const [fields, setFields] = useState<Record<string, string> | null>(null);
  // fix4 qa-simple-roadmap-20: an opened Correct form scrolls into view whole, its Apply row under it.
  const actions = useRef<HTMLDivElement>(null);
  const formOpen = fields !== null;
  useEffect(() => {
    if (formOpen) actions.current?.scrollIntoView({ block: "nearest" });
  }, [formOpen]);
  const { me } = useMe();
  const talk = useContext(ItemTalkContext);
  const corrected = (f: Record<string, string>) => Object.fromEntries(Object.entries(f).map(([k, v]) => [k, v.trim() || null]));
  useEffect(() => {
    onCorrecting?.(initial.id, fields ? corrected(fields) : null);
  }, [fields, initial.id, onCorrecting]);
  useEffect(() => () => onCorrecting?.(initial.id, null), [initial.id, onCorrecting]);
  useEffect(
    () => () => {
      // Closing the card (or its panel) clears its ghost.
      if (previewing) sendPreview({ card_id: initial.id, preview: null });
    },
    [previewing, initial.id],
  );

  const changed = (c: Card) => {
    setLocal({ from: initial, card: c });
    onChanged?.(c);
    sendCardChanged();
  };
  const stopPreview = () => {
    setDescribed(false);
    if (previewing) {
      sendPreview({ card_id: card.id, preview: null });
      setPreviewing(false);
    }
  };

  async function run(fn: () => Promise<Card>) {
    setBusy(true);
    setError(null);
    try {
      changed(await fn());
    } catch (e) {
      setError(detail(e));
    } finally {
      setBusy(false);
    }
  }

  const apply = (fix: number | null = null, withDependents = false) =>
    run(async () => {
      stopPreview();
      const r = await applyCard(card.id, fix, fix == null && !withDependents && fields ? corrected(fields) : undefined, withDependents && (card.dependent_ids ?? []));
      setFields(null);
      if (r.card.status === "applied" && r.card.item_id) sendApplied(r.card.item_id);
      if (r.result && r.result.change.status === "proposed" && r.result.change.routed_to.length) {
        const people = await unwrap(api.GET("/v1/people", { params: { query: { ids: r.result.change.routed_to } } })).catch(() => []);
        const routed = r.result.change.routed_to;
        setRoutedTo(routed.map((id) => people.find((p) => p.user_id === id)?.name ?? "the decider"));
      }
      return r.card;
    });

  const open = card.status === "open";
  // chat-latest-card: a newer card in the chat replaced this one: an open card no longer acts
  // (no Apply, no Discard); an applied one keeps its Undo.
  const replacedBy = card.replaced_by ?? null;
  const live = open && !replacedBy;
  const label = card.may === "propose" ? "Propose" : "Apply";
  const action = isActionPreview(card.preview) ? card.preview : null;
  const correct = card.correct ?? null;
  const shown = correct ? CORRECT_FIELDS.filter((f) => correct.fields.includes(f)) : [];
  const startCorrect = () => setFields(fields ? null : Object.fromEntries(shown.map((f) => [f, correct?.values[f] ?? ""])));
  // qa4-simple-roadmap-41: in the item card's talk, only the flags the change brings.
  const known = (item: string, kind: string, subject: string | null | undefined) => !!talk?.known.has(flagKey(item, kind, subject));
  const red = actionsOnly ? [] : card.flags.flatMap((f) => f.flags.filter((x) => x.state === "red" && !known(f.item_id, x.kind, x.subject)).map((x) => ({ item: f.item_id, ...x })));
  // fix4 qa-simple-roadmap-24: moving a dependency makes no sense once the item is cut, so a
  // cut offers no fixes: its Apply says the dependents stay (their red reasons stay shown
  // above it). fix5-cut-dependents: beside it, "Cut it and its dependents" (only when items
  // wait on it: the card's dependents) cuts them with it as one change.
  const cutting = card.op === "cut";
  const cutsDependents = cutting && open && (card.dependents ?? []).length > 0;
  // qa4-simple-roadmap-41: and no fixes of a broken link the items already had.
  // Each keeps its own index: Apply names the fix by its place in the card's list.
  const stale = (f: Card["fixes"][number]) => typeof f.target.item_id === "string" && typeof f.target.subject === "string" && known(f.target.item_id, "dependency_order", f.target.subject);
  const fixes = cutting ? [] : card.fixes.map((f, n) => ({ ...f, n })).filter((f) => !stale(f));
  // walkc-meeting r2 (5c): every Preview shows in the card; only the item's talk sits on the roadmap's ghost.
  const ghost = previewing && card.preview && !action ? ghostWords(card.preview as ChatPreview, card.item_title ?? "The item", talk ? "On the roadmap" : "After this change") : null;
  // The walk: Apply when no fix makes the card's own change, named by what it does.
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  const applyShown = !actionsOnly || !card.fixes.some((f) => f.op === card.op && same(f.target, card.target));
  const applyLabel =
    // qa4-simple-roadmap-12: "keep the dependents" only when items wait on it.
    cutsDependents
      ? card.may === "propose"
        ? "Propose: cut it, keep the dependents"
        : "Cut it, keep the dependents"
      : actionsOnly && OP_WORDS[card.op]
        ? card.may === "propose"
          ? `Propose: ${OP_WORDS[card.op]}`
          : OP_WORDS[card.op]
        : label;
  const mine = !!me?.name && card.decided_by_name === me.name;

  return (
    <div id={`chat-card-${card.id}`} tabIndex={-1} data-testid="chat-card" data-status={card.status} data-card-id={card.id} data-replaced={replacedBy ? "true" : undefined} className={`flex min-w-0 flex-col gap-2 rounded-xl border border-line p-3 text-text ${replacedBy && open ? "bg-surface2" : "bg-surface"}`}>
      {!actionsOnly && (
        <p className="font-semibold" data-testid="chat-card-summary">
          {card.summary}
        </p>
      )}
      {/* qa4-simple-decide-29: one line per change: no "Item:" line when the summary names the item already. */}
      {!actionsOnly && card.item_title && !card.summary.includes(card.item_title) && (
        <p className="simple-small text-text2">
          Item:{" "}
          {/* build-feature-panel review 6: the card's feature opens the one feature panel. */}
          <button type="button" data-feature={card.item_id ?? card.item_title} className="text-left hover:underline">
            {card.item_title}
          </button>
        </p>
      )}
      {!actionsOnly && changeWords(card) && (
        <p className="simple-small [overflow-wrap:anywhere]" data-testid="chat-card-change">
          <span className="text-text2">Before:</span> {changeWords(card)!.before} → <span className="text-text2">After:</span> {changeWords(card)!.after}
        </p>
      )}
      {open && action?.kind === "decision" && action.proposed_to && (
        <p className="simple-small text-text2" data-testid="chat-card-proposed-to">
          Goes to {action.proposed_to}; they decide
          {action.not_to ? ` (not ${action.not_to}: the page's decider confirms a commenter's decision)` : ""}
        </p>
      )}
      {red.length > 0 && (
        <ul className="flex flex-col gap-1" data-testid="chat-card-flags">
          {red.map((f, n) => (
            // fix4 qa-simple-roadmap-26: each reason in the warning style (the item card's callout).
            <li key={n} className="simple-small rounded-lg bg-crit-bg px-2 py-1 text-crit before:content-['⚠_']" data-testid="chat-card-flag">
              {f.reason}
            </li>
          ))}
        </ul>
      )}
      {FLOW_OPS.has(card.op) && (
        <div className="flex flex-col gap-2">
          {card.flow ? (
            <button type="button" aria-label={`Open the flow for ${card.flow.title}`} aria-expanded={wide} onClick={() => setWide((w) => !w)} className="self-start rounded-md border border-line bg-surface p-1" data-testid="flow-thumb">
              <FlowThumb flow={card.flow} />
            </button>
          ) : (
            <span className="self-start rounded-md border border-dashed border-line px-2 py-1 text-text2 simple-small" data-testid="flow-none">
              No flow yet
            </span>
          )}
          {wide && card.flow && <FlowDetail flow={card.flow} />}
        </div>
      )}
      {open && described && action && (
        <div className="flex min-w-0 flex-col gap-0.5 rounded-lg border border-dashed border-line px-2 py-1.5 [overflow-wrap:anywhere]" data-testid="chat-card-preview" data-kind={action.kind}>
          {actionWords(action).map((line, n) => (
            <p key={n} className={n === 0 ? "simple-small text-text" : "simple-small text-text2"}>
              {line}
            </p>
          ))}
        </div>
      )}
      {open && ghost && (
        <p className="simple-small rounded-lg border border-dashed border-line px-2 py-1.5 [overflow-wrap:anywhere]" data-testid="chat-card-preview" data-kind={(card.preview as ChatPreview)?.kind}>
          {ghost}
        </p>
      )}
      {live && fixes.length > 0 && (
        <div className="flex min-w-0 flex-wrap gap-2" role="group" aria-label="Fixes">
          {fixes.map((f) => (
            <button key={f.n} type="button" className="simple-button simple-button-wrap" disabled={busy || !card.may} onClick={() => void apply(f.n)} data-testid="chat-card-fix">
              {card.may === "propose" ? `Propose: ${f.label}` : f.label}
            </button>
          ))}
        </div>
      )}
      {live && fields && (
        <div className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-2" role="group" aria-label="Correct the change" data-testid="chat-card-correct">
          {shown.map((f) => (
            <label key={f} className="flex min-w-0 flex-col gap-1 simple-small text-text2">
              {FIELD_LABELS[f]}
              <input
                type={f === "start_date" || f === "end_date" ? "date" : "text"}
                value={fields[f] ?? ""}
                onChange={(e) => setFields({ ...fields, [f]: e.target.value })}
                className="h-10 min-w-0 rounded-lg border border-line-strong bg-surface px-2 text-text"
              />
            </label>
          ))}
        </div>
      )}
      {card.elsewhere && (
        // meeting-changes-only-its-agenda: an item the meeting does not review is only sent to its owner.
        <p className="simple-small text-warn" data-testid="chat-card-elsewhere">
          {card.elsewhere}
        </p>
      )}
      {open && !card.elsewhere && card.may === "propose" && (card.asks ?? []).length > 0 && (
        // walkc-meeting: who Propose asks, said before Propose; in a meeting its deciders,
        // and when nobody in it may decide, that it goes outside the meeting.
        <p className={`simple-small ${card.asks_outside ? "text-warn" : "text-text2"}`} data-testid="chat-card-asks">
          {card.asks_outside
            ? `Nobody in this meeting may decide this. Propose asks ${listWords(card.asks ?? [])}, who ${(card.asks ?? []).length === 1 ? "is" : "are"} not here.`
            : `Propose asks ${listWords(card.asks ?? [])} to decide.`}
        </p>
      )}
      {open && cutsDependents && card.may_with_dependents === "propose" && (card.asks_with_dependents ?? []).length > 0 && (
        // walkc-meeting review: the cut with its dependents asks whoever decides every item it cuts.
        <p className={`simple-small ${card.asks_with_dependents_outside ? "text-warn" : "text-text2"}`} data-testid="chat-card-asks-dependents">
          {card.asks_with_dependents_outside
            ? `Nobody in this meeting may decide the cut with its dependents. It asks ${listWords(card.asks_with_dependents ?? [])}, who ${(card.asks_with_dependents ?? []).length === 1 ? "is" : "are"} not here.`
            : `Cutting it with its dependents asks ${listWords(card.asks_with_dependents ?? [])} to decide.`}
        </p>
      )}
      {live ? (
        // qa-simple-roadmap-45: on a phone this row can hold four buttons (Preview, Apply,
        // Discard, Correct); a plain wrap leaves the last one alone on its own row, so narrow
        // widths lay them out as a balanced 2-column grid, wide widths keep the flex row.
        // fix4 qa-simple-roadmap-25: wider, one row that never wraps one button alone.
        // fix5-cut-dependents: a cut's two buttons (and Preview, Reject) are a 2-column grid
        // at every width, so neither long label is cut short.
        <div ref={actions} className={`grid grid-cols-2 items-center gap-2 [&>button]:min-w-0 ${cutsDependents ? "" : "sm:flex sm:flex-nowrap"}`}>
          {action ? (
            <button type="button" className="simple-button" aria-pressed={described} aria-expanded={described} disabled={busy} onClick={() => setDescribed((d) => !d)}>
              {described ? "Hide preview" : "Preview"}
            </button>
          ) : (
            card.preview && (
              <button
                type="button"
                className="simple-button"
                aria-pressed={previewing}
                disabled={busy}
                onClick={() => {
                  const next = !previewing;
                  sendPreview({ card_id: card.id, preview: next ? (card.preview as Exclude<Card["preview"], ActionPreview>) : null });
                  setPreviewing(next);
                }}
              >
                {previewing ? "Hide preview" : "Preview"}
              </button>
            )
          )}
          {applyShown && (
            <button type="button" className={`simple-button simple-button-primary${cutsDependents ? " simple-button-wrap" : ""}`} disabled={busy || !card.may} onClick={() => void apply()} title={card.why_not ?? undefined}>
              {applyLabel}
            </button>
          )}
          {cutsDependents && (
            // Review major: it applies only when the reader decides every item it cuts.
            <button type="button" className="simple-button simple-button-wrap" disabled={busy || !card.may_with_dependents} onClick={() => void apply(null, true)} title={card.why_not ?? undefined}>
              {card.may_with_dependents === "propose" ? "Propose: cut it and its dependents" : "Cut it and its dependents"}
            </button>
          )}
          {!actionsOnly && (
            <button
              type="button"
              className="simple-button"
              disabled={busy || !card.may}
              onClick={() =>
                void run(async () => {
                  stopPreview();
                  return discardCard(card.id);
                })
              }
            >
              {correct ? "Reject" : "Discard"}
            </button>
          )}
          {correct && shown.length > 0 && (
            <button type="button" className="simple-button" aria-expanded={!!fields} disabled={busy || !card.may} onClick={startCorrect}>
              {fields ? "Undo my edits" : "Change it…"}
            </button>
          )}
        </div>
      ) : open ? null : (
        <div className="flex flex-wrap items-center gap-2" data-testid="chat-card-outcome">
          <span className="simple-small">
            {/* fix4 qa-simple-roadmap-27: the reader's own change says "you". */}
            {card.status === "applied" && `Applied by ${mine ? "you" : (card.decided_by_name ?? "someone")}`}
            {card.status === "proposed" &&
              (action?.kind === "decision" && action.proposed_to
                ? proposedWords(action.proposed_to)
                : `Proposed to ${routedTo?.length ? listWords(routedTo) : card.asks?.length ? listWords(card.asks) : "the decider"} by ${mine ? "you" : (card.decided_by_name ?? "someone")}`)}
            {/* walkc-meeting r2 (5e): a proposal declined since says so, and by whom. */}
            {card.status === "declined" && `Declined by ${mine ? "you" : (card.decided_by_name ?? "the decider")}: nothing changed`}
            {card.status === "discarded" && (correct ? "Rejected: nothing changed" : "Discarded: nothing changed")}
            {card.status === "undone" && "Undone"}
          </span>
          {card.decision_id && card.status === "applied" && (
            <span className="simple-tag" data-testid="chat-card-decision">
              Recorded as a meeting decision
            </span>
          )}
          {/* qa4-simple-decide-1: only a reader the card's Apply rule lets change it undoes it. */}
          {card.status === "applied" && card.can_undo && (
            <button type="button" className="simple-button" disabled={busy} onClick={() => void run(() => undoCard(card.id))}>
              Undo this change
            </button>
          )}
        </div>
      )}
      {replacedBy && (
        <p className="simple-small text-text2" data-testid="chat-card-replaced">
          Replaced by a newer card.{" "}
          <a
            href={`#chat-card-${replacedBy}`}
            className="text-accent-ink underline"
            onClick={(e) => {
              const newer = document.getElementById(`chat-card-${replacedBy}`);
              if (!newer) return;
              e.preventDefault();
              newer.scrollIntoView({ block: "center" });
              newer.focus({ preventScroll: true });
            }}
          >
            Go to the newer card
          </a>
        </p>
      )}
      {live && !card.may && card.why_not && (
        <p className="simple-small text-text2" data-testid="chat-card-why-not">
          {card.why_not}
        </p>
      )}
      {error && (
        <p role="alert" className="simple-small text-crit">
          {error}
        </p>
      )}
    </div>
  );
}
