"use client"; // MOCK-HOOK

// MOCK-HOOK: mk-edit-meetings-tracks, decision 2 (?et=a|b|c): where tracks are added, renamed, given an owner, paused, closed and moved to Trash in Simple.
import { useState } from "react"; // MOCK-HOOK

import { InfoTip, Sheet } from "@/components/ds"; // MOCK-HOOK
import { usePhone } from "@/components/simple/FlowViews"; // MOCK-HOOK
import { MK_DECIDERS, MK_PEOPLE, MK_TRACKS, MK_TRACKS_MANY, type MkTrack } from "@/lib/api/mock/mk-edit-meetings-tracks"; // MOCK-HOOK

import { MK_BTN, MK_CHIP, MK_FIELD, MK_PRIMARY, mk, mkModeSeen, useMkMode, type MkMode } from "./mk"; // MOCK-HOOK

const STORY = "Guided setup track"; // MOCK-HOOK: the track every story renames
const NEW_NAME = "Setup and onboarding"; // MOCK-HOOK
const LONG = "Admin console and team settings for large accounts"; // MOCK-HOOK

const st = () => mk("st") ?? "rest"; // MOCK-HOOK
const STATE_WORDS: Record<MkTrack["state"], string> = { active: "Active", paused: "Paused", closed: "Closed" }; // MOCK-HOOK

/** MOCK-HOOK: a lane's name after the story's rename (the result frames). */
export function mkTrackTitle(title: string): string { // MOCK-HOOK
  if (!mk("et")) return title; // MOCK-HOOK
  if (st() === "result" && title === STORY && mkModeSeen === "edit") return NEW_NAME; // MOCK-HOOK
  if (mk("many") && mk("et") === "a" && title === STORY) return LONG; // MOCK-HOOK
  return title; // MOCK-HOOK
} // MOCK-HOOK

/** MOCK-HOOK: A, on the lane header: a ⋯ menu (Rename, Owner, Pause, Close, Move to Trash). */
export function TrackLaneHook({ title }: { title: string }) { // MOCK-HOOK
  const mode = useMkMode(); // MOCK-HOOK
  const phone = usePhone(); // MOCK-HOOK
  const v = mk("et"); // MOCK-HOOK
  const [open, setOpen] = useState(v === "a" && (st() === "open") && title === STORY); // MOCK-HOOK
  const renaming = v === "a" && st() === "mid" && title === STORY; // MOCK-HOOK
  if (mk("em") === "c" && st() === "result" && title === "Welcome media track") return <span data-mk-focus="" />; // MOCK-HOOK
  if (title === "No track") return null; // MOCK-HOOK
  if (v === "c") return <button type="button" aria-label={`Open ${title}`} className="absolute inset-0 z-[1] hover:bg-black/5" data-testid="mk-track-open" />; // MOCK-HOOK
  if (v !== "a" || mode === "read") return null; // MOCK-HOOK
  const word = mode === "propose" ? "Propose" : "Save"; // MOCK-HOOK
  return ( // MOCK-HOOK
    <> {/* MOCK-HOOK */}
      <button type="button" aria-label={`Change ${title}`} onClick={() => setOpen((o) => !o)} className={`absolute top-1 right-1 z-[2] h-7 w-7 rounded text-text2 hover:bg-surface ${open ? "bg-surface" : ""}`} data-testid="mk-lane-menu">⋯</button> {/* MOCK-HOOK */}
      {open && !phone && <div role="menu" className="absolute top-9 left-2 z-[70] w-[220px] rounded-xl border border-line bg-surface p-1 text-[15px] shadow-tip"><LaneMenu mode={mode} /></div>} {/* MOCK-HOOK */}
      {phone && <Sheet open={open} title={title} onClose={() => setOpen(false)} above testId="mk-lane-sheet"><div role="menu" className="px-2 pb-3"><LaneMenu mode={mode} /></div></Sheet>} {/* MOCK-HOOK: on a phone the menu is a bottom sheet, the track's name whole in its head */}
      {renaming && ( // MOCK-HOOK
        <div className="absolute inset-x-1 top-1 z-[70] grid gap-1 rounded-lg border border-line bg-surface p-1.5 shadow-tip"> {/* MOCK-HOOK */}
          <input aria-label="Track name" autoFocus defaultValue={mk("many") ? LONG : NEW_NAME} className={MK_FIELD} /> {/* MOCK-HOOK */}
          <div className="flex gap-1.5"><button type="button" className={MK_PRIMARY}>{word}</button><button type="button" className={MK_BTN}>Cancel</button></div> {/* MOCK-HOOK */}
        </div> // MOCK-HOOK
      )} {/* MOCK-HOOK */}
    </> // MOCK-HOOK
  ); // MOCK-HOOK
} // MOCK-HOOK

/** MOCK-HOOK: A's menu items. */
function LaneMenu({ mode }: { mode: MkMode }) { // MOCK-HOOK
  return ( // MOCK-HOOK
    <> {/* MOCK-HOOK */}
      {["Rename", "Owner: Marco Ilves", mode === "propose" ? "Propose a pause" : "Pause", mode === "propose" ? "Propose closing" : "Close"].map((w) => <button key={w} role="menuitem" type="button" className="block w-full rounded-lg px-3 py-1.5 text-left hover:bg-surface2">{w}</button>)} {/* MOCK-HOOK */}
      {mode === "edit" && <button role="menuitem" type="button" className="block w-full rounded-lg px-3 py-1.5 text-left text-crit hover:bg-crit-bg">Move to Trash</button>} {/* MOCK-HOOK */}
    </> // MOCK-HOOK
  ); // MOCK-HOOK
} // MOCK-HOOK

/** MOCK-HOOK: what a proposal waits on, by name. */
function Waits() { // MOCK-HOOK
  return <p className="mt-3"><span className={MK_CHIP}>Waits for {MK_DECIDERS.track}</span></p>; // MOCK-HOOK
} // MOCK-HOOK

/** MOCK-HOOK: A, the labels column's head: + Add (a new, empty lane). */
export function TrackAddHook() { // MOCK-HOOK
  const mode = useMkMode(); // MOCK-HOOK
  if (mk("et") !== "a" || mode !== "edit") return null; // MOCK-HOOK
  return <button type="button" className="ml-auto text-xs font-medium text-accent-ink hover:underline" data-testid="mk-track-add">+ Add track</button>; // MOCK-HOOK
} // MOCK-HOOK

function Result({ mode }: { mode: MkMode }) { // MOCK-HOOK
  if (st() !== "result") return null; // MOCK-HOOK
  return ( // MOCK-HOOK
    <p role="status" className="fixed bottom-5 left-1/2 z-[80] flex -translate-x-1/2 items-center gap-3 rounded-xl bg-[#1f2328] px-4 py-2.5 text-[15px] text-white shadow-tip" data-testid="mk-track-done"> {/* MOCK-HOOK */}
      {mode === "propose" ? `Rename proposed · waits for ${MK_DECIDERS.track}` : `Renamed ${STORY} to ${NEW_NAME}`} {/* MOCK-HOOK */}
      <button type="button" className="font-medium underline">{mode === "propose" ? "Withdraw" : "Undo"}</button> {/* MOCK-HOOK */}
    </p> // MOCK-HOOK
  ); // MOCK-HOOK
} // MOCK-HOOK

/** MOCK-HOOK: one track's fields, edited in place (B's open row and C's panel). */
function TrackFields({ t, mode, renaming }: { t: MkTrack; mode: MkMode; renaming: boolean }) { // MOCK-HOOK
  const may = mode !== "read"; // MOCK-HOOK
  const word = mode === "propose" ? "Propose" : "Save"; // MOCK-HOOK
  const row = "grid grid-cols-[84px_minmax(0,1fr)] items-center gap-2 py-1"; // MOCK-HOOK
  return ( // MOCK-HOOK
    <dl className="text-[15px]"> {/* MOCK-HOOK */}
      <div className={row}><dt className="text-sm text-text2">Name</dt><dd>{renaming ? <div className="grid gap-1.5"><input aria-label="Track name" autoFocus defaultValue={NEW_NAME} className={MK_FIELD} /><div className="flex gap-1.5"><button type="button" className={MK_PRIMARY}>{word}</button><button type="button" className={MK_BTN}>Cancel</button></div></div> : <button type="button" disabled={!may} className="text-left underline decoration-dotted underline-offset-4 disabled:no-underline">{t.title}</button>}</dd></div> {/* MOCK-HOOK */}
      <div className={row}><dt className="text-sm text-text2">Owner</dt><dd>{may ? <select aria-label="Owner" defaultValue={t.owner ?? ""} className={MK_FIELD}><option value="">No owner</option>{MK_PEOPLE.map((p) => <option key={p}>{p}</option>)}</select> : (t.owner ?? "No owner")}</dd></div> {/* MOCK-HOOK */}
      <div className={row}><dt className="text-sm text-text2">State</dt><dd className="flex gap-1">{may ? (["active", "paused", "closed"] as const).map((s) => <button key={s} type="button" aria-pressed={t.state === s} className={`rounded-lg border px-2.5 py-0.5 text-sm ${t.state === s ? "border-accent bg-accent-soft font-medium text-accent-ink" : "border-line"}`}>{STATE_WORDS[s]}</button>) : STATE_WORDS[t.state]}</dd></div> {/* MOCK-HOOK */}
      <div className={row}><dt className="text-sm text-text2">PRD</dt><dd>{t.prd}</dd></div> {/* MOCK-HOOK */}
    </dl> // MOCK-HOOK
  ); // MOCK-HOOK
} // MOCK-HOOK

/** MOCK-HOOK: B's Tracks button and sheet, and C's track panel; the roadmap toolbar holds it. */
export function TracksMk({ mode, phone }: { mode: MkMode; phone: boolean }) { // MOCK-HOOK
  const v = mk("et"); // MOCK-HOOK
  const s = st(); // MOCK-HOOK
  const [open, setOpen] = useState(s === "open" || s === "mid"); // MOCK-HOOK
  const list = (mk("many") ? MK_TRACKS_MANY : MK_TRACKS).map((t) => (s === "result" && t.title === STORY && mode === "edit" ? { ...t, title: NEW_NAME } : t)); // MOCK-HOOK
  const may = mode !== "read"; // MOCK-HOOK
  if (v === "a") return <Result mode={mode} />; // MOCK-HOOK
  if (v === "b") // MOCK-HOOK
    return ( // MOCK-HOOK
      <> {/* MOCK-HOOK */}
        <button type="button" className={MK_BTN} onClick={() => setOpen(true)} data-testid="mk-tracks-open">Tracks · {list.length}</button> {/* MOCK-HOOK */}
        <Sheet open={open} title="Tracks" onClose={() => setOpen(false)} side testId="mk-tracks-sheet" tools={may ? undefined : <span className="text-sm text-text2">View only</span>}> {/* MOCK-HOOK */}
<div className="px-4 pb-4"> {/* MOCK-HOOK */}
          {mode === "edit" && <div className="mb-1 flex"><button type="button" className={MK_PRIMARY}>+ Add track</button></div>} {/* MOCK-HOOK */}
          <ul className="flex flex-col"> {/* MOCK-HOOK */}
            {list.map((t) => { // MOCK-HOOK
              const expanded = (s === "open" || s === "mid") && t.title === STORY; // MOCK-HOOK
              return ( // MOCK-HOOK
                <li key={t.id} className={`border-b border-line py-2 ${expanded ? "-mx-2 rounded-lg bg-surface2 px-2" : ""}`}> {/* MOCK-HOOK */}
                  <div className="flex items-start gap-2"> {/* MOCK-HOOK */}
                    <div className="min-w-0 flex-1"> {/* MOCK-HOOK */}
                      <p className={`font-medium break-words ${t.state === "closed" ? "text-text2" : ""}`}>{t.title}</p> {/* MOCK-HOOK */}
                      <p className="text-sm text-text2">{t.owner ?? "No owner"} · {t.items} {t.items === 1 ? "feature" : "features"}{t.state !== "active" ? ` · ${STATE_WORDS[t.state]}` : ""}</p> {/* MOCK-HOOK */}
                    </div> {/* MOCK-HOOK */}
                    {may && <button type="button" aria-expanded={expanded} className="h-8 rounded px-2 text-sm text-accent-ink hover:bg-surface">{expanded ? "Hide" : "Change"}</button>} {/* MOCK-HOOK */}
                  </div> {/* MOCK-HOOK */}
                  {expanded && ( // MOCK-HOOK
                    <div className="mt-1"> {/* MOCK-HOOK */}
                      <TrackFields t={t} mode={mode} renaming={s === "mid"} /> {/* MOCK-HOOK */}
                      {mode === "edit" && <button type="button" className="mt-1 text-sm font-medium text-crit hover:underline">Move to Trash</button>} {/* MOCK-HOOK */}
                    </div> // MOCK-HOOK
                  )} {/* MOCK-HOOK */}
                </li> // MOCK-HOOK
              ); // MOCK-HOOK
            })} {/* MOCK-HOOK */}
          </ul> {/* MOCK-HOOK */}
          {mode === "propose" && <Waits />} {/* MOCK-HOOK */}
</div> {/* MOCK-HOOK */}
        </Sheet> {/* MOCK-HOOK */}
        <Result mode={mode} /> {/* MOCK-HOOK */}
      </> // MOCK-HOOK
    ); // MOCK-HOOK
  if (v !== "c") return null; // MOCK-HOOK
  const t = list.find((x) => x.title === STORY || x.title === NEW_NAME)!; // MOCK-HOOK
  return ( // MOCK-HOOK
    <> {/* MOCK-HOOK */}
      {mode === "edit" && <button type="button" className={MK_BTN} data-testid="mk-track-new">+ Track</button>} {/* MOCK-HOOK */}
      {open && ( // MOCK-HOOK
        <> {/* MOCK-HOOK */}
          <div aria-hidden onClick={() => setOpen(false)} className="fixed inset-0 z-[55] bg-black/30" /> {/* MOCK-HOOK */}
          <aside role="dialog" aria-label={t.title} data-testid="mk-track-panel" className={`fixed z-[60] flex flex-col overflow-y-auto border-line bg-surface text-[15px] shadow-tip ${phone ? "inset-0" : "top-4 right-4 bottom-4 w-[520px] max-w-[calc(100vw-32px)] rounded-xl border"}`}> {/* MOCK-HOOK */}
            <div className="flex items-start gap-2 border-b border-line px-4 pt-3.5 pb-2.5"> {/* MOCK-HOOK */}
              <h2 className="min-w-0 flex-1 text-lg font-semibold">{t.title}</h2> {/* MOCK-HOOK */}
              <button type="button" aria-label="Close" onClick={() => setOpen(false)} className="h-8 w-8 rounded text-text2 hover:bg-surface2">×</button> {/* MOCK-HOOK */}
            </div> {/* MOCK-HOOK */}
            <div className="px-4 py-3"> {/* MOCK-HOOK */}
              {!may && <p className="mb-2 flex items-center gap-1"><span className="rounded-full bg-surface2 px-2 py-px text-sm text-text2">View only</span><InfoTip label="Who can change it" align="start">The company&apos;s owners and {MK_DECIDERS.track}, its owner.</InfoTip></p>} {/* MOCK-HOOK */}
              <TrackFields t={t} mode={mode} renaming={s === "mid"} /> {/* MOCK-HOOK */}
              <h3 className="mt-4 font-semibold">Features on it</h3> {/* MOCK-HOOK */}
              <ul className="mt-1">{["Setup checklist", "Sample data import", "In-app tour", "Welcome video"].map((f) => <li key={f} className="border-b border-line py-1.5"><button type="button" className="text-left hover:underline">{f}</button></li>)}</ul> {/* MOCK-HOOK */}
              {mode === "edit" && <button type="button" className="mt-4 text-sm font-medium text-crit hover:underline">Move to Trash</button>} {/* MOCK-HOOK */}
              {mode === "propose" && <Waits />} {/* MOCK-HOOK */}
            </div> {/* MOCK-HOOK */}
          </aside> {/* MOCK-HOOK */}
        </> // MOCK-HOOK
      )} {/* MOCK-HOOK */}
      <Result mode={mode} /> {/* MOCK-HOOK */}
    </> // MOCK-HOOK
  ); // MOCK-HOOK
} // MOCK-HOOK

