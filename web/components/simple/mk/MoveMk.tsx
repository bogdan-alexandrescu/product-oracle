"use client"; // MOCK-HOOK

// MOCK-HOOK: mk-edit-meetings-tracks, decision 3 (?em=a|b|c): how a person moves a feature to another PRD or track of the one roadmap.
import { InfoTip } from "@/components/ds"; // MOCK-HOOK
import { usePhone } from "@/components/simple/FlowViews"; // MOCK-HOOK
import { MK_DECIDERS, MK_PRDS, MK_PRDS_MANY } from "@/lib/api/mock/mk-edit-meetings-tracks"; // MOCK-HOOK

import { MK_BTN, MK_CHIP, MK_FIELD, MK_PRIMARY, mk, useMkMode } from "./mk"; // MOCK-HOOK

const KEY = "setup-video"; // MOCK-HOOK: Welcome video, the feature every story moves
const TO = "Welcome media track"; // MOCK-HOOK
const st = () => mk("st") ?? "rest"; // MOCK-HOOK

type Moveable = { key: string; track?: { id: string; title: string } | null; prd?: { slug: string; title: string } | null }; // MOCK-HOOK
const cache = new WeakMap<object, unknown>(); // MOCK-HOOK
/** MOCK-HOOK: the roadmap after the story's move (the result frames, for one who decides). */
export function mkMoved<T extends { items: Moveable[] }>(d: T | undefined, mode: string): T | undefined { // MOCK-HOOK
  if (!d || !mk("em") || st() !== "result" || mode !== "edit") return d; // MOCK-HOOK
  if (!cache.has(d)) { // MOCK-HOOK
    const id = (d.items.find((i) => i.key === KEY) as { id?: string } | undefined)?.id; // MOCK-HOOK
    const g = (d as { groups?: { key: string; title: string; item_ids: string[] }[] }).groups; // MOCK-HOOK
    const at = g ? g.findIndex((x) => id && x.item_ids.includes(id)) : -1; // MOCK-HOOK
    const groups = g && at >= 0 && id ? [...g.slice(0, at + 1).map((x) => ({ ...x, item_ids: x.item_ids.filter((y) => y !== id) })), { ...g[at], key: "mk-welcome", title: TO, item_ids: [id] }, ...g.slice(at + 1)] : g; // MOCK-HOOK
    cache.set(d, { ...d, ...(groups ? { groups } : {}), items: d.items.map((i) => (i.key === KEY && i.track ? { ...i, track: { ...i.track, id: "mk-welcome", title: TO } } : i)) }); // MOCK-HOOK
  } // MOCK-HOOK
  return cache.get(d) as T; // MOCK-HOOK
} // MOCK-HOOK

const row = "grid grid-cols-[96px_minmax(0,1fr)] gap-2 py-1"; // MOCK-HOOK

/** MOCK-HOOK: A, two fields in the panel's Details: PRD and Track, changed in place as every other field. */
export function MoveRows({ item }: { item: Moveable & { can_decide?: boolean } }) { // MOCK-HOOK
  const mode = useMkMode(item.can_decide); // MOCK-HOOK
  if (mk("em") !== "a") return null; // MOCK-HOOK
  const story = item.key === KEY; // MOCK-HOOK
  const s = st(); // MOCK-HOOK
  const may = mode !== "read"; // MOCK-HOOK
  const editing = story && may && (s === "open" || s === "mid"); // MOCK-HOOK
  const prd = item.prd?.title ?? "No PRD"; // MOCK-HOOK
  const many = !!mk("many"); // MOCK-HOOK
  return ( // MOCK-HOOK
    <> {/* MOCK-HOOK */}
      <div className={row} data-mk-focus={story ? "" : undefined}><dt className="text-sm leading-[22px] text-text2">PRD</dt><dd className="min-w-0">{editing ? <select aria-label="PRD" defaultValue={many ? "Usage alerts" : prd} className={MK_FIELD}>{MK_PRDS.map((p) => <option key={p.title}>{p.title}</option>)}</select> : <button type="button" disabled={!may} className="text-left underline decoration-dotted underline-offset-4 disabled:no-underline">{prd}</button>}</dd></div> {/* MOCK-HOOK */}
      <div className={row}><dt className="text-sm leading-[22px] text-text2">Track</dt><dd className="min-w-0"> {/* MOCK-HOOK */}
        {editing ? ( // MOCK-HOOK
          <div className="grid gap-1.5"> {/* MOCK-HOOK */}
            {s === "open" ? ( // MOCK-HOOK
              <ul role="listbox" aria-label="Track" className="rounded-md border-2 border-accent bg-surface py-1">{(MK_PRDS.find((p) => p.title === (many ? "Usage alerts" : prd))?.tracks ?? []).map((t) => <li key={t} role="option" aria-selected={t === item.track?.title} className={`px-2 py-1 ${t === item.track?.title ? "bg-accent-soft" : "hover:bg-surface2"}`}>{t}</li>)}</ul> // MOCK-HOOK
            ) : ( // MOCK-HOOK
              <select aria-label="Track" defaultValue={TO} className={MK_FIELD}><option>{TO}</option></select> // MOCK-HOOK
            )} {/* MOCK-HOOK */}
            {s === "mid" && <div className="flex items-center gap-1.5"><button type="button" className={MK_PRIMARY}>{mode === "propose" ? "Propose" : "Save"}</button><button type="button" className={MK_BTN}>Cancel</button><Stays /></div>} {/* MOCK-HOOK */}
          </div> // MOCK-HOOK
        ) : ( // MOCK-HOOK
          <button type="button" disabled={!may} className="text-left underline decoration-dotted underline-offset-4 disabled:no-underline">{item.track?.title ?? "No track"}</button> // MOCK-HOOK
        )} {/* MOCK-HOOK */}
        {story && s === "result" && mode === "propose" && <p className="mt-1 flex items-center gap-1"><span className={MK_CHIP}>Proposed</span><InfoTip label="The proposed move" align="start">Move to {TO}. It waits for {MK_DECIDERS.move}, who decides this feature; its dates, links and goal stay.</InfoTip></p>} {/* MOCK-HOOK */}
      </dd></div> {/* MOCK-HOOK */}
    </> // MOCK-HOOK
  ); // MOCK-HOOK
} // MOCK-HOOK

/** MOCK-HOOK: B, a "Move to" button in the panel's head and its picker. */
export function MoveTo({ item }: { item: Moveable & { can_decide?: boolean } }) { // MOCK-HOOK
  const mode = useMkMode(item.can_decide); // MOCK-HOOK
  if (mk("em") !== "b" || mode === "read") return null; // MOCK-HOOK
  const s = st(); // MOCK-HOOK
  const open = item.key === KEY && (s === "open" || s === "mid"); // MOCK-HOOK
  const prds = mk("many") ? MK_PRDS_MANY : MK_PRDS; // MOCK-HOOK
  return ( // MOCK-HOOK
    <span className="relative"> {/* MOCK-HOOK */}
      <button type="button" aria-expanded={open} className="rounded-full border border-line px-2 py-px text-sm font-medium text-text hover:bg-surface2" data-testid="mk-move-to">Move to…</button> {/* MOCK-HOOK */}
      {open && ( // MOCK-HOOK
        <div role="dialog" aria-label="Move to" className="absolute top-8 right-0 z-[70] w-[340px] max-w-[calc(100vw-32px)] rounded-xl border border-line bg-surface p-3 text-[15px] text-text shadow-tip"> {/* MOCK-HOOK */}
          <p className="font-semibold">Move {item.key === KEY ? "Welcome video" : "it"} to</p> {/* MOCK-HOOK */}
          <ul className="mt-1 max-h-[520px] overflow-y-auto"> {/* MOCK-HOOK */}
            {prds.map((p) => ( // MOCK-HOOK
              <li key={p.title} className="py-0.5"> {/* MOCK-HOOK */}
                <p className="text-sm font-medium text-text2">{p.title}</p> {/* MOCK-HOOK */}
                {p.tracks.map((t) => { // MOCK-HOOK
                  const here = t === item.track?.title; // MOCK-HOOK
                  const picked = s === "mid" && t === TO; // MOCK-HOOK
                  return <button key={t} type="button" disabled={here} className={`block w-full truncate rounded-lg px-2 py-0.5 text-left ${picked ? "bg-accent-soft font-medium text-accent-ink" : here ? "text-text-faint" : "hover:bg-surface2"}`}>{t}{here ? " · now" : ""}</button>; // MOCK-HOOK
                })} {/* MOCK-HOOK */}
              </li> // MOCK-HOOK
            ))} {/* MOCK-HOOK */}
          </ul> {/* MOCK-HOOK */}
          {s === "mid" && ( // MOCK-HOOK
            <div className="mt-2 border-t border-line pt-2"> {/* MOCK-HOOK */}
              <div className="flex items-center gap-1.5"><button type="button" className={MK_PRIMARY}>{mode === "propose" ? `Propose the move` : `Move to ${TO}`}</button><button type="button" className={MK_BTN}>Cancel</button><Stays /></div> {/* MOCK-HOOK */}
            </div> // MOCK-HOOK
          )} {/* MOCK-HOOK */}
        </div> // MOCK-HOOK
      )} {/* MOCK-HOOK */}
    </span> // MOCK-HOOK
  ); // MOCK-HOOK
} // MOCK-HOOK

/** MOCK-HOOK: B and C: the track line in the panel's head, so the move reads at a glance. */
export function TrackLine({ item }: { item: Moveable }) { // MOCK-HOOK
  if (mk("em") !== "b" && mk("em") !== "c") return null; // MOCK-HOOK
  return <span data-testid="mk-track-line">{item.prd?.title ?? "No PRD"} · {item.track?.title ?? "No track"}</span>; // MOCK-HOOK
} // MOCK-HOOK

/** MOCK-HOOK: C, while a row is dragged: every track of the roadmap is a drop place, empty ones too. */
export function TrackDropHook() { // MOCK-HOOK
  const mode = useMkMode(); // MOCK-HOOK
  const s = st(); // MOCK-HOOK
  const phone = usePhone(); // MOCK-HOOK: no dragging on a phone
  if (mk("em") !== "c" || mode === "read" || phone || (s !== "open" && s !== "mid")) return null; // MOCK-HOOK
  return ( // MOCK-HOOK
    <div className="relative px-2 py-1.5" data-mk-focus=""> {/* MOCK-HOOK */}
      <div className={`flex h-[44px] items-center rounded-lg border-2 border-dashed px-2 text-[15px] font-semibold ${s === "mid" ? "border-accent bg-accent-soft text-accent-ink" : "border-line text-text2"}`}>{TO}<span className="ml-1 text-xs font-normal">· empty</span></div> {/* MOCK-HOOK */}
      <div aria-hidden className={`pointer-events-none absolute z-[5] flex items-center gap-1.5 whitespace-nowrap rounded-lg border border-accent bg-surface px-2 py-1 text-[15px] shadow-tip ${s === "mid" ? "top-6 left-10" : "top-2 left-[calc(100%+24px)]"}`} style={{ transform: "rotate(-2deg)" }}>⠿ Welcome video</div> {/* MOCK-HOOK */}
      {s === "mid" && <p className="mt-1 px-1 text-xs text-text2">{mode === "propose" ? "Let go to propose" : "Let go to move"}</p>} {/* MOCK-HOOK */}
    </div> // MOCK-HOOK
  ); // MOCK-HOOK
} // MOCK-HOOK

/** MOCK-HOOK: what the move did. */
export function MoveDone({ decides }: { decides?: boolean }) { // MOCK-HOOK
  const mode = useMkMode(decides); // MOCK-HOOK
  if (!mk("em") || st() !== "result" || mode === "read") return null; // MOCK-HOOK
  return ( // MOCK-HOOK
    <p role="status" className="fixed bottom-5 left-5 z-[80] flex items-center gap-3 rounded-xl bg-[#1f2328] px-4 py-2.5 text-[15px] text-white shadow-tip" data-testid="mk-move-done"> {/* MOCK-HOOK */}
      {mode === "propose" ? `Move proposed · waits for ${MK_DECIDERS.move}` : `Moved Welcome video to ${TO}`} {/* MOCK-HOOK */}
      <button type="button" className="font-medium underline">{mode === "propose" ? "Withdraw" : "Undo"}</button> {/* MOCK-HOOK */}
    </p> // MOCK-HOOK
  ); // MOCK-HOOK
} // MOCK-HOOK

/** MOCK-HOOK: what a move keeps, behind an (i). */
function Stays() { // MOCK-HOOK
  return <InfoTip label="What stays" align="start">Its dates, links and goal stay.</InfoTip>; // MOCK-HOOK
} // MOCK-HOOK
