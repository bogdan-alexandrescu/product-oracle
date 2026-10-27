"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ds";
import { setPanelOpen } from "@/components/hop/open-state";
import { useScreenSubject } from "@/lib/screen-subject";

import { shortDay, sourceWord, storedDates, type Change, type Flag, type Item } from "./_lib";

/** What a change asks the engine, built by the page and sent through `act`. */
export type Act = (what: string, body: Parameters<typeof import("./_lib").propose>[0]) => Promise<void>;

const FIX_WORDS: Record<Flag["fixes"][number], string> = {
  shift_dependents: "Move the dependents",
  move_dependency: "Move the dependency",
  accept_risk: "Accept as risk",
};

/** D14's one-click fixes of one flag: move the dependents, move the dependency, or accept
 * the risk with a note (the flag then stays amber). */
export function FixButtons({ item, flag, items, act, canChange, inline = false }: { item: Item; flag: Flag; items: Map<string, Item>; act: Act; canChange: boolean; inline?: boolean }) {
  const [note, setNote] = useState<string | null>(null);
  if (!canChange) return null;
  const dep = flag.subject ? items.get(flag.subject) : undefined;
  const fix = (kind: "shift_dependents" | "move_dependency") => {
    if (!dep) return;
    void act(kind === "shift_dependents" ? `Moved what depends on '${dep.title}'` : `Moved '${dep.title}'`, {
      op: kind,
      target: { item_id: item.id, subject: dep.id },
      before: { [item.id]: storedDates(item), [dep.id]: storedDates(dep) },
      after: {},
    });
  };
  if (note !== null)
    return (
      <form
        className={inline ? "flex items-center gap-1.5" : "mt-1 flex flex-wrap items-center gap-2"}
        onSubmit={(e) => {
          e.preventDefault();
          if (!note.trim()) return;
          void act("Accepted as a risk", {
            op: "accept_risk",
            target: { item_id: item.id, flag: flag.kind, subject: flag.subject ?? null },
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
        <Button type="submit" variant="solid" className={inline ? "!h-6 !px-2 !text-xs" : ""}>
          Save the risk
        </Button>
        <Button variant="ghost" className={inline ? "!h-6 !px-2 !text-xs" : ""} onClick={() => setNote(null)}>
          Cancel
        </Button>
      </form>
    );
  return (
    <div className={inline ? "flex gap-1.5" : "mt-1 flex flex-wrap gap-1.5"} data-testid="fixes">
      {flag.fixes.map((f) =>
        f === "accept_risk" ? (
          <Button key={f} className={inline ? "!h-6 !px-2 !text-xs" : ""} onClick={() => setNote("")}>
            {FIX_WORDS[f]}
          </Button>
        ) : dep ? (
          <Button key={f} className={inline ? "!h-6 !px-2 !text-xs" : ""} onClick={() => fix(f)}>
            {FIX_WORDS[f]}
          </Button>
        ) : null,
      )}
    </div>
  );
}

/** One flag: its one-line reason, red or amber (an accepted risk, with its note). */
export function FlagLine({ flag }: { flag: Flag }) {
  return (
    <p data-testid="flag-reason" data-state={flag.state} className={`text-sm ${flag.state === "red" ? "text-crit" : "text-warn"}`}>
      {flag.state === "red" ? "⚠ " : "Accepted risk: "}
      {flag.reason}
      {flag.risk_note && <span className="text-text2"> · “{flag.risk_note}”</span>}
    </p>
  );
}

/** The red callout by a broken bar, inside its own row: its one-line reason and its
 * one-click fixes (on a phone, the reason; the fixes are on the item's sheet). */
export function Callout({ item, flag, items, act, canChange, x, y, h, compact }: { item: Item; flag: Flag; items: Map<string, Item>; act: Act; canChange: boolean; x: number; y: number; h: number; compact: boolean }) {
  return (
    <div
      data-testid="broken-callout"
      data-item={item.key}
      style={{ left: Math.max(4, x), top: y + 3, height: h - 6 }}
      className="absolute z-10 flex items-center gap-2 rounded-lg border border-crit bg-crit-bg px-2 whitespace-nowrap"
    >
      <span className={`truncate text-sm text-crit ${compact ? "max-w-[220px]" : "max-w-[360px]"}`} title={flag.reason}>
        ⚠ {flag.reason}
      </span>
      {!compact && <FixButtons item={item} flag={flag} items={items} act={act} canChange={canChange} inline />}
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
}: {
  item: Item;
  canAct: boolean;
  onAccept: () => void;
  onEdit: (start: string, end: string) => void;
  onDismiss: () => void;
  onClose: () => void;
  style: React.CSSProperties;
}) {
  const s = item.suggestion!;
  const [editing, setEditing] = useState(false);
  const [start, setStart] = useState(s.start_date);
  const [end, setEnd] = useState(s.end_date);
  return (
    <div role="dialog" aria-label="Oracle's date suggestion" data-testid="suggestion-popover" style={style} className="absolute z-30 w-[340px] max-w-[92vw] rounded-xl border border-line bg-surface p-3 shadow-tip">
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
            <input type="date" value={start} onChange={(e) => setStart(e.target.value)} className="block h-8 rounded-lg border border-line-strong bg-surface px-2 text-sm text-text" />
          </label>
          <label className="text-xs text-text2">
            End
            <input type="date" value={end} min={start} onChange={(e) => setEnd(e.target.value)} className="block h-8 rounded-lg border border-line-strong bg-surface px-2 text-sm text-text" />
          </label>
          <Button type="submit" variant="solid">
            Save dates
          </Button>
        </form>
      ) : (
        canAct && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            <Button onClick={onAccept}>{s.can_decide ? "Accept" : "Propose these dates"}</Button>
            <Button onClick={() => setEditing(true)}>Edit dates</Button>
            {s.can_decide && (
              <Button variant="ghost" onClick={onDismiss}>
                Dismiss
              </Button>
            )}
          </div>
        )
      )}
      <button type="button" aria-label="Close" onClick={onClose} className="absolute top-2 right-2 h-6 w-6 rounded text-text2 hover:bg-surface2">
        ×
      </button>
    </div>
  );
}

function names(ids: string[], items: Map<string, Item>): string {
  const t = ids.map((id) => items.get(id)?.title).filter(Boolean);
  return t.length ? t.join(", ") : "Nothing";
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
};

export const opWords = (op: string): string => OP_WORDS[op] ?? op.replace(/_/g, " ");

/** A proposal's flow thumbnail (S10 draws the flows): opens the flow by widening the card. */
function FlowThumb({ onOpen }: { onOpen: () => void }) {
  return (
    <button type="button" data-testid="flow-thumb" aria-label="Open the flow" onClick={onOpen} className="flex h-9 w-12 flex-none items-center justify-center rounded border border-line bg-surface2">
      <svg width="34" height="20" viewBox="0 0 34 20" aria-hidden>
        <rect x="1" y="6" width="8" height="8" rx="2" fill="none" stroke="var(--line-strong)" />
        <rect x="13" y="6" width="8" height="8" rx="2" fill="none" stroke="var(--line-strong)" />
        <rect x="25" y="6" width="8" height="8" rx="2" fill="none" stroke="var(--line-strong)" />
        <path d="M9 10 H13 M21 10 H25" stroke="var(--line-strong)" />
      </svg>
    </button>
  );
}

/**
 * D8 as amended: a floating card by the bar (phones: a bottom sheet) with the item's
 * outcome, owner, dates and their source, status, confidence, dependencies, top 3 reasons,
 * open decisions, the proposals on it, "Open the detailed view" and Ask Oracle.
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
}: {
  item: Item;
  items: Map<string, Item>;
  proposals: Change[];
  phone: boolean;
  style: React.CSSProperties;
  act: Act;
  canChange: boolean;
  onDecide: (c: Change, how: "accept" | "decline") => void;
  onClose: () => void;
}) {
  const [wide, setWide] = useState<Change | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useScreenSubject({ kind: "roadmap_item", subject: { item_id: item.id, key: item.key } }, item.title);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    ref.current?.focus();
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const dates = item.estimated
    ? `${shortDay(item.start.date)} – ${shortDay(item.end.date)} · estimated (the ${item.horizon} window)`
    : `${shortDay(item.start.date)} – ${shortDay(item.end.date)} · ${sourceWord(item.source)}`;
  const place = phone
    ? "fixed inset-x-0 bottom-0 z-50 max-h-[85dvh] rounded-t-2xl"
    : `absolute z-40 rounded-xl ${wide ? "w-[760px]" : "w-[380px]"}`;
  return (
    <div
      ref={ref}
      tabIndex={-1}
      role="dialog"
      aria-label={item.title}
      data-testid="floating-card"
      data-sheet={phone ? "bottom" : "float"}
      data-wide={wide ? "true" : "false"}
      style={phone ? undefined : style}
      className={`${place} max-w-[calc(100vw-16px)] overflow-y-auto border border-line bg-surface p-4 shadow-tip outline-none`}
    >
      <div className="flex items-start gap-2">
        <h2 className="flex-1 text-lg leading-snug font-semibold">{item.title}</h2>
        <button type="button" aria-label="Close" onClick={onClose} className="h-7 w-7 flex-none rounded text-text2 hover:bg-surface2">
          ×
        </button>
      </div>
      <div className={wide && !phone ? "grid grid-cols-2 gap-4" : ""}>
        <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-[15px]">
          <dt className="text-text2">Outcome</dt>
          <dd data-testid="card-outcome">{item.outcome ?? <span className="text-text2">Not written yet</span>}</dd>
          <dt className="text-text2">Owner</dt>
          <dd data-testid="card-owner">{item.owner?.name ?? <span className="text-text2">No owner yet</span>}</dd>
          <dt className="text-text2">Dates</dt>
          <dd data-testid="card-dates">{dates}</dd>
          <dt className="text-text2">Status</dt>
          <dd data-testid="card-status">{item.status.replace("_", " ")}</dd>
          <dt className="text-text2">Confidence</dt>
          <dd>{item.confidence ?? "Not rated"}</dd>
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
                  {f.state === "red" && <FixButtons item={item} flag={f} items={items} act={act} canChange={canChange} />}
                </div>
              ))}
            </section>
          )}
          <section className="mt-3">
            <h3 className="text-xs font-semibold tracking-wide text-text2 uppercase">Why</h3>
            {item.reasons.length ? (
              <ul className="mt-1 list-disc pl-5 text-[15px]" data-testid="card-reasons">
                {item.reasons.slice(0, 3).map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-text2">No reasons on record yet.</p>
            )}
          </section>
          <section className="mt-3">
            <h3 className="text-xs font-semibold tracking-wide text-text2 uppercase">Open decisions</h3>
            {item.open_decisions.length ? (
              <ul className="mt-1 text-[15px]" data-testid="card-decisions">
                {item.open_decisions.map((d) => (
                  <li key={d.id}>
                    <Link href={`/company/decisions?d=${d.id}`} className="text-accent-ink hover:underline">
                      D-{d.number}
                    </Link>{" "}
                    {d.title}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-text2">None open.</p>
            )}
          </section>
          <section className="mt-3">
            <h3 className="text-xs font-semibold tracking-wide text-text2 uppercase">Proposals on it</h3>
            {proposals.length ? (
              <ul className="mt-1 space-y-2" data-testid="card-proposals">
                {proposals.map((c) => (
                  <li key={c.id} className="flex items-center gap-2 text-[15px]">
                    <FlowThumb onOpen={() => setWide(wide?.id === c.id ? null : c)} />
                    <span className="min-w-0 flex-1">
                      {opWords(c.op)} · <span className="text-text2">{c.by_name}</span>
                    </span>
                    {c.can_decide && (
                      <>
                        <Button onClick={() => onDecide(c, "accept")}>Accept</Button>
                        <Button variant="ghost" onClick={() => onDecide(c, "decline")}>
                          Decline
                        </Button>
                      </>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-text2">None waiting.</p>
            )}
          </section>
        </div>
        {wide && (
          <section data-testid="flow-view" className={`mt-3 rounded-lg border border-dashed border-line-strong p-4 ${phone ? "" : "col-span-2"}`}>
            <h3 className="font-semibold">The flow and the screen it touches</h3>
            <p className="mt-1 text-sm text-text2" data-testid="flow-empty">
              No flow yet: Oracle has not drawn a user flow or a wireframe for this proposal.
            </p>
            <Button variant="ghost" className="mt-2" onClick={() => setWide(null)}>
              Close the flow
            </Button>
          </section>
        )}
      </div>
      <div className="mt-4 flex flex-wrap gap-2 border-t border-line pt-3">
        <Link href={`/plan?item=${encodeURIComponent(item.key)}`} className="inline-flex h-8 items-center rounded-lg border border-line-strong px-3 text-sm font-semibold hover:bg-surface2">
          Open the detailed view
        </Link>
        <Button variant="ghost" onClick={() => setPanelOpen(true)}>
          Ask Oracle
        </Button>
      </div>
    </div>
  );
}
