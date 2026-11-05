"use client";

import { useState, type CSSProperties } from "react";

import { Button, confirmInPage } from "@/components/ds";
import { ErrorNote } from "@/components/ui";
import { api, unwrap, type Schemas } from "@/lib/api/client";
import { calendarDay } from "@/lib/dates";
import { errorMessage } from "@/lib/use-query";

/**
 * build-runplan RP2 'Meeting step as draft': the review meeting's Roadmap step shows the run's
 * draft roadmap of the PRD, its dated items hatched and marked Draft. Whoever may change things
 * changes an item's dates or leaves it out; Approve these N dates puts the items on the roadmap
 * with their dates (api/oracle/simple/meeting_draft.py).
 */

type Meeting = Schemas["SimpleMeetingOut"];
type Bar = { key: string; title: string; start: string; end: string };

const PHONE_TAP = "max-[600px]:min-h-11";
const cap = (h: string) => (h ? h[0]!.toUpperCase() + h.slice(1) : h);
const DAY = 86_400_000;
const at = (d: string) => Date.parse(`${d.slice(0, 10)}T00:00:00Z`);
const span = (i: Bar) => `${calendarDay(i.start)} – ${calendarDay(i.end)}`;

/** The hatch every draft bar wears. */
export const HATCH: CSSProperties = { backgroundImage: "repeating-linear-gradient(135deg, color-mix(in srgb, var(--accent) 28%, transparent) 0 6px, transparent 6px 12px)", border: "1.5px dashed var(--accent)" };

/** The months from the first item's to the last's, each as wide as its days. */
export function months(bars: Bar[]): { first: number; end: number; cols: { name: string; days: number }[] } {
  const lo = new Date(Math.min(...bars.map((b) => at(b.start))));
  const hi = new Date(Math.max(...bars.map((b) => at(b.end))));
  const cols: { name: string; days: number }[] = [];
  let y = lo.getUTCFullYear();
  let mo = lo.getUTCMonth();
  const first = Date.UTC(y, mo, 1);
  for (;;) {
    const next = Date.UTC(y, mo + 1, 1);
    cols.push({ name: calendarDay(`${y}-${String(mo + 1).padStart(2, "0")}-01`, { month: "short" }), days: (next - Date.UTC(y, mo, 1)) / DAY });
    if (next > hi.getTime()) return { first, end: next, cols };
    mo += 1;
    if (mo === 12) [y, mo] = [y + 1, 0];
  }
}

/** A small timeline: one bar per item over the months, hatched while draft. */
function Bars({ bars, solid, picked, label }: { bars: Bar[]; solid?: boolean; picked?: string | null; label: string }) {
  if (!bars.length) return null;
  const { first, end, cols } = months(bars);
  const x = (d: string, last = false) => ((at(d) + (last ? DAY : 0) - first) / (end - first)) * 100;
  return (
    <div role="img" aria-label={label} className="min-w-0 overflow-hidden">
      <div aria-hidden className="grid border-b border-line text-[13px] text-text2" style={{ gridTemplateColumns: cols.map((c) => `${c.days}fr`).join(" ") }}>
        {cols.map((c, n) => (
          <span key={n} className="truncate border-l border-line px-1.5 py-1 first:border-l-0">{c.name}</span>
        ))}
      </div>
      <div aria-hidden className="relative py-1">
        {bars.map((i) => (
          <div key={i.key} className="relative h-9">
            <div
              data-bar={i.key}
              title={`${i.title}: ${span(i)}${solid ? "" : " (draft, not approved)"}`}
              className={`absolute top-1 flex h-7 items-center overflow-hidden rounded px-2 text-[13px] font-medium whitespace-nowrap ${solid ? "bg-accent text-white" : "text-text"} ${picked === i.key ? "ring-2 ring-[var(--accent)] ring-offset-2 ring-offset-[var(--surface)]" : ""}`}
              style={{ left: `${x(i.start)}%`, width: `${x(i.end, true) - x(i.start)}%`, ...(solid ? {} : HATCH) }}
            >
              <span className="truncate">{i.title}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** What a change of dates did, in words: "Moved X 4 weeks later (draft)". */
export function movedWords(title: string, from: string, to: string): string {
  const days = Math.round((at(to) - at(from)) / DAY);
  if (days !== 0 && days % 7 === 0) {
    const w = Math.abs(days / 7);
    return `Moved ${title} ${w} week${w === 1 ? "" : "s"} ${days > 0 ? "later" : "earlier"} (draft)`;
  }
  return `New dates for ${title} (draft)`;
}

export function DatesForm({ item, busy, onSave, onCancel }: { item: Bar; busy: boolean; onSave: (start: string, end: string) => void; onCancel: () => void }) {
  const [start, setStart] = useState(item.start);
  const [end, setEnd] = useState(item.end);
  const field = "block h-9 rounded-lg border border-line-strong bg-surface px-2 text-base text-text";
  return (
    <form
      aria-label={`Change dates for ${item.title}`}
      className="flex w-full flex-wrap items-end gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (start && end && end >= start) onSave(start, end);
      }}
    >
      <label className="text-sm text-text2">
        Start
        <input type="date" value={start} onChange={(e) => setStart(e.target.value)} className={field} />
      </label>
      <label className="text-sm text-text2">
        End
        <input type="date" value={end} min={start} onChange={(e) => setEnd(e.target.value)} className={field} />
      </label>
      <Button type="submit" variant="primary" className={PHONE_TAP} disabled={busy || !start || !end || end < start}>Save dates</Button>
      <Button type="button" className={PHONE_TAP} onClick={onCancel}>Cancel</Button>
    </form>
  );
}

export function DraftDates({
  m,
  reload,
  roadmap,
  approved,
  onApproved,
}: {
  m: Meeting;
  reload: () => Promise<unknown>;
  roadmap: { data?: Schemas["SimpleRoadmapOut"] | null; reload: () => Promise<unknown> };
  approved: number | null;
  onApproved: (n: number) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const act = async (run: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await run();
      await reload();
      return true;
    } catch (e) {
      setError(errorMessage(e));
      return false;
    } finally {
      setBusy(false);
    }
  };
  const path = { meeting_id: m.id };

  if (approved !== null) {
    // The dates are approved: the items are on the roadmap, solid.
    const on = (roadmap.data?.items ?? []).filter((i) => i.status !== "cut").map((i) => ({ key: i.key, title: i.title, start: i.start.date, end: i.end.date }));
    return (
      <section aria-label="Roadmap slice" className="simple-card">
        <h2 className="simple-h2">{m.prd.title} on the roadmap</h2>
        <div className="mt-2 space-y-2">
          <p role="status" className="simple-small">{`Dates approved in this meeting: ${approved} item${approved === 1 ? " is" : "s are"} on the roadmap.`}</p>
          <Bars bars={on} solid label="Roadmap items" />
        </div>
      </section>
    );
  }

  const items = m.draft_roadmap?.items ?? [];
  const n = items.length;
  return (
    <section aria-label="Roadmap slice" className="simple-card">
      <h2 className="simple-h2">{m.prd.title} on the roadmap</h2>
      <div className="mt-2 space-y-3">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="inline-flex items-center gap-1.5 text-[15px] text-text2">
            <span aria-hidden className="inline-block h-3.5 w-6 rounded-sm" style={HATCH} />
            Draft from the run: not approved
          </span>
          {said && <span role="status" className="simple-small" data-testid="draft-said">{said}</span>}
        </div>
        {error && <ErrorNote>{error}</ErrorNote>}
        <Bars bars={items} picked={picked} label="Draft roadmap" />
        <ul className="divide-y divide-line">
          {items.map((i) => (
            <li key={i.id} data-draft-item={i.key} className="flex flex-wrap items-center justify-between gap-2 py-2">
              {/* As the phone frame: the buttons on their own line under the words. */}
              <span className="min-w-0 flex-1 max-[600px]:basis-full">
                <strong>{i.title}</strong> · {cap(i.horizon)} · <span className="whitespace-nowrap">{span(i)}</span> · <span className="text-accent-ink">Draft</span>
              </span>
              {m.can.change && editing !== i.id && (
                <span className="flex gap-2">
                  <Button className={PHONE_TAP} disabled={busy} aria-label={`Change dates for ${i.title}`} onClick={() => setEditing(i.id)}>Change dates</Button>
                  <Button
                    className={`${PHONE_TAP} text-crit`}
                    disabled={busy}
                    aria-label={`Leave out ${i.title}`}
                    onClick={async () => {
                      const yes = await confirmInPage({ action: "Leave out", message: `Leave ${i.title} out? It does not go on the roadmap.`, destructive: true });
                      if (!yes) return;
                      if (await act(() => unwrap(api.POST("/v1/simple/meetings/{meeting_id}/draft-items/{item_id}/leave-out", { params: { path: { ...path, item_id: i.id } } })))) {
                        setSaid(`Left out ${i.title}: it does not go on the roadmap.`);
                        setPicked(null);
                      }
                    }}
                  >
                    Leave out
                  </Button>
                </span>
              )}
              {editing === i.id && (
                <DatesForm
                  item={i}
                  busy={busy}
                  onCancel={() => setEditing(null)}
                  onSave={async (start, end) => {
                    if (await act(() => unwrap(api.POST("/v1/simple/meetings/{meeting_id}/draft-items/{item_id}/dates", { params: { path: { ...path, item_id: i.id } }, body: { start, end } })))) {
                      setSaid(movedWords(i.title, i.start, start));
                      setPicked(i.key);
                      setEditing(null);
                    }
                  }}
                />
              )}
            </li>
          ))}
        </ul>
        {m.can.change && n > 0 && !asking && (
          <Button variant="primary" icon="check" className={PHONE_TAP} disabled={busy} onClick={() => setAsking(true)}>{`Approve these ${n} dates`}</Button>
        )}
        {asking && (
          <div role="dialog" aria-label="Approve dates" className="rounded-md border border-accent bg-accent-soft p-3">
            <p className="font-semibold">{`Put ${n} item${n === 1 ? "" : "s"} on the roadmap with these dates?`}</p>
            <p className="simple-small">Everyone sees them on the roadmap at once. The PRD itself still needs its own approval.</p>
            <div className="mt-2 flex flex-wrap gap-2">
              <Button
                variant="primary"
                icon="check"
                className={PHONE_TAP}
                disabled={busy}
                onClick={async () => {
                  if (await act(() => unwrap(api.POST("/v1/simple/meetings/{meeting_id}/draft-items/approve", { params: { path } })))) {
                    await roadmap.reload();
                    setAsking(false);
                    onApproved(n);
                  }
                }}
              >
                Approve dates
              </Button>
              <Button className={PHONE_TAP} disabled={busy} onClick={() => setAsking(false)}>Cancel</Button>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
