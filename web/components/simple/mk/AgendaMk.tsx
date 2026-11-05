"use client"; // MOCK-HOOK

// MOCK-HOOK: mk-edit-meetings-tracks, decision 1 (?ea=a|b|c): how a person adds, renames, reorders and removes agenda items.
import { useState } from "react"; // MOCK-HOOK

import { InfoTip, Sheet } from "@/components/ds"; // MOCK-HOOK
import { MK_AGENDA, MK_AGENDA_ADDABLE, MK_AGENDA_MANY, MK_DECIDERS, type MkAgendaItem } from "@/lib/api/mock/mk-edit-meetings-tracks"; // MOCK-HOOK

import { MK_BTN, MK_CHIP, MK_FIELD, MK_LINK, MK_PRIMARY, mk, type MkMode } from "./mk"; // MOCK-HOOK

type St = "rest" | "open" | "mid" | "result"; // MOCK-HOOK

const QUIET = "ag-4"; // MOCK-HOOK: the item every story moves up: "Quiet hours for muted teams"

/** MOCK-HOOK: the agenda after the story's action: Quiet hours moved up before Mobile alert push, one topic added, the skipped item removed. */
function after(list: MkAgendaItem[]): MkAgendaItem[] { // MOCK-HOOK
  const rest = list.filter((x) => x.id !== QUIET && x.id !== "ag-5"); // MOCK-HOOK
  const at = rest.findIndex((x) => x.id === "ag-3"); // MOCK-HOOK
  const q = list.find((x) => x.id === QUIET)!; // MOCK-HOOK
  return [...rest.slice(0, at), { ...q, title: "Quiet hours by default" }, ...rest.slice(at), { id: "ag-new", title: "Beta date sign-off", kind: "topic", state: "next", mins: 5, by: "You" }]; // MOCK-HOOK
} // MOCK-HOOK

function Dot({ s }: { s: MkAgendaItem["state"] }) { // MOCK-HOOK
  if (s === "done") return <span aria-label="Done" className="text-text-faint">✓</span>; // MOCK-HOOK
  if (s === "now") return <span aria-label="Now" className="inline-block h-2.5 w-2.5 rounded-full bg-accent" />; // MOCK-HOOK
  if (s === "skipped") return <span className="text-sm text-text-faint">skipped</span>; // MOCK-HOOK
  return null; // MOCK-HOOK
} // MOCK-HOOK

function ItemName({ x, bare }: { x: MkAgendaItem; bare?: boolean }) { // MOCK-HOOK
  if (bare && x.kind === "topic") return <span>{x.title}</span>; // MOCK-HOOK: the sheet says "topic" on the row's second line
  return x.kind === "feature" ? ( // MOCK-HOOK
    <button type="button" className="text-left hover:underline">{x.title}</button> // MOCK-HOOK
  ) : ( // MOCK-HOOK
    <span>{x.title}<span className="text-sm text-text-faint"> · topic</span></span> // MOCK-HOOK
  ); // MOCK-HOOK
} // MOCK-HOOK

export function AgendaMk({ mode, phone }: { mode: MkMode; phone: boolean }) { // MOCK-HOOK
  const v = mk("ea") ?? "a"; // MOCK-HOOK
  const st = (mk("st") ?? "rest") as St; // MOCK-HOOK
  const base = mk("many") ? MK_AGENDA_MANY : MK_AGENDA; // MOCK-HOOK
  const list = st === "result" && mode === "edit" ? after(base) : base; // MOCK-HOOK: a proposal leaves the agenda as it is
  if (v === "b") return <AgendaSheet list={list} st={st} mode={mode} phone={phone} />; // MOCK-HOOK
  if (v === "c") return <AgendaByChat list={list} st={st} mode={mode} phone={phone} />; // MOCK-HOOK
  return <AgendaInPlace list={list} st={st} mode={mode} phone={phone} />; // MOCK-HOOK
} // MOCK-HOOK

/** MOCK-HOOK: what the change did; an approver's proposal names who it waits for. */
function Done({ mode, words }: { mode: MkMode; words: string }) { // MOCK-HOOK
  return ( // MOCK-HOOK
    <p role="status" className="flex flex-wrap items-center gap-x-3 border-b border-line bg-[var(--simple-edited)] px-4 py-1.5 text-base" data-testid="mk-agenda-done"> {/* MOCK-HOOK */}
      {mode === "propose" ? <><span className="flex items-center gap-1"><span className={MK_CHIP}>Proposed</span><InfoTip label="What is proposed" align="start">{words}.</InfoTip></span><span>Waits for {MK_DECIDERS.agenda}</span></> : `${words}.`} {/* MOCK-HOOK */}
      <button type="button" className={MK_LINK}>{mode === "propose" ? "Withdraw" : "Undo"}</button> {/* MOCK-HOOK */}
      {mode === "edit" && <a href="/settings/trash" className={MK_LINK}>Open Trash</a>} {/* MOCK-HOOK */}
    </p> // MOCK-HOOK
  ); // MOCK-HOOK
} // MOCK-HOOK

const RESULT_WORDS = "Moved Quiet hours up and renamed it, added Beta date sign-off, and moved Alert history export to Trash"; // MOCK-HOOK

/* ---------- A: the strip edited in place ---------- */ // MOCK-HOOK
function AgendaInPlace({ list, st, mode, phone }: { list: MkAgendaItem[]; st: St; mode: MkMode; phone: boolean }) { // MOCK-HOOK
  const [editing, setEditing] = useState(st === "open" || st === "mid"); // MOCK-HOOK
  const may = mode !== "read"; // MOCK-HOOK
  const lifted = st === "mid" ? QUIET : null; // MOCK-HOOK
  const shown = st === "mid" ? list.filter((x) => x.id !== QUIET) : list; // MOCK-HOOK
  const dropAt = shown.findIndex((x) => x.id === "ag-3"); // MOCK-HOOK
  return ( // MOCK-HOOK
    <> {/* MOCK-HOOK */}
      <div aria-label="Agenda" data-testid="mk-agenda" data-mk-focus={phone ? "" : undefined} className="flex flex-wrap items-center gap-x-2 gap-y-2 border-b border-line px-4 py-2 text-base"> {/* MOCK-HOOK */}
        <span className="mr-1 font-semibold">Agenda</span> {/* MOCK-HOOK */}
        <ol className="flex min-w-0 flex-wrap items-center gap-2"> {/* MOCK-HOOK */}
          {shown.map((x, i) => ( // MOCK-HOOK
            <li key={x.id} className="flex items-center gap-2"> {/* MOCK-HOOK */}
              {lifted && i === dropAt && ( // MOCK-HOOK
                <span className="relative flex items-center"> {/* MOCK-HOOK */}
                  <span aria-hidden className="h-7 w-1 rounded bg-accent" /> {/* MOCK-HOOK */}
                  <span aria-hidden className="pointer-events-none absolute top-6 -left-3 z-50 flex items-center gap-1.5 rounded-full border border-accent bg-surface px-2.5 py-0.5 whitespace-nowrap shadow-tip" style={{ transform: "rotate(-2deg)" }}>⠿ Quiet hours for muted teams <span className="text-sm text-text-faint">· topic</span></span> {/* MOCK-HOOK */}
                </span> // MOCK-HOOK
              )} {/* MOCK-HOOK */}
              <span className={`flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 ${x.state === "now" ? "border-accent" : "border-line"} ${x.state === "done" || x.state === "skipped" ? "text-text2" : ""}`}> {/* MOCK-HOOK */}
                {editing && x.state !== "done" && x.state !== "now" && <span aria-label={`Drag ${x.title}`} className="cursor-grab text-text-faint">⠿</span>} {/* MOCK-HOOK */}
                <span className="text-sm text-text-faint">{i + 1}</span> {/* MOCK-HOOK */}
                <Dot s={x.state} /> {/* MOCK-HOOK */}
                {editing && x.state !== "done" ? <button type="button" className="text-left underline decoration-dotted underline-offset-4">{x.title}</button> : <ItemName x={x} />} {/* MOCK-HOOK */}
                {editing && x.state !== "done" && x.state !== "now" && <button type="button" aria-label={`Remove ${x.title}`} className="ml-0.5 text-text2 hover:text-crit">×</button>} {/* MOCK-HOOK */}
              </span> {/* MOCK-HOOK */}
            </li> // MOCK-HOOK
          ))} {/* MOCK-HOOK */}
          {editing && <li><button type="button" className={MK_BTN}>+ Add</button></li>} {/* MOCK-HOOK */}
        </ol> {/* MOCK-HOOK */}
        {may && ( // MOCK-HOOK
          <button type="button" className={`ml-auto ${editing ? MK_PRIMARY : MK_BTN}`} onClick={() => setEditing((e) => !e)} data-testid="mk-agenda-edit"> {/* MOCK-HOOK */}
            {editing ? "Done" : "Edit agenda"} {/* MOCK-HOOK */}
          </button> // MOCK-HOOK
        )} {/* MOCK-HOOK */}
        {!may && <span className="ml-auto text-sm text-text2">View only</span>} {/* MOCK-HOOK */}
      </div> {/* MOCK-HOOK */}
      {st === "result" && <Done mode={mode} words={RESULT_WORDS} />} {/* MOCK-HOOK */}
    </> // MOCK-HOOK
  ); // MOCK-HOOK
} // MOCK-HOOK

/* ---------- B: an agenda sheet ---------- */ // MOCK-HOOK
function AgendaSheet({ list, st, mode, phone }: { list: MkAgendaItem[]; st: St; mode: MkMode; phone: boolean }) { // MOCK-HOOK
  const [open, setOpen] = useState(st === "open" || st === "mid"); // MOCK-HOOK
  const may = mode !== "read"; // MOCK-HOOK
  const nowAt = list.findIndex((x) => x.state === "now"); // MOCK-HOOK
  const next = list.find((x, i) => i > nowAt && x.state === "next"); // MOCK-HOOK
  const save = mode === "propose" ? "Propose" : "Save"; // MOCK-HOOK
  const firstMovable = list.findIndex((x) => x.state !== "done" && x.state !== "now"); // MOCK-HOOK: the item right after Now cannot go up
  return ( // MOCK-HOOK
    <> {/* MOCK-HOOK */}
      <div aria-label="Agenda" data-testid="mk-agenda" className="flex flex-wrap items-center gap-x-6 gap-y-1 border-b border-line px-4 py-2 text-base"> {/* MOCK-HOOK */}
        <p><span className="font-semibold">Now:</span> {list[nowAt]?.title}</p> {/* MOCK-HOOK */}
        {next && <p><span className="font-semibold">Next:</span> <ItemName x={next} /></p>} {/* MOCK-HOOK */}
        <p className="text-text2">Item {nowAt + 1} of {list.length}</p> {/* MOCK-HOOK */}
        <button type="button" className={`ml-auto ${MK_BTN}`} onClick={() => setOpen(true)} data-testid="mk-agenda-open"> {/* MOCK-HOOK */}
          {may ? "Edit agenda" : "See agenda"} {/* MOCK-HOOK */}
        </button> {/* MOCK-HOOK */}
      </div> {/* MOCK-HOOK */}
      {st === "result" && <Done mode={mode} words={RESULT_WORDS} />} {/* MOCK-HOOK */}
      <Sheet open={open} title="Agenda" onClose={() => setOpen(false)} side testId="mk-agenda-sheet" tools={!may ? <span className="text-sm text-text2">View only</span> : undefined}> {/* MOCK-HOOK */}
<div className="px-4 pb-4"> {/* MOCK-HOOK */}
        <ol className="flex flex-col"> {/* MOCK-HOOK */}
          {list.map((x, i) => { // MOCK-HOOK
            const renaming = st === "mid" && x.id === QUIET; // MOCK-HOOK
            const locked = x.state === "done" || x.state === "now"; // MOCK-HOOK
            return ( // MOCK-HOOK
              <li key={x.id} className={`flex items-center gap-2 border-b border-line py-2 ${renaming ? "bg-accent-soft -mx-2 px-2 rounded-lg" : ""}`}> {/* MOCK-HOOK */}
                {may && !locked ? <span aria-label={`Drag ${x.title}`} className="cursor-grab text-text-faint">⠿</span> : <span className="w-[10px]" />} {/* MOCK-HOOK */}
                <span className="w-5 text-sm text-text-faint">{i + 1}</span> {/* MOCK-HOOK */}
                <div className="min-w-0 flex-1"> {/* MOCK-HOOK */}
                  {renaming ? ( // MOCK-HOOK
                    <div className="grid gap-1.5"> {/* MOCK-HOOK */}
                      <input aria-label="Item name" defaultValue="Quiet hours by default" className={MK_FIELD} /> {/* MOCK-HOOK */}
                      <div className="flex gap-2"><button type="button" className={MK_PRIMARY}>{save}</button><button type="button" className={MK_BTN}>Cancel</button></div> {/* MOCK-HOOK */}
                    </div> // MOCK-HOOK
                  ) : ( // MOCK-HOOK
                    <p className={`break-words ${locked && x.state === "done" ? "text-text2" : ""}`}><ItemName x={x} bare /> {x.state !== "next" && <Dot s={x.state} />}</p> // MOCK-HOOK
                  )} {/* MOCK-HOOK */}
                  {!renaming && <p className="text-sm text-text-faint">{x.mins} min{x.kind === "topic" ? " · topic" : ""}{x.by ? ` · added by ${x.by}` : ""}</p>} {/* MOCK-HOOK */}
                </div> {/* MOCK-HOOK */}
                {may && !locked && !renaming && ( // MOCK-HOOK
                  <span className="flex flex-none items-center gap-1"> {/* MOCK-HOOK */}
                    {i === firstMovable ? <span aria-hidden className="w-8" /> : <button type="button" aria-label={`Move ${x.title} up`} className="h-8 w-8 rounded text-text2 hover:bg-surface2">↑</button>} {/* MOCK-HOOK */}
                    {i === list.length - 1 ? <span aria-hidden className="w-8" /> : <button type="button" aria-label={`Move ${x.title} down`} className="h-8 w-8 rounded text-text2 hover:bg-surface2">↓</button>} {/* MOCK-HOOK */}
                    <button type="button" aria-label={`Rename ${x.title}`} className="h-8 rounded px-1.5 text-sm text-text2 hover:bg-surface2">Rename</button> {/* MOCK-HOOK */}
                    <button type="button" aria-label={`Remove ${x.title}`} className="h-8 w-8 rounded text-text2 hover:bg-surface2 hover:text-crit">×</button> {/* MOCK-HOOK */}
                  </span> // MOCK-HOOK
                )} {/* MOCK-HOOK */}
              </li> // MOCK-HOOK
            ); // MOCK-HOOK
          })} {/* MOCK-HOOK */}
        </ol> {/* MOCK-HOOK */}
        {may && ( // MOCK-HOOK
          <div className="mt-3 grid gap-2" data-testid="mk-agenda-add"> {/* MOCK-HOOK */}
            <label className="text-sm font-medium" htmlFor="mk-add">Add a feature or a topic</label> {/* MOCK-HOOK */}
            <input id="mk-add" placeholder="Type a name" className={MK_FIELD} /> {/* MOCK-HOOK */}
            <div className="flex flex-wrap gap-1.5">{MK_AGENDA_ADDABLE.slice(0, phone ? 2 : 4).map((t) => <button key={t} type="button" className="rounded-full border border-line px-2.5 py-0.5 text-sm hover:bg-surface2">+ {t}</button>)}</div> {/* MOCK-HOOK */}
          </div> // MOCK-HOOK
        )} {/* MOCK-HOOK */}
        {mode === "propose" && <p className="mt-3"><span className={MK_CHIP}>Waits for {MK_DECIDERS.agenda}</span></p>} {/* MOCK-HOOK */}
</div> {/* MOCK-HOOK */}
      </Sheet> {/* MOCK-HOOK */}
    </> // MOCK-HOOK
  ); // MOCK-HOOK
} // MOCK-HOOK

/* ---------- C: by chat only, with a card to confirm ---------- */ // MOCK-HOOK
function AgendaByChat({ list, st, mode, phone }: { list: MkAgendaItem[]; st: St; mode: MkMode; phone: boolean }) { // MOCK-HOOK
  const may = mode !== "read"; // MOCK-HOOK
  return ( // MOCK-HOOK
    <> {/* MOCK-HOOK */}
      <div aria-label="Agenda" data-testid="mk-agenda" className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line px-4 py-2 text-base"> {/* MOCK-HOOK */}
        <span className="font-semibold">Agenda</span> {/* MOCK-HOOK */}
        <ol className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1"> {/* MOCK-HOOK */}
          {list.map((x, i) => ( // MOCK-HOOK
            <li key={x.id} className={`flex items-center gap-1.5 ${x.state === "done" || x.state === "skipped" ? "text-text2" : ""}`}> {/* MOCK-HOOK */}
              <span className="text-sm text-text-faint">{i + 1}.</span> <Dot s={x.state} /> <ItemName x={x} /> {/* MOCK-HOOK */}
            </li> // MOCK-HOOK
          ))} {/* MOCK-HOOK */}
        </ol> {/* MOCK-HOOK */}
        <span className="ml-auto flex items-center gap-1 text-sm text-text2">{may ? "Change it in the chat" : "View only"} <InfoTip label="How to change the agenda">Type in the chat: add, rename, move up, move down, remove, next or skip, with the item&apos;s name.</InfoTip></span> {/* MOCK-HOOK */}
      </div> {/* MOCK-HOOK */}
      {(st === "open" || st === "mid") && may && ( // MOCK-HOOK
        <div role="status" className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line bg-accent-soft px-4 py-2 text-base" data-testid="mk-agenda-card" data-mk-focus={phone ? "" : undefined}> {/* MOCK-HOOK */}
          <span className="font-semibold">Oracle:</span> {/* MOCK-HOOK */}
          {st === "open" ? <span>Move <b>Quiet hours for muted teams</b> up, before Mobile alert push?</span> : <span>Rename <b>Quiet hours for muted teams</b> to <b>Quiet hours by default</b>, add <b>Beta date sign-off</b>, remove <b>Alert history export</b>?</span>} {/* MOCK-HOOK */}
          <button type="button" className={MK_PRIMARY}>{mode === "propose" ? "Propose" : "Do it"}</button> {/* MOCK-HOOK */}
          <button type="button" className={MK_BTN}>Cancel</button> {/* MOCK-HOOK */}
        </div> // MOCK-HOOK
      )} {/* MOCK-HOOK */}
      {st === "result" && <Done mode={mode} words={RESULT_WORDS} />} {/* MOCK-HOOK */}
    </> // MOCK-HOOK
  ); // MOCK-HOOK
} // MOCK-HOOK
