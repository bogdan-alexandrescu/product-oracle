"use client";

import { useEffect, useState } from "react";

import { spanWords } from "@/app/simple/roadmap/_lib";
import { FlowDetail, FlowThumb } from "@/components/simple/Flow";
import { api, unwrap } from "@/lib/api/client";
import { applyCard, CORRECT_FIELDS, discardCard, FLOW_OPS, isActionPreview, sendApplied, sendCardChanged, sendPreview, undoCard, type ActionPreview, type ChatCard as Card } from "@/lib/api/simple-chat";
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
  return card.change_words ?? null;
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
 * with Undo while applied.
 */
export function ChatCard({
  card: initial,
  onChanged,
  onCorrecting,
}: {
  card: Card;
  onChanged?: (card: Card) => void;
  /** roadmap-talk: the values typed into this card's open Correct form (null: closed), for its line's Apply all. */
  onCorrecting?: (cardId: string, values: Record<string, string | null> | null) => void;
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

  const apply = (fix: number | null = null) =>
    run(async () => {
      stopPreview();
      const r = await applyCard(card.id, fix, fix == null && fields ? corrected(fields) : undefined);
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
  const label = card.may === "propose" ? "Propose" : "Apply";
  const action = isActionPreview(card.preview) ? card.preview : null;
  const correct = card.correct ?? null;
  const shown = correct ? CORRECT_FIELDS.filter((f) => correct.fields.includes(f)) : [];
  const startCorrect = () => setFields(fields ? null : Object.fromEntries(shown.map((f) => [f, correct?.values[f] ?? ""])));
  const red = card.flags.flatMap((f) => f.flags.filter((x) => x.state === "red").map((x) => ({ item: f.item_id, ...x })));

  return (
    <div data-testid="chat-card" data-status={card.status} data-card-id={card.id} className="flex min-w-0 flex-col gap-2 rounded-xl border border-line bg-surface p-3 text-text">
      <p className="font-semibold" data-testid="chat-card-summary">
        {card.summary}
      </p>
      {card.item_title && <p className="simple-small text-text2">Item: {card.item_title}</p>}
      {changeWords(card) && (
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
            <li key={n} className="simple-small text-crit" data-testid="chat-card-flag">
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
      {open && card.fixes.length > 0 && (
        <div className="flex min-w-0 flex-wrap gap-2" role="group" aria-label="Fixes">
          {card.fixes.map((f, n) => (
            <button key={n} type="button" className="simple-button simple-button-wrap" disabled={busy || !card.may} onClick={() => void apply(n)} data-testid="chat-card-fix">
              {card.may === "propose" ? `Propose: ${f.label}` : f.label}
            </button>
          ))}
        </div>
      )}
      {open && fields && (
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
      {open ? (
        // qa-simple-roadmap-45: on a phone this row can hold four buttons (Preview, Apply,
        // Discard, Correct); a plain wrap leaves the last one alone on its own row, so narrow
        // widths lay them out as a balanced 2-column grid, wide widths keep the flex row.
        <div className="grid grid-cols-2 items-center gap-2 sm:flex sm:flex-wrap">
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
          <button type="button" className="simple-button simple-button-primary" disabled={busy || !card.may} onClick={() => void apply()} title={card.why_not ?? undefined}>
            {label}
          </button>
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
          {correct && shown.length > 0 && (
            <button type="button" className="simple-button" aria-expanded={!!fields} disabled={busy || !card.may} onClick={startCorrect}>
              {fields ? "Undo my edits" : "Correct"}
            </button>
          )}
          {!card.may && card.why_not && (
            <span className="simple-small text-text2 col-span-2 sm:col-auto" data-testid="chat-card-why-not">
              {card.why_not}
            </span>
          )}
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2" data-testid="chat-card-outcome">
          <span className="simple-small">
            {card.status === "applied" && `Applied by ${card.decided_by_name ?? "someone"}`}
            {card.status === "proposed" &&
              (action?.kind === "decision" && action.proposed_to
                ? proposedWords(action.proposed_to)
                : `Proposed to ${routedTo?.length ? routedTo.join(", ") : "the decider"} by ${card.decided_by_name ?? "someone"}`)}
            {card.status === "discarded" && (correct ? "Rejected: nothing changed" : "Discarded: nothing changed")}
            {card.status === "undone" && "Undone"}
          </span>
          {card.decision_id && card.status === "applied" && (
            <span className="simple-tag" data-testid="chat-card-decision">
              Recorded as a meeting decision
            </span>
          )}
          {card.status === "applied" && (
            <button type="button" className="simple-button" disabled={busy} onClick={() => void run(() => undoCard(card.id))}>
              Undo
            </button>
          )}
        </div>
      )}
      {error && (
        <p role="alert" className="simple-small text-crit">
          {error}
        </p>
      )}
    </div>
  );
}
