"use client";

import { useEffect, useState } from "react";

import { FlowDetail, FlowThumb } from "@/components/simple/Flow";
import { api, unwrap } from "@/lib/api/client";
import { applyCard, discardCard, FLOW_OPS, isActionPreview, sendPreview, undoCard, type ActionPreview, type ChatCard as Card } from "@/lib/api/simple-chat";
import { errorMessage } from "@/lib/use-query";

const detail = (e: unknown) => errorMessage(e).replace(/ \(\d{3}\)$/, "");

const proposedWords = (to: string) => `Proposed to ${to}; they decide`;

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
  }
}

/**
 * One change card (Simple S9): what it changes, the constraint check as if applied (red, with
 * each one-line reason), its one-click fixes, and Preview / Apply (or Propose) / Discard by the
 * reader's own rights (`may`; null: disabled, with why). Preview ghosts the change on the
 * roadmap (the "simple:preview" event); after Apply the card says who applied or proposed it,
 * with Undo while applied.
 */
export function ChatCard({ card: initial, onChanged }: { card: Card; onChanged?: (card: Card) => void }) {
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
      const r = await applyCard(card.id, fix);
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
  const red = card.flags.flatMap((f) => f.flags.filter((x) => x.state === "red").map((x) => ({ item: f.item_id, ...x })));

  return (
    <div data-testid="chat-card" data-status={card.status} data-card-id={card.id} className="flex min-w-0 flex-col gap-2 rounded-xl border border-line bg-surface p-3 text-text">
      <p className="font-semibold" data-testid="chat-card-summary">
        {card.summary}
      </p>
      {card.item_title && <p className="simple-small text-text2">Item: {card.item_title}</p>}
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
      {open ? (
        <div className="flex flex-wrap items-center gap-2">
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
            Discard
          </button>
          {!card.may && card.why_not && (
            <span className="simple-small text-text2" data-testid="chat-card-why-not">
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
            {card.status === "discarded" && "Discarded: nothing changed"}
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
