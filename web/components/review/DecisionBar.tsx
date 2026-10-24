"use client";

import { useEffect, useState, type ReactNode } from "react";

import { Button, Icon, Sheet } from "@/components/ds";
import { INPUT } from "@/components/ui";
import { api, ApiError, unwrap, type Schemas } from "@/lib/api/client";
import { errorMessage } from "@/lib/use-query";

type Gate = Schemas["Gate"];
type ConsoleAnswer = Schemas["ConsoleAnswer"];

/** A staged change in the bar: removing it undoes it. */
export type StagedChip = { key: string; label: string; onRemove?: () => Promise<void> | void };

export const NOTE_MAX = 2000;
export const CONSOLE_HELD_LINE = "Approved in the console: blocking problems are open: fix or waive them, then confirm";

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** The gate's reason, as the Approve button's tooltip and the line beside it ("1 blocking problem left"). */
export function gateReason(gate: Gate | null | undefined): string | null {
  if (!gate || gate.open) return null;
  return `${plural(gate.blocking_open + gate.file_problems, "blocking problem")} left`;
}

/** The phone's collapsed bar is one line: "N changes · Approve". */
function usePhone(): boolean {
  const [phone, setPhone] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 600px)");
    const on = () => setPhone(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return phone;
}

/**
 * The review screens' shared bottom bar (C7; D1 and F4 reuse it): the tally, the staged
 * changes as removable chips (each removal is an Undo), the note to the agents (D8's PUT
 * …/note), Send back to agents (with at least one change or a note) and Approve / Approve with
 * N edits, disabled while the approve gate is closed with its reason. A console approval held
 * by open blocking problems reads Confirm (decide "confirm", held to the same gate). Every
 * decision carries the draft's revision; a 409 review_changed shows a Reload line. On a phone
 * it collapses to "N changes · Approve" with a sheet for the rest.
 */
export function DecisionBar({
  runId,
  checkpointId,
  tally,
  chips,
  changes,
  edits,
  gate,
  console: answer,
  revision,
  savedNote,
  canDecide,
  canNote,
  onDecided,
  onReload,
  title = "Feature set",
  approveBlocked = null,
  sendBackSummary = null,
  decidedBy = null,
}: {
  runId: string;
  checkpointId: string;
  tally: ReactNode;
  chips: StagedChip[];
  /** Changes a send-back carries (rows changed and staged actions). */
  changes: number;
  /** Rows a person changed: "Approve with N edits". */
  edits: number;
  gate: Gate | null;
  console?: ConsoleAnswer | null;
  revision: number | null;
  savedNote: string | null;
  /** Approvers and owners decide; commenters and viewers read the tally only. */
  canDecide: boolean;
  canNote: boolean;
  onDecided: (decision: "approved" | "changes_requested" | "confirm") => void;
  onReload: () => Promise<void>;
  /** The screen's name, in the phone's decide sheet ("Decide: Roadmap items"). */
  title?: string;
  /** D7: why Approve waits besides the gate ("Split needs the agents"); Send back stays. */
  approveBlocked?: string | null;
  /** D4: what a send-back carries ("2 entries · 7 unchanged items"): Send back confirms it first. */
  sendBackSummary?: string | null;
  /** Shown instead of the buttons to a reader who cannot decide ("An approver decides"). */
  decidedBy?: string | null;
}) {
  const phone = usePhone();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState(savedNote ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [changed, setChanged] = useState<string | null>(null);
  const held = answer?.needs === "confirm" && answer.verdict === "MERGE";
  const blocked = [gateReason(gate), approveBlocked].filter(Boolean).join(" · ") || null;
  const [confirming, setConfirming] = useState(false);
  const tooLong = note.length > NOTE_MAX;
  const canSend = (changes > 0 || !!note.trim()) && !tooLong;
  const approveLabel = held ? "Confirm" : edits > 0 ? `Approve with ${plural(edits, "edit")}` : "Approve";

  // Saving one's own note bumps the draft's revision: the decision that follows expects that
  // revision, not the one the screen loaded, or it is refused as "the review changed" by its
  // own note. Only our own bump (one past what we read) is taken; anyone else's still refuses.
  const [bumped, setBumped] = useState<{ from: number | null; to: number } | null>(null);
  const expected = bumped && bumped.from === revision ? bumped.to : revision;

  async function saveNote() {
    if (!canNote || tooLong || (note.trim() || null) === (savedNote?.trim() || null)) return;
    const known = expected;
    await unwrap(
      api.PUT("/v1/runs/{run_id}/checkpoints/{checkpoint_id}/note", {
        params: { path: { run_id: runId, checkpoint_id: checkpointId } },
        body: { note: note.trim() ? note : null },
      }),
    )
      .then((r) => {
        if (known != null && r.revision === known + 1) setBumped({ from: revision, to: r.revision });
      })
      .catch((e) => setError(errorMessage(e)));
  }

  async function decide(decision: "approved" | "changes_requested" | "confirm") {
    setBusy(true);
    setError(null);
    setChanged(null);
    try {
      await saveNote();
      await unwrap(
        api.POST("/v1/runs/{run_id}/checkpoints/{checkpoint_id}/decide", {
          params: { path: { run_id: runId, checkpoint_id: checkpointId } },
          body: { decision, note: note.trim() || null, expected_revision: expected },
        }),
      );
      setOpen(false);
      setConfirming(false);
      onDecided(decision);
    } catch (e) {
      if (e instanceof ApiError && e.code === "review_changed") setChanged(e.message);
      else setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const body = (
    <div className="flex min-w-0 flex-col gap-2">
      <p className="text-sm font-medium" data-testid="decision-tally">
        {tally}
      </p>
      {chips.length > 0 && (
        <ul className="flex min-w-0 flex-wrap gap-1.5" aria-label="Staged changes" data-testid="staged-chips">
          {chips.map((c) => (
            <li key={c.key} className="flex max-w-full items-center gap-1 rounded-full bg-accent-soft py-0.5 pr-1 pl-2.5 text-sm text-accent-ink" data-testid="staged-chip">
              <span className="min-w-0 truncate">{c.label}</span>
              {c.onRemove && canDecide && (
                <button
                  type="button"
                  aria-label={`Undo ${c.label}`}
                  title="Undo"
                  onClick={() => void c.onRemove!()}
                  className="grid size-6 flex-none place-items-center rounded-full hover:bg-surface"
                >
                  <Icon name="x" size={16} />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {held && (
        <p className="rounded-button bg-warn-bg px-3 py-2 text-sm text-warn" data-testid="console-held">
          {CONSOLE_HELD_LINE}
        </p>
      )}
      {changed && (
        <div className="flex flex-wrap items-center gap-2 rounded-button bg-warn-bg px-3 py-2 text-sm text-warn" role="alert" data-testid="review-changed">
          <span className="min-w-0 flex-1 break-words">{changed}</span>
          <Button className="h-8 px-2.5 text-sm" onClick={() => void onReload().then(() => setChanged(null))}>
            Reload
          </Button>
        </div>
      )}
      {error && (
        <p className="text-sm text-crit" role="alert">
          {error}
        </p>
      )}
      {canDecide && (
        <div className="flex min-w-0 flex-wrap items-end gap-2">
          <label className="min-w-[220px] flex-1 text-sm text-text2">
            <span className="sr-only">Note to the agents</span>
            <textarea
              aria-label="Note to the agents"
              placeholder="Note to the agents (optional)"
              value={note}
              rows={1}
              maxLength={NOTE_MAX + 200}
              onChange={(e) => setNote(e.target.value)}
              onBlur={() => void saveNote()}
              className={`${INPUT} min-h-9 placeholder:text-text2`}
            />
            {tooLong && <span className="text-crit">At most {NOTE_MAX} characters</span>}
          </label>
          <Button
            disabled={busy || !canSend}
            title={canSend ? undefined : "Change a row or write a note to send back"}
            onClick={() => (sendBackSummary ? setConfirming(true) : void decide("changes_requested"))}
          >
            Send back to agents
          </Button>
          <span className="flex flex-wrap items-center gap-2">
            {blocked && (
              <span className="text-sm text-crit" data-testid="approve-blocked">
                {blocked}
              </span>
            )}
            <Button variant="solid" icon="check" disabled={busy || !!blocked} title={blocked ?? undefined} onClick={() => void decide(held ? "confirm" : "approved")}>
              {approveLabel}
            </Button>
          </span>
        </div>
      )}
      {!canDecide && decidedBy && (
        <p className="text-sm text-text2" data-testid="decided-by">
          {decidedBy}
        </p>
      )}
    </div>
  );

  // Outside the sticky bar: its stacking context would put the sheet under the app's rail.
  const confirmSheet = (
    <Sheet open={confirming} title="Send back to agents" onClose={() => setConfirming(false)} testId="sheet-send-back">
      <div className="flex flex-col gap-3 px-4 py-3">
        <p className="text-sm">{sendBackSummary}</p>
        {note.trim() && <p className="text-sm text-text2">With your note to the agents.</p>}
        <span className="flex gap-2">
          <Button variant="solid" disabled={busy} onClick={() => void decide("changes_requested")}>
            Send back
          </Button>
          <Button onClick={() => setConfirming(false)}>Cancel</Button>
        </span>
      </div>
    </Sheet>
  );

  if (phone) {
    return (
      <>
        {confirmSheet}
        <div className="sticky bottom-[68px] z-20 -mx-2.5 border-t border-line bg-surface px-2.5 py-2" data-testid="decision-bar" data-collapsed="true">
          <Button className="w-full justify-center" variant={canDecide ? "solid" : "secondary"} onClick={() => setOpen(true)}>
            {canDecide ? `${plural(changes, "change")} · ${held ? "Confirm" : "Approve"}` : `${plural(changes, "change")} · Details`}
          </Button>
          <Sheet open={open} title={`Decide: ${title}`} onClose={() => setOpen(false)} testId="sheet-decide">
            <div className="px-4 py-3">{body}</div>
          </Sheet>
        </div>
      </>
    );
  }
  return (
    <>
      {confirmSheet}
      <div className="sticky bottom-0 z-20 border-t border-line bg-surface px-1 py-3 shadow-panel" data-testid="decision-bar">
        {body}
      </div>
    </>
  );
}
