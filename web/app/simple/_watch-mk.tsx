'use client';
// MOCK-HOOK: the whole file is the mk-watch mock-ups (WD1 watch, WD2 digest, WD3 settings and
// states), switched by ?wd1=a|b|c|d, ?wd2=a|b|c, ?wd3=a|b|c and state switches (&step=, &msg=,
// &state=, &n=many, &role=). Throwaway: never merged.

import { useState, useSyncExternalStore, type ReactNode } from 'react'; // MOCK-HOOK

import { MK_SLIPS, MK_SLIPS_MANY, MK_WATCHED, MK_WATCHERS, type MkSlip } from '@/lib/api/mock/watch-mk'; // MOCK-HOOK

const q = (k: string) => (typeof window === 'undefined' ? null : new URLSearchParams(window.location.search).get(k)); // MOCK-HOOK
export const mk = { wd1: () => q('wd1'), wd2: () => q('wd2'), wd3: () => q('wd3'), step: () => q('step') ?? 'rest', role: () => q('role') ?? 'owner', n: () => q('n') }; // MOCK-HOOK

// A tiny store of what I watch (by roadmap key), so the panel, the rows and the lists agree.
let watched = new Set<string>(['alert-digest']); // MOCK-HOOK
let seeded = false; // MOCK-HOOK
const subs = new Set<() => void>(); // MOCK-HOOK
const setWatched = (key: string, on: boolean) => { watched = new Set(watched); if (on) watched.add(key); else watched.delete(key); subs.forEach((f) => f()); }; // MOCK-HOOK
function useWatched(): Set<string> { // MOCK-HOOK
  if (!seeded) { seeded = true; if (mk.step() === 'done' || mk.step() === 'hard') watched.add('setup-checklist'); } // MOCK-HOOK
  return useSyncExternalStore((f) => (subs.add(f), () => subs.delete(f)), () => watched, () => watched); // MOCK-HOOK
} // MOCK-HOOK

const Svg = ({ d, size = 16, fill = 'none' }: { d: string; size?: number; fill?: string }) => ( // MOCK-HOOK
  <svg aria-hidden width={size} height={size} viewBox="0 0 24 24" fill={fill} stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className="flex-none"><path d={d} /></svg> // MOCK-HOOK
); // MOCK-HOOK
const BELL = 'M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.94 1.94 0 0 0 3.4 0'; // MOCK-HOOK
const EYE = 'M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z'; // MOCK-HOOK

const EVENTS = ['Its dates move', 'It passes its milestone', 'Its status changes', 'Someone mentions me', 'A suggestion waits for me']; // MOCK-HOOK

const pill = 'inline-flex h-7 flex-none items-center gap-1.5 rounded-md border border-line px-2 text-sm font-semibold whitespace-nowrap'; // MOCK-HOOK

/** WD1: the control in the feature panel's head, beside ⋯ and Close. */
export function WatchHeadMk({ itemKey, title, code }: { itemKey: string; title: string; code?: string | null }) { // MOCK-HOOK
  const v = mk.wd1(); // MOCK-HOOK
  const w = useWatched(); // MOCK-HOOK
  const on = w.has(itemKey); // MOCK-HOOK
  const [open, setOpen] = useState(mk.step() === 'open' || mk.step() === 'mid'); // MOCK-HOOK
  const [picked, setPicked] = useState<boolean[]>(EVENTS.map((_, k) => !(mk.step() === 'mid' && k >= 3))); // MOCK-HOOK
  const [said, setSaid] = useState<string | null>(mk.step() === 'done' ? `Watching ${code ?? ''} ${title}` : null); // MOCK-HOOK
  if (!v || v === 'd' || v === 'c') return null; // MOCK-HOOK
  if (v === 'b') // MOCK-HOOK
    return ( // MOCK-HOOK
      <button type="button" data-mk="watch" aria-pressed={on} aria-label={on ? 'Stop watching' : 'Watch'} title={on ? 'Watching: click to stop' : 'Watch'} onClick={() => setWatched(itemKey, !on)} className={`grid h-7 w-7 flex-none place-items-center rounded-md hover:bg-surface2 ${on ? 'text-accent-ink' : 'text-text2'}`}> {/* MOCK-HOOK */}
        <Svg d={EYE} size={18} fill={on ? 'var(--color-accent-soft)' : 'none'} /> {/* MOCK-HOOK */}
      </button> // MOCK-HOOK
    ); // MOCK-HOOK
  return ( // MOCK-HOOK
    <div className="relative flex-none"> {/* MOCK-HOOK */}
      <button type="button" data-mk="watch" aria-expanded={open} onClick={() => setOpen(!open)} className={`${pill} ${on ? 'border-accent bg-accent-soft text-accent-ink' : 'text-text hover:bg-surface2'}`}> {/* MOCK-HOOK */}
        <Svg d={BELL} fill={on ? 'currentColor' : 'none'} /> {on ? 'Watching' : 'Watch'} {/* MOCK-HOOK */}
      </button> {/* MOCK-HOOK */}
      {open && ( // MOCK-HOOK
        <div role="dialog" aria-label="Watch" data-mk="watch-menu" className="absolute right-0 z-50 mt-1 w-64 rounded-lg border border-line bg-surface p-3 shadow-tip"> {/* MOCK-HOOK */}
          <p className="text-xs font-semibold tracking-[.06em] text-text2 uppercase">Tell me when</p> {/* MOCK-HOOK */}
          {EVENTS.map((e, k) => ( // MOCK-HOOK
            <label key={e} className="mt-2 flex items-center gap-2 text-sm"> {/* MOCK-HOOK */}
              <input type="checkbox" data-mk={`ev${k}`} checked={picked[k]} onChange={() => setPicked(picked.map((p, j) => (j === k ? !p : p)))} /> {e} {/* MOCK-HOOK */}
            </label> // MOCK-HOOK
          ))} {/* MOCK-HOOK */}
          <p className="mt-2 text-xs text-text2">Daily email at 8:00 AM · <a className="font-semibold text-accent-ink underline" href="/account?wd3=a">Change</a></p> {/* MOCK-HOOK */}
          <div className="mt-3 flex gap-2"> {/* MOCK-HOOK */}
            <button type="button" data-mk="watch-save" onClick={() => { setWatched(itemKey, true); setOpen(false); setSaid(`Watching ${code ?? ''} ${title}`); }} className="h-8 rounded-md bg-accent px-3 text-sm font-semibold text-on-accent">{on ? 'Save' : 'Watch'}</button> {/* MOCK-HOOK */}
            {on && <button type="button" onClick={() => { setWatched(itemKey, false); setOpen(false); setSaid(null); }} className="h-8 rounded-md px-3 text-sm font-semibold text-accent-ink hover:bg-surface2">Stop watching</button>} {/* MOCK-HOOK */}
          </div> {/* MOCK-HOOK */}
        </div> // MOCK-HOOK
      )} {/* MOCK-HOOK */}
      {said && on && !open && ( // MOCK-HOOK
        <div role="status" data-mk="toast" className="fixed right-6 bottom-6 z-[60] flex items-center gap-3 rounded-lg bg-tip px-4 py-3 text-sm text-tip-text shadow-tip"> {/* MOCK-HOOK */}
          <span>✓ {said}</span> {/* MOCK-HOOK */}
          <button type="button" className="font-semibold underline" onClick={() => setWatched(itemKey, false)}>Undo</button> {/* MOCK-HOOK */}
        </div> // MOCK-HOOK
      )} {/* MOCK-HOOK */}
    </div> // MOCK-HOOK
  ); // MOCK-HOOK
} // MOCK-HOOK

/** WD1 c and d: a line under the panel's head (who watches / why I hear about it). */
export function WatchLineMk({ itemKey, canChange }: { itemKey: string; canChange: boolean }) { // MOCK-HOOK
  const v = mk.wd1(); // MOCK-HOOK
  const w = useWatched(); // MOCK-HOOK
  const on = w.has(itemKey); // MOCK-HOOK
  const [adding, setAdding] = useState(mk.step() === 'open' || mk.step() === 'mid'); // MOCK-HOOK
  const [extra, setExtra] = useState<string[]>(mk.step() === 'mid' || mk.step() === 'done' ? ['Rae Okafor'] : []); // MOCK-HOOK
  const [muted, setMuted] = useState(false); // MOCK-HOOK
  if (v === 'c') { // MOCK-HOOK
    const many = mk.n() === 'many'; // MOCK-HOOK
    const who = [...(on ? ['You'] : []), ...extra, ...(many ? MK_WATCHERS.slice(1) : itemKey === 'alert-digest' ? ['Jonah Prell'] : [])]; // MOCK-HOOK
    const askOnly = mk.role() === 'commenter' || !canChange; // MOCK-HOOK
    return ( // MOCK-HOOK
      <div data-mk="watchers" className="mt-3 rounded-lg border border-line p-2.5"> {/* MOCK-HOOK */}
        <div className="flex items-center gap-2 text-sm"> {/* MOCK-HOOK */}
          <span className="w-20 flex-none text-text2">Watchers</span> {/* MOCK-HOOK */}
          <span className="min-w-0 flex-1 truncate">{who.length ? (who.length > 3 ? `${who.slice(0, 3).join(', ')} +${who.length - 3}` : who.join(', ')) : 'Nobody yet'}</span> {/* MOCK-HOOK */}
          <button type="button" data-mk="watch" onClick={() => setWatched(itemKey, !on)} className={`${pill} ${on ? 'border-accent bg-accent-soft text-accent-ink' : ''}`}><Svg d={BELL} size={14} fill={on ? 'currentColor' : 'none'} />{on ? 'Watching' : 'Watch'}</button> {/* MOCK-HOOK */}
        </div> {/* MOCK-HOOK */}
        {!adding ? ( // MOCK-HOOK
          <button type="button" data-mk="add-watcher" onClick={() => setAdding(true)} className="mt-1 ml-[88px] text-sm font-semibold text-accent-ink">{askOnly ? 'Ask someone to watch' : 'Add someone'}</button> // MOCK-HOOK
        ) : ( // MOCK-HOOK
          <div className="mt-2 ml-[88px]" data-mk="watcher-pick"> {/* MOCK-HOOK */}
            <input aria-label="Who" defaultValue={mk.step() === 'mid' ? 'Ra' : ''} placeholder="A name" className="h-8 w-full rounded-md border border-line bg-surface px-2 text-sm" /> {/* MOCK-HOOK */}
            {MK_WATCHERS.slice(1, mk.step() === 'mid' ? 2 : 5).map((p) => ( // MOCK-HOOK
              <button key={p} type="button" data-mk={`pick-${p.split(' ')[0]}`} onClick={() => { setExtra([...extra, p]); setAdding(false); }} className="block w-full rounded-md px-2 py-1 text-left text-sm hover:bg-surface2">{p} <span className="text-text2">· {askOnly ? 'asks them' : 'watches from now'}</span></button> // MOCK-HOOK
            ))} {/* MOCK-HOOK */}
          </div> // MOCK-HOOK
        )} {/* MOCK-HOOK */}
      </div> // MOCK-HOOK
    ); // MOCK-HOOK
  } // MOCK-HOOK
  if (v === 'd') { // MOCK-HOOK
    const mine = itemKey === 'alert-digest' && mk.role() === 'owner'; // MOCK-HOOK
    return ( // MOCK-HOOK
      <div data-mk="follow-line" className="mt-3 flex items-center gap-2 rounded-lg bg-surface2 px-3 py-2 text-sm"> {/* MOCK-HOOK */}
        <Svg d={BELL} size={14} fill={mine && !muted ? 'currentColor' : 'none'} /> {/* MOCK-HOOK */}
        <span className="min-w-0 flex-1">{mine ? (muted ? 'Muted: you hear nothing about it' : 'You hear about it: you decide it') : 'You hear about what you own or decide'}</span> {/* MOCK-HOOK */}
        {mine && <button type="button" data-mk="mute" onClick={() => setMuted(!muted)} className="font-semibold text-accent-ink">{muted ? 'Unmute' : 'Mute'}</button>} {/* MOCK-HOOK */}
      </div> // MOCK-HOOK
    ); // MOCK-HOOK
  } // MOCK-HOOK
  return null; // MOCK-HOOK
} // MOCK-HOOK

/** WD1: a row's mark (a, c: a bell after a watched name; b: an eye that watches in one click). */
export function WatchRowMk({ itemKey }: { itemKey: string }) { // MOCK-HOOK
  const v = mk.wd1(); // MOCK-HOOK
  const w = useWatched(); // MOCK-HOOK
  const on = w.has(itemKey); // MOCK-HOOK
  if (!v || v === 'd') return null; // MOCK-HOOK
  if (v === 'b') // MOCK-HOOK
    return ( // MOCK-HOOK
      <span role="button" tabIndex={0} data-mk={`row-eye-${itemKey}`} aria-pressed={on} aria-label={on ? 'Stop watching' : 'Watch'} title={on ? 'Watching' : 'Watch'} onClick={(e) => { e.stopPropagation(); setWatched(itemKey, !on); }} className={`ml-auto grid h-6 w-6 flex-none place-items-center rounded ${on ? 'text-accent-ink' : 'text-text-faint'} hover:bg-surface2`}> {/* MOCK-HOOK */}
        <Svg d={EYE} size={15} fill={on ? 'var(--color-accent-soft)' : 'none'} /> {/* MOCK-HOOK */}
      </span> // MOCK-HOOK
    ); // MOCK-HOOK
  return on ? <span data-mk="row-bell" title="Watching" className="flex-none text-accent-ink"><Svg d={BELL} size={13} fill="currentColor" /></span> : null; // MOCK-HOOK
} // MOCK-HOOK

/** WD1 a, c: the Inbox's "Watching" list, where everything I watch is seen and stopped. */
export function WatchInboxMk() { // MOCK-HOOK
  const v = mk.wd1(); // MOCK-HOOK
  const [gone, setGone] = useState<string[]>([]); // MOCK-HOOK
  if (v !== 'a' || q('view') !== 'watching') return null; // MOCK-HOOK
  const list = MK_WATCHED.filter((x) => !gone.includes(x.code)); // MOCK-HOOK
  return ( // MOCK-HOOK
    <section data-mk="watching" className="mb-4 rounded-xl border border-line bg-surface"> {/* MOCK-HOOK */}
      <div className="flex items-center gap-2 border-b border-line px-4 py-3"><h2 className="text-base font-semibold">Watching <span className="text-accent-ink tnum">{list.length}</span></h2><span className="ml-auto text-sm text-text2">Daily email at 8:00 AM · Slack</span><a className="text-sm font-semibold text-accent-ink" href="/account?wd3=a">Change</a></div> {/* MOCK-HOOK */}
      <ul> {/* MOCK-HOOK */}
        {list.map((x) => ( // MOCK-HOOK
          <li key={x.code} className="flex items-center gap-3 border-b border-line/60 px-4 py-2.5 text-sm last:border-0"> {/* MOCK-HOOK */}
            <span className="w-20 flex-none text-text2">{x.kind}</span> {/* MOCK-HOOK */}
            <span className="min-w-0 flex-1 truncate"><span className="simple-code mr-1">{x.code}</span><a className="font-semibold text-accent-ink" href="#">{x.name}</a></span> {/* MOCK-HOOK */}
            <span className="w-32 flex-none text-text2">{x.reason}</span> {/* MOCK-HOOK */}
            <span className="w-32 flex-none text-text2">{x.tells}</span> {/* MOCK-HOOK */}
            <button type="button" data-mk={`stop-${x.code}`} onClick={() => setGone([...gone, x.code])} className="h-7 flex-none rounded-md border border-line px-2 text-sm font-semibold hover:bg-surface2">Stop</button> {/* MOCK-HOOK */}
          </li> // MOCK-HOOK
        ))} {/* MOCK-HOOK */}
      </ul> {/* MOCK-HOOK */}
    </section> // MOCK-HOOK
  ); // MOCK-HOOK
} // MOCK-HOOK

// ---------------------------------------------------------------- WD2: the message itself

const pluralDays = (n: number) => `${n} ${n === 1 ? 'day' : 'days'}`; // MOCK-HOOK

function SlackFrame({ children, time = '8:00 AM' }: { children: ReactNode; time?: string }) { // MOCK-HOOK
  return ( // MOCK-HOOK
    <div data-mk="slack" className="rounded-lg border border-line bg-surface p-4"> {/* MOCK-HOOK */}
      <p className="mb-3 border-b border-line pb-2 text-xs text-text2">Slack · direct message from Oracle</p> {/* MOCK-HOOK */}
      <div className="flex gap-3"><span className="grid h-9 w-9 flex-none place-items-center rounded-md bg-brand text-sm font-bold text-on-brand">O</span><div className="min-w-0 flex-1"><p className="text-sm"><b>Oracle</b> <span className="text-xs text-text2">APP · {time}</span></p>{children}</div></div> {/* MOCK-HOOK */}
    </div> // MOCK-HOOK
  ); // MOCK-HOOK
} // MOCK-HOOK

function EmailFrame({ subject, children }: { subject: string; children: ReactNode }) { // MOCK-HOOK
  return ( // MOCK-HOOK
    <div data-mk="email" className="rounded-lg border border-line bg-surface"> {/* MOCK-HOOK */}
      <div className="border-b border-line px-4 py-3 text-sm"><p className="text-xs text-text2">Email · From Oracle &lt;digest@example.com&gt; · To avery@example.com · Thu, Oct 22, 8:00 AM</p><p className="mt-1 text-lg font-semibold">{subject}</p></div> {/* MOCK-HOOK */}
      <div className="mx-auto max-w-[600px] px-4 py-4 text-sm">{children}</div> {/* MOCK-HOOK */}
    </div> // MOCK-HOOK
  ); // MOCK-HOOK
} // MOCK-HOOK

function SlipLine({ s, link = true }: { s: MkSlip; link?: boolean }) { // MOCK-HOOK
  return ( // MOCK-HOOK
    <li className="border-b border-line/60 py-2 last:border-0"> {/* MOCK-HOOK */}
      <p><span className="simple-code mr-1">{s.code}</span><b>{s.kind === 'Milestone' ? `Milestone ${s.name}` : s.name}</b> <span className="text-crit">{s.from} → {s.to} · {pluralDays(s.days)} later</span></p> {/* MOCK-HOOK */}
      <p className="text-text2">Why: {s.why}{s.past ? ` · now after ${s.past}` : ''}</p> {/* MOCK-HOOK */}
      {link && <a href="#" className="font-semibold text-accent-ink">Open in Oracle</a>} {/* MOCK-HOOK */}
    </li> // MOCK-HOOK
  ); // MOCK-HOOK
} // MOCK-HOOK

const Foot = ({ stop = 'Stop these digests' }: { stop?: string }) => ( // MOCK-HOOK
  <p className="mt-3 border-t border-line pt-2 text-xs text-text2">You watch 12 items. <a href="#" className="text-accent-ink underline">Change what you get</a> · <a href="/account?wd3=a&state=stopped" data-mk="stop-link" className="text-accent-ink underline">{stop}</a></p> // MOCK-HOOK
); // MOCK-HOOK

/** WD2: one digest, as Slack or email shows it. */
export function DigestMessageMk({ v, how }: { v: string; how: 'slack' | 'email' }) { // MOCK-HOOK
  const slips = mk.n() === 'many' ? MK_SLIPS_MANY : MK_SLIPS; // MOCK-HOOK
  const total = slips.length; // MOCK-HOOK
  if (v === 'b') { // one message per slip, as it happens
    const each = slips.slice(0, mk.n() === 'many' ? 8 : 1); // MOCK-HOOK
    return how === 'slack' ? ( // MOCK-HOOK
      <div className="space-y-2">{each.map((s, k) => ( // MOCK-HOOK
        <SlackFrame key={s.code} time={`${9 + Math.floor(k / 3)}:${String(10 + k * 7).slice(-2)} AM`}> {/* MOCK-HOOK */}
          <p className="text-sm"><span className="simple-code mr-1">{s.code}</span><b>{s.name}</b> moved <span className="text-crit">{s.from} → {s.to}</span> ({pluralDays(s.days)} later). {s.why}.</p> {/* MOCK-HOOK */}
          <div className="mt-2 flex gap-2"><span className={pill}>Open</span><span className={pill}>Stop watching</span></div> {/* MOCK-HOOK */}
        </SlackFrame> // MOCK-HOOK
      ))}</div> // MOCK-HOOK
    ) : ( // MOCK-HOOK
      <EmailFrame subject={`${each[0].code} ${each[0].name} moved ${pluralDays(each[0].days)} later`}> {/* MOCK-HOOK */}
        <ul><SlipLine s={each[0]} /></ul><Foot stop="Stop watching this" /> {/* MOCK-HOOK */}
      </EmailFrame> // MOCK-HOOK
    ); // MOCK-HOOK
  } // MOCK-HOOK
  if (v === 'c') { // weekly, grouped by goal
    const goals = [...new Set(slips.map((s) => s.goal))]; // MOCK-HOOK
    const days = slips.reduce((a, s) => a + s.days, 0); // MOCK-HOOK
    const body = ( // MOCK-HOOK
      <> {/* MOCK-HOOK */}
        <p className="text-sm">Week of Oct 19: <b>{total} items slipped</b>, {days} days in all.</p> {/* MOCK-HOOK */}
        {goals.map((g, k) => ( // MOCK-HOOK
          <div key={g} className="mt-3"> {/* MOCK-HOOK */}
            <p className="text-sm font-semibold">{g} <span className={k ? 'text-crit' : 'text-warn'}>· {k ? 'Behind: misses its date by 9 days' : 'At risk: 2 days of slack left'}</span></p> {/* MOCK-HOOK */}
            <ul className="mt-1 text-sm">{slips.filter((s) => s.goal === g).map((s) => <li key={s.code} className="py-0.5"><span className="simple-code mr-1">{s.code}</span>{s.name} <span className="text-crit">+{pluralDays(s.days)}</span> <span className="text-text2">· {s.to}</span></li>)}</ul> {/* MOCK-HOOK */}
          </div> // MOCK-HOOK
        ))} {/* MOCK-HOOK */}
      </> // MOCK-HOOK
    ); // MOCK-HOOK
    return how === 'slack' ? <SlackFrame time="Mon 8:00 AM">{body}<p className="mt-2 text-sm"><a href="#" className="font-semibold text-accent-ink">See the week in Oracle</a></p></SlackFrame> : <EmailFrame subject={`Your week: ${total} watched items slipped`}>{body}<Foot /></EmailFrame>; // MOCK-HOOK
  } // MOCK-HOOK
  // a: daily, only when something slipped
  const list = <ul className="mt-1 text-sm">{slips.map((s) => <SlipLine key={s.code} s={s} link={how === 'email'} />)}</ul>; // MOCK-HOOK
  return how === 'slack' ? ( // MOCK-HOOK
    <SlackFrame> {/* MOCK-HOOK */}
      <p className="text-sm"><b>{total} things you watch slipped</b> since yesterday</p> {/* MOCK-HOOK */}
      {list} {/* MOCK-HOOK */}
      <div className="mt-2 flex gap-2"><span className={pill}>Open in Oracle</span><span className={pill}>Mute for a week</span></div> {/* MOCK-HOOK */}
    </SlackFrame> // MOCK-HOOK
  ) : ( // MOCK-HOOK
    <EmailFrame subject={`${total} things you watch slipped since yesterday`}> {/* MOCK-HOOK */}
      <p>Good morning, Avery. Since yesterday, Oct 21 at 8:00 AM:</p> {/* MOCK-HOOK */}
      {list} {/* MOCK-HOOK */}
      <Foot /> {/* MOCK-HOOK */}
    </EmailFrame> // MOCK-HOOK
  ); // MOCK-HOOK
} // MOCK-HOOK

const OFTEN: Record<string, [string, string]> = { a: ['Every weekday at 8:00 AM', 'Only on days something slipped'], b: ['Right away', 'One message per change, as it happens'], c: ['Mondays at 8:00 AM', 'One message for the week, by goal'] }; // MOCK-HOOK

/** WD2: the digest section in Settings > Notifications, with its sample message. */
export function DigestMk() { // MOCK-HOOK
  const v = mk.wd2(); // MOCK-HOOK
  const [msg, setMsg] = useState<string | null>(q('msg')); // MOCK-HOOK
  const [time, setTime] = useState(q('step') === 'mid' ? '7:30 AM' : '8:00 AM'); // MOCK-HOOK
  if (!v) return null; // MOCK-HOOK
  const [often, sub] = OFTEN[v] ?? OFTEN.a; // MOCK-HOOK
  return ( // MOCK-HOOK
    <section data-mk="digest" className="mb-4 rounded-xl border border-line bg-surface"> {/* MOCK-HOOK */}
      <div className="flex items-center gap-2 border-b border-line px-4 py-3"><h2 className="text-base font-semibold">Digest of what I watch</h2></div> {/* MOCK-HOOK */}
      <div className="flex flex-wrap items-end gap-4 px-4 py-3 text-sm"> {/* MOCK-HOOK */}
        <div><p className="text-text2">How often</p><p className="font-semibold" data-mk="often">{often.replace('8:00 AM', time)}</p><p className="text-xs text-text2">{sub}</p></div> {/* MOCK-HOOK */}
        {v !== 'b' && <label className="flex flex-col text-text2">Time<select data-mk="time" value={time} onChange={(e) => setTime(e.target.value)} className="h-9 rounded-md border border-line bg-surface px-2 text-text">{['7:00 AM', '7:30 AM', '8:00 AM', '9:00 AM'].map((t) => <option key={t}>{t}</option>)}</select></label>} {/* MOCK-HOOK */}
        <div><p className="text-text2">By</p><p className="font-semibold">Email and Slack</p></div> {/* MOCK-HOOK */}
        <div className="ml-auto flex gap-1" role="tablist" aria-label="Sample"> {/* MOCK-HOOK */}
          {(['slack', 'email'] as const).map((h) => <button key={h} type="button" role="tab" aria-selected={msg === h} data-mk={`sample-${h}`} onClick={() => setMsg(msg === h ? null : h)} className={`h-8 rounded-md border px-3 font-semibold ${msg === h ? 'border-accent bg-accent-soft text-accent-ink' : 'border-line'}`}>{h === 'slack' ? 'See the Slack message' : 'See the email'}</button>)} {/* MOCK-HOOK */}
        </div> {/* MOCK-HOOK */}
      </div> {/* MOCK-HOOK */}
      {q('step') === 'mid' && <p role="status" className="px-4 pb-2 text-sm font-semibold text-pass">✓ Saved: next digest Fri, Oct 23 at {time}</p>} {/* MOCK-HOOK */}
      {msg && <div className="border-t border-line bg-bg p-4" data-mk="sample">{<DigestMessageMk v={v} how={msg as 'slack' | 'email'} />}</div>} {/* MOCK-HOOK */}
    </section> // MOCK-HOOK
  ); // MOCK-HOOK
} // MOCK-HOOK

// ---------------------------------------------------------------- WD3: settings and states

function Toggle({ on, label, dis, onClick, mkId }: { on: boolean; label: string; dis?: boolean; onClick?: () => void; mkId?: string }) { // MOCK-HOOK
  return <button type="button" role="switch" aria-checked={on} aria-label={label} disabled={dis} data-mk={mkId} onClick={onClick} className={`relative h-5 w-9 flex-none rounded-full ${on ? 'bg-accent' : 'bg-line-strong'} ${dis ? 'opacity-50' : ''}`}><i className={`absolute top-0.5 h-4 w-4 rounded-full bg-surface transition-all ${on ? 'left-[18px]' : 'left-0.5'}`} /></button>; // MOCK-HOOK
} // MOCK-HOOK

/** WD3: my digests, the company's defaults and the states (no Slack, quiet, stopped). */
export function DigestSettingsMk({ place = 'account' }: { place?: 'account' | 'company' }) { // MOCK-HOOK
  const v = mk.wd3(); // MOCK-HOOK
  const st = q('state'); // MOCK-HOOK
  const noSlack = st === 'noslack' || st === 'asked'; // MOCK-HOOK
  const [email, setEmail] = useState(st !== 'stopped'); // MOCK-HOOK
  const [slack, setSlack] = useState(!noSlack && st !== 'stopped'); // MOCK-HOOK
  const [asked, setAsked] = useState(st === 'asked'); // MOCK-HOOK
  const [stopped, setStopped] = useState(st === 'stopped'); // MOCK-HOOK
  if (place === 'company') return v && st === 'owner' ? <CompanyDefaultsMk v={v} /> : null; // MOCK-HOOK
  if (!v) return null; // MOCK-HOOK
  const stoppedBar = stopped && ( // MOCK-HOOK
    <div role="status" data-mk="stopped" className="mb-4 flex items-center gap-3 rounded-xl border border-line bg-surface px-4 py-3 text-sm"> {/* MOCK-HOOK */}
      <span className="font-semibold text-pass">✓ {v === 'b' ? 'Stopped watching F-79 Weekly alert digest' : 'Digests stopped'}</span> {/* MOCK-HOOK */}
      <span className="text-text2">{v === 'b' ? 'Your other 11 items still send' : 'Slips still show in your Inbox'}</span> {/* MOCK-HOOK */}
      <button type="button" data-mk="undo-stop" onClick={() => { setStopped(false); setEmail(true); setSlack(true); }} className="ml-auto font-semibold text-accent-ink">{v === 'b' ? 'Watch again' : 'Turn back on'}</button> {/* MOCK-HOOK */}
      {v !== 'b' && <a href="#" className="font-semibold text-accent-ink">Less often instead</a>} {/* MOCK-HOOK */}
    </div> // MOCK-HOOK
  ); // MOCK-HOOK
  if (v === 'c') // set from the message: a short Delivery line and the owner's defaults only
    return ( // MOCK-HOOK
      <> {/* MOCK-HOOK */}
        {stoppedBar} {/* MOCK-HOOK */}
        <section data-mk="delivery" className="mb-4 rounded-xl border border-line bg-surface px-4 py-3 text-sm"> {/* MOCK-HOOK */}
          <p><b>My digest</b> <span className="text-text2">· {stopped ? 'Stopped' : noSlack ? 'Daily email at 8:00 AM (Slack is not connected)' : 'Daily, Slack at 8:00 AM, email if Slack is unread by noon'}</span></p> {/* MOCK-HOOK */}
          <p className="mt-1 text-text2">Change it from any digest: reply <b>weekly</b>, <b>email only</b> or <b>stop</b>.</p> {/* MOCK-HOOK */}
          {st === 'quiet' && <p role="status" data-mk="quiet" className="mt-1 font-semibold text-pass">✓ Nothing you watch slipped since Oct 21: nothing sent today</p>} {/* MOCK-HOOK */}
        </section> {/* MOCK-HOOK */}
      </> // MOCK-HOOK
    ); // MOCK-HOOK
  const quiet = st === 'quiet' && ( // MOCK-HOOK
    <p role="status" data-mk="quiet" className="text-sm font-semibold text-pass">✓ Nothing you watch slipped since Oct 21: no digest sent today</p> // MOCK-HOOK
  ); // MOCK-HOOK
  return ( // MOCK-HOOK
    <> {/* MOCK-HOOK */}
      {stoppedBar} {/* MOCK-HOOK */}
      <section data-mk="my-digests" className="mb-4 rounded-xl border border-line bg-surface"> {/* MOCK-HOOK */}
        <div className="flex items-center gap-2 border-b border-line px-4 py-3"><h2 className="text-base font-semibold">{v === 'b' ? 'Where each watched item tells me' : 'My digests'}</h2><span className="ml-auto text-xs text-text2">Just for you</span></div> {/* MOCK-HOOK */}
        <div className="space-y-3 px-4 py-3 text-sm"> {/* MOCK-HOOK */}
          {quiet} {/* MOCK-HOOK */}
          {v === 'a' ? ( // MOCK-HOOK
            <> {/* MOCK-HOOK */}
              <div className="flex items-center gap-3"><Toggle on label="Inbox" dis /><span className="w-24 font-semibold">Inbox</span><span className="text-text2">Always, as it happens</span></div> {/* MOCK-HOOK */}
              <div className="flex items-center gap-3"><Toggle on={email && !stopped} label="Email" mkId="email" onClick={() => setEmail(!email)} /><span className="w-24 font-semibold">Email</span><span className="text-text2">Every weekday at 8:00 AM, only when something slipped</span></div> {/* MOCK-HOOK */}
              <div className="flex items-center gap-3"><Toggle on={slack && !stopped} label="Slack" dis={noSlack} mkId="slack" onClick={() => setSlack(!slack)} /><span className="w-24 font-semibold">Slack</span>{noSlack ? <span className="text-text2">Slack is not connected for the company. {asked ? <b className="text-pass" data-mk="asked">✓ Asked Avery Stone to connect it</b> : <button type="button" data-mk="ask-owner" onClick={() => setAsked(true)} className="font-semibold text-accent-ink">Ask an owner</button>}</span> : <span className="text-text2">Direct message at 8:00 AM</span>}</div> {/* MOCK-HOOK */}
            </> // MOCK-HOOK
          ) : ( // b: per item, set where you watch it; this page lists them
            <> {/* MOCK-HOOK */}
              <p className="text-text2">Each item keeps its own way to tell you, set from its Watch menu.</p> {/* MOCK-HOOK */}
              <table className="w-full"><tbody>{MK_WATCHED.slice(0, st === 'many' ? 12 : 5).map((x, k) => <tr key={x.code} className="border-t border-line/60"><td className="py-1.5"><span className="simple-code mr-1">{x.code}</span>{x.name}</td><td className="w-20">{k % 3 ? 'Email' : 'Slack'}</td><td className="w-28 text-text2">{k % 2 ? 'Right away' : 'Daily 8:00 AM'}</td></tr>)}</tbody></table> {/* MOCK-HOOK */}
              {noSlack && <p className="text-text2">Slack is not connected: Slack items send email instead. {asked ? <b className="text-pass" data-mk="asked">✓ Asked Avery Stone</b> : <button type="button" data-mk="ask-owner" onClick={() => setAsked(true)} className="font-semibold text-accent-ink">Ask an owner</button>}</p>} {/* MOCK-HOOK */}
            </> // MOCK-HOOK
          )} {/* MOCK-HOOK */}
        </div> {/* MOCK-HOOK */}
      </section> {/* MOCK-HOOK */}
    </> // MOCK-HOOK
  ); // MOCK-HOOK
} // MOCK-HOOK

function CompanyDefaultsMk({ v }: { v: string }) { // MOCK-HOOK
  const [force, setForce] = useState(false); // MOCK-HOOK
  return ( // MOCK-HOOK
    <section data-mk="company-defaults" className="mb-4 rounded-xl border border-line bg-surface"> {/* MOCK-HOOK */}
      <div className="flex items-center gap-2 border-b border-line px-4 py-3"><h2 className="text-base font-semibold">Company defaults</h2><span className="ml-auto text-xs text-text2">Owners only · 38 people</span></div> {/* MOCK-HOOK */}
      <div className="space-y-2 px-4 py-3 text-sm"> {/* MOCK-HOOK */}
        <div className="flex items-center gap-3"><Toggle on label="Owners and deciders watch theirs" /><span>Owners and deciders watch their own items</span></div> {/* MOCK-HOOK */}
        <div className="flex items-center gap-3"><span className="w-40 text-text2">New people get</span><b>{v === 'c' ? 'Slack daily, email if unread' : 'Daily email at 8:00 AM'}</b></div> {/* MOCK-HOOK */}
        <div className="flex items-center gap-3"><span className="w-40 text-text2">Digest goes to channel</span><b>#roadmap-slips</b><span className="text-text2">· goals only</span></div> {/* MOCK-HOOK */}
        <div className="flex items-center gap-3"><Toggle on={force} label="Apply to everyone now" mkId="apply-all" onClick={() => setForce(!force)} /><span>Apply to the 31 people who never changed theirs</span>{force && <b className="text-pass">✓ Applied to 31 people</b>}</div> {/* MOCK-HOOK */}
      </div> {/* MOCK-HOOK */}
    </section> // MOCK-HOOK
  ); // MOCK-HOOK
} // MOCK-HOOK
