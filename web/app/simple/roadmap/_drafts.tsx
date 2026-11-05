"use client";
// RP2 'Draft layer on roadmap' (the owner's pick, Nov 4): each PRD whose run dated items that are
// not approved yet shows above the roadmap's chart, one card per PRD, its items hatched on the
// card's own month axis (GET /v1/simple/roadmap/draft-prds, api/oracle/simple/roadmap_drafts.py).
// Show drafts (on by default, remembered per person) hides them all. Opening an item opens the
// feature panel with its Draft line; Change dates and Leave out change the run's draft, as the
// review meeting's Roadmap step does, never the roadmap. Approving the PRD puts its items on the
// roadmap's working draft and they leave the layer.

import { useCallback, useState, useSyncExternalStore, type ReactNode } from "react";

import { Button, confirmInPage, Icon } from "@/components/ds";
import { api, unwrap, type Schemas } from "@/lib/api/client";
import { calendarDay } from "@/lib/dates";
import { errorMessage } from "@/lib/use-query";

import { DatesForm, HATCH, months, movedWords } from "../meetings/[id]/_draft";

export type DraftPrd = Schemas["SimpleRoadmapDraftPrd"];
export type DraftItem = DraftPrd["items"][number];

const PHONE_TAP = "max-[600px]:min-h-11";
const at = (d: string) => Date.parse(`${d.slice(0, 10)}T00:00:00Z`);
export const draftSpan = (i: DraftItem) => `${calendarDay(i.start)} – ${calendarDay(i.end)}`;

// Show drafts, remembered per person in this browser (as the Plan's scope, lib/preferences.ts).
const SHOW_KEY = "oracle-roadmap-drafts";
const unsaved = new Map<string, boolean>();
const listeners = new Set<() => void>();
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};
function readShow(userId: string): boolean {
  const held = unsaved.get(userId);
  if (held !== undefined) return held;
  try {
    return localStorage.getItem(`${SHOW_KEY}:${userId}`) !== "off";
  } catch {
    return true;
  }
}

export function useShowDrafts(userId: string | null | undefined): [boolean, (on: boolean) => void] {
  const show = useSyncExternalStore(
    subscribe,
    () => (userId ? readShow(userId) : true),
    () => true,
  );
  const set = useCallback(
    (on: boolean) => {
      if (!userId) return;
      unsaved.delete(userId);
      try {
        localStorage.setItem(`${SHOW_KEY}:${userId}`, on ? "on" : "off");
      } catch {
        unsaved.set(userId, on);
      }
      listeners.forEach((l) => l());
    },
    [userId],
  );
  return [show, set];
}

/** The legend chip for a draft: a hatched swatch and its words. */
function DraftKey({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-[15px] text-text2">
      <span aria-hidden className="inline-block h-3.5 w-6 rounded-sm" style={HATCH} />
      {children}
    </span>
  );
}

/** A draft PRD's items as hatched bars over its months, each as wide as its days. */
function DraftBars({ prd, items, picked, onOpen }: { prd: DraftPrd["prd"]; items: DraftItem[]; picked: string | null; onOpen: (i: DraftItem) => void }) {
  const { first, end, cols } = months(items);
  const x = (d: string) => ((at(d) - first) / (end - first)) * 100;
  return (
    <div role="group" aria-label={`${prd.title} draft timeline`} className="mt-2 min-w-0">
      <div className="grid border-b border-line text-[13px] text-text2" style={{ gridTemplateColumns: cols.map((c) => `${c.days}fr`).join(" ") }}>
        {cols.map((c, n) => (
          <span key={n} className="border-l border-line px-1.5 py-1 first:border-l-0">
            {c.name}
          </span>
        ))}
      </div>
      <div className="relative py-1">
        {items.map((i) => (
          <div key={i.id} className="relative h-9">
            <button
              type="button"
              data-draft-item={i.key}
              aria-label={`${i.title}, ${draftSpan(i)}, draft, not approved`}
              title={`${i.title}: ${draftSpan(i)} (draft, not approved)`}
              onClick={() => onOpen(i)}
              className={`absolute top-1 flex h-7 items-center overflow-hidden rounded px-2 text-[13px] font-medium whitespace-nowrap text-text ${picked === i.id ? "ring-2 ring-[var(--accent)] ring-offset-2 ring-offset-[var(--surface)]" : ""}`}
              style={{ left: `${x(i.start)}%`, width: `${Math.max(x(i.end) - x(i.start), 2)}%`, ...HATCH }}
            >
              <span className="truncate">{i.title}</span>
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

/** A phone's draft: one row per item, its hatch, name and dates. */
function DraftList({ items, onOpen }: { items: DraftItem[]; onOpen: (i: DraftItem) => void }) {
  return (
    <ul className="mt-2 divide-y divide-line">
      {items.map((i) => (
        <li key={i.id}>
          <button type="button" data-draft-item={i.key} aria-label={`${i.title}, ${draftSpan(i)}, draft, not approved`} onClick={() => onOpen(i)} className="flex w-full items-center gap-2 py-2 text-left">
            <span aria-hidden className="h-5 w-2 flex-none rounded-sm" style={HATCH} />
            <span className="min-w-0 flex-1">
              <strong className="block">{i.title}</strong>
              <span className="simple-small">{draftSpan(i)}</span>
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/** The draft layer above the roadmap's chart: one collapsible card per draft PRD, and Show drafts. */
export function DraftLayer({
  drafts,
  phone,
  show,
  onShow,
  onlyPrd,
  picked,
  onOpen,
}: {
  drafts: DraftPrd[];
  phone: boolean;
  show: boolean;
  onShow: (on: boolean) => void;
  /** The PRD filter picked a draft PRD: this layer is all the roadmap shows of it. */
  onlyPrd: DraftPrd | null;
  picked: string | null;
  onOpen: (i: DraftItem, d: DraftPrd) => void;
}) {
  const [closed, setClosed] = useState<Set<string>>(new Set());
  if (!drafts.length) return null;
  const toggle = (
    <label className="inline-flex items-center gap-2 text-base">
      <input type="checkbox" checked={show} onChange={(e) => onShow(e.target.checked)} className="size-4 accent-[var(--accent)]" />
      Show drafts
    </label>
  );
  if (!show)
    return (
      <section aria-label="Draft plans" className="simple-card" data-testid="draft-layer">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <DraftKey>{`${drafts.length} PRD${drafts.length === 1 ? "" : "s"} not approved yet, hidden`}</DraftKey>
          <span className="flex-1" />
          {toggle}
        </div>
      </section>
    );
  return (
    <section aria-label="Draft plans" className="simple-card" data-testid="draft-layer">
      {onlyPrd && (
        <p className="simple-small mb-2" role="status">
          {`Showing ${onlyPrd.prd.title} only: its ${onlyPrd.items.length} item${onlyPrd.items.length === 1 ? " is" : "s are"} a draft, hatched until the PRD is approved. Nothing of it is on the approved roadmap yet.`}
        </p>
      )}
      {drafts.map((d, n) => {
        const open = !closed.has(d.prd.id);
        return (
          <div key={d.prd.id} data-draft-prd={d.prd.slug} className={n ? "mt-4 border-t border-line pt-4" : ""}>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <h2 className="simple-h2">
                <button
                  type="button"
                  aria-expanded={open}
                  onClick={() => setClosed((c) => (c.delete(d.prd.id) ? new Set(c) : new Set(c).add(d.prd.id)))}
                  className="inline-flex items-center gap-1.5 text-left"
                >
                  {`${d.prd.title} · draft`}
                  <Icon name={open ? "chevron-down" : "chevron-right"} size={16} className="text-text2" />
                </button>
              </h2>
              <DraftKey>Not approved yet</DraftKey>
              <span className="flex-1" />
              {n === 0 && toggle}
            </div>
            {open && (phone ? <DraftList items={d.items} onOpen={(i) => onOpen(i, d)} /> : <DraftBars prd={d.prd} items={d.items} picked={picked} onOpen={(i) => onOpen(i, d)} />)}
          </div>
        );
      })}
    </section>
  );
}

/** A draft item in the feature panel: its Draft line, and Change dates / Leave out on the run's draft. */
export function DraftDetails({ item, prd, canChange, onChanged, onClose }: { item: DraftItem; prd: DraftPrd["prd"]; canChange: boolean; onChanged: (said: string) => Promise<unknown>; onClose: () => void }) {
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const act = async (call: () => Promise<unknown>, said: string) => {
    setBusy(true);
    setError(null);
    try {
      await call();
      await onChanged(said);
      return true;
    } catch (e) {
      setError(errorMessage(e));
      return false;
    } finally {
      setBusy(false);
    }
  };
  const path = { item_id: item.id };
  return (
    <div className="p-4">
      <div className="flex items-start gap-2">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
          <strong className="text-lg">{item.title}</strong>
          <span className="rounded-full border border-accent px-2 text-sm text-accent-ink">Draft</span>
        </div>
        <button type="button" aria-label="Close" onClick={onClose} className="flex size-8 flex-none items-center justify-center rounded-md text-text2 hover:bg-surface2">
          <Icon name="x" size={18} />
        </button>
      </div>
      <p className="mt-1 text-base">{item.owner_name ? `${draftSpan(item)} · ${item.owner_name}` : draftSpan(item)}</p>
      <p className="mt-1 simple-small">{`Dates from ${prd.title}'s run (engineering dates). Not approved: it joins the roadmap when the PRD is approved.`}</p>
      {canChange && !editing && (
        <div className="mt-3 flex flex-wrap gap-2">
          <Button className={PHONE_TAP} disabled={busy} onClick={() => setEditing(true)}>
            Change dates
          </Button>
          <Button
            className={`${PHONE_TAP} text-crit`}
            disabled={busy}
            onClick={async () => {
              const yes = await confirmInPage({ action: "Leave out", message: `Leave ${item.title} out? It does not go on the roadmap.`, destructive: true });
              if (yes) await act(() => unwrap(api.POST("/v1/simple/roadmap/draft-prds/items/{item_id}/leave-out", { params: { path } })), `Left out ${item.title}: it does not go on the roadmap.`);
            }}
          >
            Leave out
          </Button>
        </div>
      )}
      {editing && (
        <div className="mt-3">
          <DatesForm
            item={item}
            busy={busy}
            onCancel={() => setEditing(false)}
            onSave={async (start, end) => {
              if (await act(() => unwrap(api.POST("/v1/simple/roadmap/draft-prds/items/{item_id}/dates", { params: { path }, body: { start, end } })), movedWords(item.title, item.start, start))) setEditing(false);
            }}
          />
        </div>
      )}
      {error && (
        <p role="alert" className="mt-2 text-[15px] text-crit">
          {error}
        </p>
      )}
    </div>
  );
}
