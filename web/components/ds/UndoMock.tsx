'use client'; // MOCK-HOOK
// MOCK-HOOK: the whole file. mk-undo mock-ups (#1804, decisions UT1..UT3), local only, never merged.
// ?ut1=a|b|c|d  the toast (a newest wins, b stack of three, c one toast that counts, d strip under the title)  // MOCK-HOOK
// ?ut2=a|b|c|d  which changes get one, and a commenter's proposal  // MOCK-HOOK
// ?ut3=a|b|c    after the toast is gone (a History in the feature panel, b Your changes list, c Removed and Trash only)  // MOCK-HOOK
// &hold=1 freezes the timers for snapshots; window.__mk.push() adds a change the way toast() does.  // MOCK-HOOK

import { useEffect, useState } from 'react'; // MOCK-HOOK

import { MK_HISTORY, MK_MINE } from '@/lib/api/mock/mk-undo'; // MOCK-HOOK

import { Icon } from './Icon'; // MOCK-HOOK
import type { ToastAsk } from './Toast'; // MOCK-HOOK

const q = () => (typeof window === 'undefined' ? new URLSearchParams() : new URLSearchParams(window.location.search)); // MOCK-HOOK
export const mkParam = (k: string) => q().get(k); // MOCK-HOOK
export const mkOn = () => !!(mkParam('ut1') || mkParam('ut2') || mkParam('ut3')); // MOCK-HOOK
const ut1 = () => mkParam('ut1') ?? 'c'; // MOCK-HOOK: UT2 and UT3 frames draw the toast the recommended way

type Entry = ToastAsk & { id: number; at: number; done?: 'undone'; kind?: 'tick'; anchor?: string; who?: string }; // MOCK-HOOK
let log: Entry[] = []; // MOCK-HOOK
let seq = 0; // MOCK-HOOK
const subs = new Set<() => void>(); // MOCK-HOOK
const emit = () => subs.forEach((f) => f()); // MOCK-HOOK
export function mkPush(ask: ToastAsk & { kind?: 'tick'; anchor?: string }) { // MOCK-HOOK
  log = [...log, { ...ask, id: ++seq, at: Date.now() }]; // MOCK-HOOK
  emit(); // MOCK-HOOK
} // MOCK-HOOK
if (typeof window !== 'undefined') // MOCK-HOOK
  (window as unknown as { __mk: unknown }).__mk = { // MOCK-HOOK
    push: (m: string, label?: string, kind?: 'tick', anchor?: string) => // MOCK-HOOK
      mkPush({ message: m, kind, anchor, action: label ? { label, onClick: () => mkPush({ message: `Undone: ${m.replace(/^\S+/, (w) => w.toLowerCase())}` }) } : undefined }), // MOCK-HOOK
    clear: () => ((log = []), emit()), // MOCK-HOOK
  }; // MOCK-HOOK

const LIFE = 8000; // MOCK-HOOK
function useLog() { // MOCK-HOOK
  const [, set] = useState(0); // MOCK-HOOK
  useEffect(() => { // MOCK-HOOK
    const f = () => set((n) => n + 1); // MOCK-HOOK
    subs.add(f); // MOCK-HOOK
    const t = window.setInterval(f, 250); // MOCK-HOOK
    return () => { subs.delete(f); window.clearInterval(t); }; // MOCK-HOOK
  }, []); // MOCK-HOOK
  return log; // MOCK-HOOK
} // MOCK-HOOK
const live = (e: Entry) => !e.done && (mkParam('hold') || Date.now() - e.at < LIFE); // MOCK-HOOK
const undo = (e: Entry) => { e.done = 'undone'; emit(); e.action?.onClick(); }; // MOCK-HOOK

const CARD = 'pointer-events-auto rounded-panel border border-line bg-hero text-base text-hero-text shadow-tip'; // MOCK-HOOK
const BTN = 'h-8 flex-none rounded-lg px-2.5 text-sm font-semibold text-hero-text underline-offset-2 hover:bg-hero-2 hover:underline'; // MOCK-HOOK
const KBD = 'rounded border border-hero-line px-1 text-xs text-hero-text2'; // MOCK-HOOK

function Line({ e, kbd, bar }: { e: Entry; kbd?: boolean; bar?: boolean }) { // MOCK-HOOK
  const left = mkParam('hold') ? 0.62 : Math.max(0, 1 - (Date.now() - e.at) / LIFE); // MOCK-HOOK
  return ( // MOCK-HOOK
    <div className="relative flex min-w-0 items-center gap-3 px-4 py-2.5" data-mk-line=""> {/* MOCK-HOOK */}
      <span className="min-w-0 flex-1 break-words">{e.message}</span> {/* MOCK-HOOK */}
      {e.action && ( // MOCK-HOOK
        <button type="button" className={BTN} aria-keyshortcuts={kbd ? 'Control+Z' : undefined} onClick={() => undo(e)}> {/* MOCK-HOOK */}
          {e.action.label} {kbd && e.action.label === 'Undo' && <kbd className={`${KBD} max-[600px]:hidden`}>Ctrl Z</kbd>} {/* MOCK-HOOK */}
        </button> // MOCK-HOOK
      )} {/* MOCK-HOOK */}
      {bar && <span aria-hidden className="absolute bottom-0 left-3 h-0.5 rounded bg-hero-text2" style={{ width: `calc((100% - 24px) * ${left})` }} />} {/* MOCK-HOOK */}
    </div> // MOCK-HOOK
  ); // MOCK-HOOK
} // MOCK-HOOK

function Dismiss({ on }: { on: () => void }) { // MOCK-HOOK
  return ( // MOCK-HOOK
    <button type="button" aria-label="Dismiss" onClick={on} className="mr-2 grid size-8 flex-none place-items-center rounded-lg text-hero-text2 hover:bg-hero-2 hover:text-hero-text"> {/* MOCK-HOOK */}
      <Icon name="x" size={20} /> {/* MOCK-HOOK */}
    </button> // MOCK-HOOK
  ); // MOCK-HOOK
} // MOCK-HOOK

/** Replaces ToastHost while a mock-up switch is on. */ // MOCK-HOOK
export function MkToastHost() { // MOCK-HOOK
  const all = useLog(); // MOCK-HOOK
  const [open, setOpen] = useState(mkParam('open') === '1'); // MOCK-HOOK
  const v = ut1(); // MOCK-HOOK
  const shown = all.filter((e) => !e.kind && live(e)); // MOCK-HOOK
  const ticks = all.filter((e) => e.kind === 'tick' && live(e)); // MOCK-HOOK
  useEffect(() => { // MOCK-HOOK: Ctrl Z undoes the newest change still on screen (a, c)
    if (v !== 'a' && v !== 'c') return; // MOCK-HOOK
    const k = (ev: KeyboardEvent) => { // MOCK-HOOK
      const t = ev.target as HTMLElement | null; // MOCK-HOOK
      if (!(ev.ctrlKey || ev.metaKey) || ev.key !== 'z' || t?.closest('input,textarea,[contenteditable]')) return; // MOCK-HOOK
      const e = [...log].reverse().find((x) => !x.kind && live(x) && x.action?.label === 'Undo'); // MOCK-HOOK
      if (e) { ev.preventDefault(); undo(e); } // MOCK-HOOK
    }; // MOCK-HOOK
    window.addEventListener('keydown', k); // MOCK-HOOK
    return () => window.removeEventListener('keydown', k); // MOCK-HOOK
  }, [v]); // MOCK-HOOK
  const tickEls = ticks.map((t) => { // MOCK-HOOK: UT2 b: a small Saved tick beside the field, no toast
    const r = t.anchor ? document.querySelector(t.anchor)?.getBoundingClientRect() : null; // MOCK-HOOK
    if (!r) return null; // MOCK-HOOK
    return ( // MOCK-HOOK
      <span key={t.id} role="status" className="fixed z-[61] inline-flex items-center gap-1 rounded-full border border-line bg-surface px-2 py-0.5 text-xs font-semibold text-pass shadow-sm" style={{ left: r.right + 6, top: r.top + r.height / 2 - 11 }}> {/* MOCK-HOOK */}
        <Icon name="check" size={16} /> Saved {/* MOCK-HOOK */}
      </span> // MOCK-HOOK
    ); // MOCK-HOOK
  }); // MOCK-HOOK
  const newest = shown.at(-1); // MOCK-HOOK
  const corner = 'pointer-events-none fixed bottom-4 right-4 z-[60] flex max-w-[min(560px,calc(100vw-24px))] flex-col items-end gap-2 max-[600px]:bottom-20 max-[600px]:left-3 max-[600px]:right-3 max-[600px]:items-stretch'; // MOCK-HOOK
  let body = null; // MOCK-HOOK
  if (newest && v === 'a') // MOCK-HOOK
    body = ( // MOCK-HOOK
      <div className={corner}> {/* MOCK-HOOK */}
        <div role="status" aria-live="polite" className={`${CARD} flex items-center`}> {/* MOCK-HOOK */}
          <Line e={newest} kbd bar /> <Dismiss on={() => { newest.done = 'undone'; setOpen(false); }} /> {/* MOCK-HOOK */}
        </div> {/* MOCK-HOOK */}
      </div> // MOCK-HOOK
    ); // MOCK-HOOK
  if (newest && v === 'b') { // MOCK-HOOK
    const stack = shown.filter((e, i) => e.action || i === shown.length - 1); // MOCK-HOOK
    const top3 = stack.slice(-3); // MOCK-HOOK
    const more = stack.length - top3.length; // MOCK-HOOK
    body = ( // MOCK-HOOK
      <div className={corner} role="region" aria-label="Changes you can undo"> {/* MOCK-HOOK */}
        {more > 0 && (open ? stack.slice(0, more) : []).map((e) => ( // MOCK-HOOK
          <div key={e.id} className={`${CARD} flex items-center opacity-90`}><Line e={e} bar /><Dismiss on={() => undo({ ...e, action: undefined })} /></div> // MOCK-HOOK
        ))} {/* MOCK-HOOK */}
        {more > 0 && ( // MOCK-HOOK
          <button type="button" onClick={() => setOpen(!open)} className="pointer-events-auto rounded-full border border-line bg-hero px-3 py-1 text-sm font-semibold text-hero-text shadow-tip"> {/* MOCK-HOOK */}
            {open ? 'Show fewer' : `${more} more`} {/* MOCK-HOOK */}
          </button> // MOCK-HOOK
        )} {/* MOCK-HOOK */}
        {top3.map((e) => ( // MOCK-HOOK
          <div key={e.id} role="status" aria-live="polite" className={`${CARD} flex items-center`}><Line e={e} bar /><Dismiss on={() => { e.done = 'undone'; setOpen(open); }} /></div> // MOCK-HOOK
        ))} {/* MOCK-HOOK */}
      </div> // MOCK-HOOK
    ); // MOCK-HOOK
  } // MOCK-HOOK
  if (newest && v === 'c') { // MOCK-HOOK
    const earlier = shown.slice(0, -1).filter((e) => e.action).reverse(); // MOCK-HOOK
    body = ( // MOCK-HOOK
      <div className={corner}> {/* MOCK-HOOK */}
        <div role="status" aria-live="polite" className={`${CARD} flex w-full flex-col min-[601px]:w-auto`}> {/* MOCK-HOOK */}
          <div className="flex items-center"><Line e={newest} kbd bar /><Dismiss on={() => { shown.forEach((e) => (e.done = 'undone')); setOpen(false); }} /></div> {/* MOCK-HOOK */}
          {earlier.length > 0 && ( // MOCK-HOOK
            <div className="border-t border-hero-line"> {/* MOCK-HOOK */}
              {open && earlier.map((e) => <Line key={e.id} e={e} />)} {/* MOCK-HOOK */}
              <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="flex w-full items-center gap-1 px-4 py-1.5 text-sm font-semibold text-hero-text2 hover:text-hero-text"> {/* MOCK-HOOK */}
                <Icon name={open ? 'chevron-up' : 'chevron-down'} size={16} /> {open ? 'Hide' : `${earlier.length} earlier ${earlier.length === 1 ? 'change' : 'changes'}`} {/* MOCK-HOOK */}
              </button> {/* MOCK-HOOK */}
            </div> // MOCK-HOOK
          )} {/* MOCK-HOOK */}
        </div> {/* MOCK-HOOK */}
      </div> // MOCK-HOOK
    ); // MOCK-HOOK
  } // MOCK-HOOK
  if (v === 'd') { // MOCK-HOOK: a strip at the top of the page, no timer: it stays until the next page
    const kept = all.filter((e) => !e.kind && !e.done); // MOCK-HOOK
    const last = kept.at(-1); // MOCK-HOOK
    if (last) // MOCK-HOOK
      body = ( // MOCK-HOOK
        <div role="status" aria-live="polite" className="fixed left-[calc(var(--simple-rail-width,232px)+24px)] right-6 top-2 z-[60] flex items-center gap-3 rounded-lg border border-line bg-hero pl-4 text-base text-hero-text shadow-tip max-[600px]:left-3 max-[600px]:right-3 max-[600px]:top-[calc(var(--phone-top-bar,56px)+8px)]"> {/* MOCK-HOOK */}
          <Icon name="clock" size={18} /> {/* MOCK-HOOK */}
          <span className="min-w-0 flex-1 truncate py-2 max-[600px]:line-clamp-2 max-[600px]:whitespace-normal">{last.message}</span> {/* MOCK-HOOK */}
          {kept.length > 1 && <span className="text-sm text-hero-text2 max-[600px]:hidden">{kept.length} changes on this page</span>} {/* MOCK-HOOK */}
          {last.action && <button type="button" className={BTN} onClick={() => undo(last)}>{last.action.label}</button>} {/* MOCK-HOOK */}
          <Dismiss on={() => { kept.forEach((e) => (e.done = 'undone')); emit(); }} /> {/* MOCK-HOOK */}
        </div> // MOCK-HOOK
      ); // MOCK-HOOK
  } // MOCK-HOOK
  return ( // MOCK-HOOK
    <div data-testid="toasts"> {/* MOCK-HOOK */}
      {body} {/* MOCK-HOOK */}
      {tickEls} {/* MOCK-HOOK */}
      {mkParam('ut3') === 'b' && <MkMine />} {/* MOCK-HOOK */}
    </div> // MOCK-HOOK
  ); // MOCK-HOOK
} // MOCK-HOOK

let histOpen = false; // MOCK-HOOK
/** UT3 a: the History section at the foot of the one feature panel. */ // MOCK-HOOK
export function MkHistory({ canUndo }: { canUndo: boolean }) { // MOCK-HOOK
  const [lines, setLines] = useState(() => MK_HISTORY.map((l) => ({ ...l }))); // MOCK-HOOK
  const [open, setOpen0] = useState(histOpen || mkParam('hist') === '1'); // MOCK-HOOK
  const setOpen = (o: boolean) => { histOpen = o; setOpen0(o); }; // MOCK-HOOK
  const mine = log.filter((e) => !e.kind && e.action?.label === 'Undo').reverse(); // MOCK-HOOK
  if (mkParam('ut3') !== 'a') return null; // MOCK-HOOK
  const all = [ // MOCK-HOOK
    ...mine.map((e) => ({ who: 'You', what: e.message, when: 'Just now', undo: !e.done, undone: !!e.done, e })), // MOCK-HOOK
    ...lines.map((l) => ({ ...l, e: null as Entry | null })), // MOCK-HOOK
  ]; // MOCK-HOOK
  return ( // MOCK-HOOK
    <section aria-label="History" className="mt-3 border-t border-line pt-3" data-mk-history=""> {/* MOCK-HOOK */}
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="flex w-full items-center gap-2 text-base font-[650] text-text"> {/* MOCK-HOOK */}
        <Icon name="clock" size={18} /> History <span className="text-sm font-normal text-text2">· {all.length}</span> {/* MOCK-HOOK */}
        <Icon name={open ? 'chevron-up' : 'chevron-down'} size={16} className="ml-auto" /> {/* MOCK-HOOK */}
      </button> {/* MOCK-HOOK */}
      {open && ( // MOCK-HOOK
        <ol className="mt-2 flex flex-col"> {/* MOCK-HOOK */}
          {all.map((l, i) => ( // MOCK-HOOK
            <li key={i} className="flex items-start gap-2 border-b border-line py-2 last:border-0"> {/* MOCK-HOOK */}
              <span className="min-w-0 flex-1 text-sm"> {/* MOCK-HOOK */}
                <span className={l.undone ? 'text-text2 line-through' : 'text-text'}><b className="font-[650]">{l.who}</b> {l.what}</span> {/* MOCK-HOOK */}
                <span className="block text-xs text-text2">{l.when}{l.undone ? ' · undone' : ''}</span> {/* MOCK-HOOK */}
              </span> {/* MOCK-HOOK */}
              {l.undo && !l.undone && ( // MOCK-HOOK
                <button type="button" className="h-7 flex-none rounded-lg border border-line px-2 text-sm font-semibold text-accent-ink hover:bg-surface2" // MOCK-HOOK
                  onClick={() => { if (l.e) undo(l.e); else setLines((ls) => ls.map((x) => (x.what === l.what ? { ...x, undone: true } : x))); mkPush({ message: `Undone: ${l.who === 'You' ? '' : `${l.who} `}${l.what.replace(/^\S+/, (w) => w.toLowerCase())}` }); }}> {/* MOCK-HOOK */}
                  {canUndo ? 'Undo' : 'Propose undo'} {/* MOCK-HOOK */}
                </button> // MOCK-HOOK
              )} {/* MOCK-HOOK */}
            </li> // MOCK-HOOK
          ))} {/* MOCK-HOOK */}
        </ol> // MOCK-HOOK
      )} {/* MOCK-HOOK */}
    </section> // MOCK-HOOK
  ); // MOCK-HOOK
} // MOCK-HOOK

/** UT3 b: "Your changes" beside the account: every change you made today, on any page. */ // MOCK-HOOK
function MkMine() { // MOCK-HOOK
  const [open, setOpen] = useState(mkParam('mine') === '1'); // MOCK-HOOK
  const [gone, setGone] = useState<string[]>([]); // MOCK-HOOK
  const mine = log.filter((e) => !e.kind && e.action?.label === 'Undo').reverse(); // MOCK-HOOK
  const all = [...mine.map((e) => ({ what: e.message, when: 'Just now', e })), ...MK_MINE.map((l) => ({ what: l.what, when: l.when, e: null as Entry | null }))]; // MOCK-HOOK
  return ( // MOCK-HOOK
    <div className="fixed left-4 top-[568px] z-[59] w-[200px] max-[600px]:bottom-[84px] max-[600px]:left-auto max-[600px]:right-3 max-[600px]:top-auto max-[600px]:w-auto"> {/* MOCK-HOOK */}
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="flex w-full items-center gap-2 rounded-lg border border-line bg-surface px-3 py-2 text-base font-semibold text-text shadow-sm"> {/* MOCK-HOOK */}
        <Icon name="clock" size={18} /> <span className="max-[600px]:sr-only">Your changes</span> <span className="ml-auto rounded-full bg-surface2 px-1.5 text-sm">{all.length - gone.length}</span> {/* MOCK-HOOK */}
      </button> {/* MOCK-HOOK */}
      {open && ( // MOCK-HOOK
        <div role="dialog" aria-label="Your changes today" className="absolute left-0 top-12 w-[420px] max-w-[calc(100vw-24px)] rounded-xl border border-line bg-surface p-2 shadow-tip max-[600px]:bottom-12 max-[600px]:left-auto max-[600px]:right-0 max-[600px]:top-auto max-[600px]:w-[calc(100vw-24px)]"> {/* MOCK-HOOK */}
          <p className="px-2 py-1 text-sm font-semibold text-text2">Today</p> {/* MOCK-HOOK */}
          {all.map((l) => { const done = gone.includes(l.what) || !!l.e?.done; return ( // MOCK-HOOK
            <div key={l.what} className="flex items-start gap-2 rounded-lg px-2 py-2 hover:bg-surface2"> {/* MOCK-HOOK */}
              <span className="min-w-0 flex-1 text-sm"><span className={done ? 'text-text2 line-through' : 'text-text'}>{l.what}</span><span className="block text-xs text-text2">{l.when}{done ? ' · undone' : ''}</span></span> {/* MOCK-HOOK */}
              {!done && <button type="button" className="h-7 flex-none rounded-lg border border-line px-2 text-sm font-semibold text-accent-ink" onClick={() => { if (l.e) undo(l.e); setGone((g) => [...g, l.what]); }}>Undo</button>} {/* MOCK-HOOK */}
            </div> // MOCK-HOOK
          ); })} {/* MOCK-HOOK */}
        </div> // MOCK-HOOK
      )} {/* MOCK-HOOK */}
    </div> // MOCK-HOOK
  ); // MOCK-HOOK
} // MOCK-HOOK

/** UT2: what a change's toast offers, per proposal; true when it was handled here. */ // MOCK-HOOK
export function mkUt2( // MOCK-HOOK
  r: { change: { id: string; status: string } }, // MOCK-HOOK
  body: { op: string; after?: unknown }, // MOCK-HOOK
  message: string, // MOCK-HOOK
  wd: (id: string) => Promise<void>, // MOCK-HOOK
  reload: () => unknown, // MOCK-HOOK
  push: (a: ToastAsk) => void, // MOCK-HOOK
): boolean { // MOCK-HOOK
  const mk = mkParam('ut2'); // MOCK-HOOK
  if (!mk) return false; // MOCK-HOOK
  const cut = (body.after as { status?: string } | undefined)?.status === 'cut'; // MOCK-HOOK
  const small = ['set_status', 'set_confidence', 'set_dates', 'set_owner', 'move', 'set_rank'].includes(body.op) && !cut; // MOCK-HOOK
  const applied = r.change.status === 'applied'; // MOCK-HOOK
  if (mk === 'b' && small && applied) { // MOCK-HOOK
    const f = body.op === 'set_status' ? 'status' : body.op === 'set_dates' ? 'dates' : 'confidence'; // MOCK-HOOK
    mkPush({ message: 'Saved', kind: 'tick', anchor: `button[aria-label="Change the ${f}"]` }); // MOCK-HOOK
    return true; // MOCK-HOOK
  } // MOCK-HOOK
  if ((mk === 'a' || mk === 'c') && !applied) { // MOCK-HOOK
    push({ message, action: { label: mk === 'a' ? 'Withdraw' : 'Undo', onClick: () => void wd(r.change.id).then(() => (push({ message: mk === 'a' ? 'Withdrawn: it no longer waits for a decision' : 'Undone' }), reload())) } }); // MOCK-HOOK
    return true; // MOCK-HOOK
  } // MOCK-HOOK
  if (mk === 'd' && !small && applied) { // MOCK-HOOK
    push({ message }); // MOCK-HOOK
    return true; // MOCK-HOOK
  } // MOCK-HOOK
  return false; // MOCK-HOOK
} // MOCK-HOOK
