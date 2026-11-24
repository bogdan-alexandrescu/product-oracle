// MOCK-HOOK: this whole file is a mock-up (saved and shared views, SV1..SV3), switched by ?sv1= ?sv2= ?sv3=; never merged.
/* eslint-disable */ // MOCK-HOOK
import { useEffect, useState, type ReactNode } from 'react'; // MOCK-HOOK

type Kind = 'built' | 'mine' | 'shared'; // MOCK-HOOK
type View = { id: string; name: string; kind: Kind; by?: string; filters: string[]; count: number; team?: boolean; rights?: string }; // MOCK-HOOK

const BUILT: View[] = [ // MOCK-HOOK
  { id: 'all', name: 'All items', kind: 'built', filters: [], count: 19 }, // MOCK-HOOK
  { id: 'past', name: 'Past end date', kind: 'built', filters: ['Status: past end date, not done'], count: 4 }, // MOCK-HOOK
  { id: 'low', name: 'Low confidence', kind: 'built', filters: ['Confidence: below 50%'], count: 6 }, // MOCK-HOOK
  { id: 'drafts', name: 'Unowned drafts', kind: 'built', filters: ['Draft', 'Owner: no owner'], count: 3 }, // MOCK-HOOK
  { id: 'mine', name: 'Mine', kind: 'built', filters: ['Owner: Avery Stone'], count: 5 }, // MOCK-HOOK
]; // MOCK-HOOK
const SAVED: View[] = [ // MOCK-HOOK
  { id: 'alerts', name: 'Alerts launch review', kind: 'mine', filters: ['PRD: Usage alerts', 'Status: past end date, not done'], count: 7 }, // MOCK-HOOK
  { id: 'q1', name: 'Q1 retention check', kind: 'shared', by: 'Rosa Lind', filters: ['Goal: Grow retention', 'Confidence: below 50%'], count: 3, team: true, rights: 'Owners and approvers' }, // MOCK-HOOK
]; // MOCK-HOOK
const LONG: View[] = [ // MOCK-HOOK
  ['Everything the onboarding team still owes before the spring pricing launch', 'shared', 'Jordan Reyes'], // MOCK-HOOK
  ['Usage alerts items past their end date that nobody owns yet', 'mine'], // MOCK-HOOK
  ['Low confidence bets on paid conversions per rep per day', 'shared', 'Mei Tanaka'], // MOCK-HOOK
  ['Guided setup drafts waiting for an owner and a date', 'mine'], // MOCK-HOOK
  ['Q2 2027 board review: revenue per day and retention', 'shared', 'Rosa Lind'], // MOCK-HOOK
  ['Mobile alert push and everything it depends on', 'mine'], // MOCK-HOOK
  ['Weekly digest follow-ups for the customer conference', 'shared', 'Jordan Reyes'], // MOCK-HOOK
  ['Pricing roadmap items with confidence under thirty percent', 'mine'], // MOCK-HOOK
  ['Mine, plus whatever Jordan Reyes handed over in October', 'mine'], // MOCK-HOOK
  ['Welcome media track, not done, ending this quarter', 'shared', 'Mei Tanaka'], // MOCK-HOOK
].map(([name, kind, by], i) => ({ id: `l${i}`, name, kind: kind as Kind, by, filters: ['Goal: Grow retention'], count: 2 + ((i * 3) % 7), team: kind === 'shared' })); // MOCK-HOOK

const q = () => new URLSearchParams(typeof window === 'undefined' ? '' : window.location.search); // MOCK-HOOK
const card = 'rounded-xl border border-line-strong bg-surface shadow-lg'; // MOCK-HOOK
const head = 'px-3 pt-3 pb-1 text-xs font-semibold text-text2'; // MOCK-HOOK
const btn = 'inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-lg border border-line-strong bg-surface px-3 text-sm font-semibold text-text hover:bg-surface2'; // MOCK-HOOK
const solid = 'inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-lg bg-accent px-3 text-sm font-semibold text-on-accent'; // MOCK-HOOK
const ghost = 'inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-lg px-2.5 text-sm font-medium text-text2 hover:bg-surface2'; // MOCK-HOOK
const link = 'text-sm font-medium text-accent-ink underline'; // MOCK-HOOK

function Tick({ children }: { children: ReactNode }) { // MOCK-HOOK
  return <span className="inline-flex items-center gap-1 text-sm font-medium text-pass" data-testid="sv-tick">✓ {children}</span>; // MOCK-HOOK
} // MOCK-HOOK
function Dot() { // MOCK-HOOK
  return <span aria-hidden className="inline-block size-2 rounded-full bg-warn" />; // MOCK-HOOK
} // MOCK-HOOK
function Who({ v }: { v: View }) { // MOCK-HOOK
  if (v.kind === 'built') return null; // MOCK-HOOK
  return <span className="shrink-0 text-xs text-text2">{v.kind === 'mine' ? 'Only me' : `Everyone · ${v.by}`}</span>; // MOCK-HOOK
} // MOCK-HOOK

/** The new filters every proposal shares: Status, Confidence, Draft, beside the page's own. */
function NewFilters({ on }: { on: string[] }) { // MOCK-HOOK
  const has = (k: string) => on.find((f) => f.startsWith(k)); // MOCK-HOOK
  const sel = (label: string, val: string | undefined, opts: string[]) => ( // MOCK-HOOK
    <label className="flex items-center gap-1.5 text-sm text-text2">{label}<select aria-label={label} defaultValue={val ? val.split(': ')[1] : ''} className="h-8 max-w-[14rem] rounded-lg border border-line-strong bg-surface px-2 text-sm text-text [field-sizing:content]"><option value="">All</option>{opts.map((o) => <option key={o} value={o}>{o}</option>)}</select></label> // MOCK-HOOK
  ); // MOCK-HOOK
  return ( // MOCK-HOOK
    <span className="contents"> {/* MOCK-HOOK */}
      {sel('Status', has('Status'), ['past end date, not done', 'not started', 'in progress', 'done'])} {/* MOCK-HOOK */}
      {sel('Confidence', has('Confidence'), ['below 50%', '50% to 80%', 'above 80%'])} {/* MOCK-HOOK */}
      <label className="flex items-center gap-1.5 text-sm text-text2"><input type="checkbox" defaultChecked={!!has('Draft')} className="size-4 accent-[var(--accent)]" />Drafts only</label> {/* MOCK-HOOK */}
    </span> // MOCK-HOOK
  ); // MOCK-HOOK
} // MOCK-HOOK

function SaveForm({ name, sv2, onDone }: { name: string; sv2: string; onDone?: () => void }) { // MOCK-HOOK
  const p = q(); // MOCK-HOOK
  const share = p.get('share') ?? 'me'; // MOCK-HOOK
  const seg = (opts: [string, string][], pick: string, label: string) => ( // MOCK-HOOK
    <div className="flex flex-col gap-1"><span className="text-xs font-semibold text-text2">{label}</span><div role="radiogroup" aria-label={label} className="inline-flex w-fit rounded-lg border border-line-strong p-0.5">{opts.map(([k, t]) => <button key={k} type="button" role="radio" aria-checked={pick === k} className={`h-7 rounded-md px-2.5 text-sm font-medium ${pick === k ? 'bg-accent text-on-accent' : 'text-text2'}`}>{t}</button>)}</div></div> // MOCK-HOOK
  ); // MOCK-HOOK
  return ( // MOCK-HOOK
    <form className="flex flex-col gap-3 p-3" data-testid="sv-save-form" onSubmit={(e) => (e.preventDefault(), onDone?.())}> {/* MOCK-HOOK */}
      <label className="flex flex-col gap-1 text-xs font-semibold text-text2">Name<input autoFocus={!!name} defaultValue={name} placeholder="Name this view" className="h-9 rounded-lg border border-accent bg-surface px-2 text-sm font-normal text-text outline-2 outline-accent/30" /></label> {/* MOCK-HOOK */}
      {(sv2 === 'a' || sv2 === 'c') && (q().get('as') ?? 'owner') !== 'viewer' && seg([['me', 'Only me'], ['all', 'Everyone']], share, 'Who sees it')} {/* MOCK-HOOK */}
      {sv2 === 'c' && seg([['me', 'Just me'], ['oa', 'Owners and approvers'], ['ed', 'Anyone who can edit']], p.get('rights') ?? 'me', 'Who can change it')} {/* MOCK-HOOK */}
      {sv2 === 'd' && (q().get('as') ?? 'owner') === 'owner' && <label className="flex items-center gap-2 text-sm text-text"><input type="checkbox" defaultChecked={share === 'all'} className="size-4" />Make it a team view<span className="text-xs text-text2">(i)</span></label>} {/* MOCK-HOOK */}
      <div className="flex gap-2"><button type="submit" className={solid}>Save view</button><button type="button" className={ghost}>Cancel</button></div> {/* MOCK-HOOK */}
    </form> // MOCK-HOOK
  ); // MOCK-HOOK
} // MOCK-HOOK

export function MockSavedViews({ page }: { page: 'roadmap' | 'priorities' | 'detailed' }) { // MOCK-HOOK
  const [, force] = useState(0); // MOCK-HOOK
  const [phone, setPhone] = useState(false); // MOCK-HOOK
  useEffect(() => { const m = window.matchMedia('(max-width: 639px)'); setPhone(m.matches); force(1); }, []); // MOCK-HOOK
  const p = q(); // MOCK-HOOK
  const sv1 = p.get('sv1'), sv2 = p.get('sv2'), sv3 = p.get('sv3'); // MOCK-HOOK
  if (!sv1 && !sv2 && !sv3) return null; // MOCK-HOOK
  const place = sv1 ?? (sv3 === 'c' ? 'a' : 'b'); // MOCK-HOOK
  const open = p.get('open') ?? ''; // MOCK-HOOK
  const phase = p.get('phase') ?? ''; // MOCK-HOOK
  const as = p.get('as') ?? 'owner'; // MOCK-HOOK
  const many = p.get('many') === '1'; // MOCK-HOOK
  const edited = p.get('edited') === '1'; // MOCK-HOOK
  const typed = p.get('name') ?? ''; // MOCK-HOOK
  const removed = p.get('removed'); // MOCK-HOOK
  const renamed = p.get('renamed'); // MOCK-HOOK
  const mode = sv2 ?? ''; // MOCK-HOOK
  let saved = SAVED.map((v) => (renamed && v.id === 'alerts' ? { ...v, name: renamed } : v)); // MOCK-HOOK
  if (p.get('added')) saved = [...saved, { id: 'new', name: p.get('added')!, kind: (p.get('share') === 'all' ? 'shared' : 'mine') as Kind, by: 'Avery Stone', filters: ['Goal: Grow retention', 'Confidence: below 50%', 'Draft'], count: 2, team: p.get('share') === 'all', rights: p.get('rights') === 'oa' ? 'Owners and approvers' : undefined }]; // MOCK-HOOK
  if (many) saved = [...saved, ...LONG]; // MOCK-HOOK
  if (mode === 'b') saved = saved.map((v) => ({ ...v, kind: 'mine' as Kind, by: undefined })); // MOCK-HOOK
  const all = [...BUILT, ...saved]; // MOCK-HOOK
  const cur = all.find((v) => v.id === (p.get('cur') ?? 'all')) ?? BUILT[0]; // MOCK-HOOK
  const curName = cur.name; // MOCK-HOOK
  const canChangeShared = cur.kind !== 'shared' || (as === 'owner' && mode !== 'd') || (mode === 'd' && as === 'owner'); // MOCK-HOOK
  const filters = [...cur.filters, ...(edited ? ['Draft'] : [])]; // MOCK-HOOK
  const cost = p.get('cost'); // MOCK-HOOK
  const toast = p.get('toast'); // MOCK-HOOK

  const editedBits = edited && ( // MOCK-HOOK
    mode === 'c' && !canChangeShared ? ( // MOCK-HOOK
      <span className="flex flex-wrap items-center gap-2 text-sm text-text2"><Dot />Only owners and approvers can change {curName} <button className={btn}>Save as my view</button><button className={ghost}>Undo changes</button></span> // MOCK-HOOK
    ) : cur.kind === 'shared' && as !== 'owner' ? ( // MOCK-HOOK
      <span className="flex flex-wrap items-center gap-2 text-sm text-text2"><Dot />Edited <button className={btn} data-testid="sv-suggest">Suggest this change</button><button className={btn}>Save as my view</button><button className={ghost}>Undo changes</button></span> // MOCK-HOOK
    ) : cur.kind === 'built' ? ( // MOCK-HOOK
      <span className="flex flex-wrap items-center gap-2 text-sm text-text2"><Dot />Edited <button className={solid}>Save as a view</button><button className={ghost}>Undo changes</button></span> // MOCK-HOOK
    ) : ( // MOCK-HOOK
      <span className="flex flex-wrap items-center gap-2 text-sm text-text2"><Dot />Edited <button className={solid}>Save</button><button className={btn}>Save as new</button><button className={ghost}>Undo changes</button></span> // MOCK-HOOK
    ) // MOCK-HOOK
  ); // MOCK-HOOK
  const doneTick = phase === 'done' && <Tick>{mode === 'b' && sv2 ? 'Link copied' : p.get('share') === 'all' ? (mode === 'd' ? 'Saved as a team view' : 'Saved, everyone sees it') : renamed ? 'Renamed' : 'Saved, only you see it'}</Tick>; // MOCK-HOOK

  // One row of a views list (menu, side list, manage sheet).
  const row = (v: View, extra?: ReactNode) => ( // MOCK-HOOK
    <div key={v.id} role="menuitemradio" aria-checked={v.id === cur.id} data-testid="sv-row" className={`flex min-h-9 items-center gap-2 rounded-lg px-3 py-1.5 text-sm ${v.id === cur.id ? 'bg-accent-soft font-semibold text-accent-ink' : 'text-text hover:bg-surface2'} ${removed === v.id ? 'line-through opacity-60' : ''}`}> {/* MOCK-HOOK */}
      <span className="w-4 shrink-0 text-accent-ink">{v.id === cur.id ? '✓' : ''}</span> {/* MOCK-HOOK */}
      <span className={`min-w-0 flex-1 line-clamp-2`} title={v.name}>{v.name}</span> {/* MOCK-HOOK */}
      {mode === 'c' && v.rights && <span className="shrink-0 text-xs text-text2">🔒</span>} {/* MOCK-HOOK */}
      {sv2 && <Who v={v} />} {/* MOCK-HOOK */}
      <span className="shrink-0 text-xs tabular-nums text-text2">{v.count}</span> {/* MOCK-HOOK */}
      {extra} {/* MOCK-HOOK */}
    </div> // MOCK-HOOK
  ); // MOCK-HOOK
  const groups = (wrap = false) => { // MOCK-HOOK
    const mine = saved.filter((v) => v.kind === 'mine'), shared = saved.filter((v) => v.kind !== 'mine'); // MOCK-HOOK
    const sub = (v: View) => sv3 === 'b' && open === 'more' && v.id === 'alerts' ? ( // MOCK-HOOK
      <div className="relative"><button className="rounded-md px-1.5 text-text2 bg-surface2" aria-label="More for this view">⋯</button> {/* MOCK-HOOK */}
        <div role="menu" className={`${card} absolute left-full top-0 ml-2 z-30 flex w-48 flex-col p-1 font-normal text-text`}>{['Rename', 'Move up', 'Move down', 'Make it the default', 'Copy link', 'Remove'].map((t) => <button key={t} className={`rounded-md px-3 py-1.5 text-left text-sm hover:bg-surface2 ${t === 'Rename' ? 'bg-surface2' : ''} ${t === 'Remove' ? 'text-crit' : ''}`}>{t}</button>)}</div></div> // MOCK-HOOK
    ) : sv3 === 'b' && v.kind !== 'built' ? <button className="rounded-md px-1.5 text-text2" aria-label="More for this view">⋯</button> : null; // MOCK-HOOK
    const renaming = (v: View) => sv3 === 'b' && phase === 'mid' && v.id === 'alerts' ? ( // MOCK-HOOK
      <div key={v.id} className="flex items-center gap-2 px-3 py-1"><input defaultValue={typed || v.name} autoFocus className="h-8 min-w-0 flex-1 rounded-lg border border-accent bg-surface px-2 text-sm" /><button className={solid}>Save</button></div> // MOCK-HOOK
    ) : null; // MOCK-HOOK
    const list = (vs: View[]) => vs.map((v) => renaming(v) ?? (removed === v.id && sv3 === 'b' ? <div key={v.id} className="flex items-center gap-2 px-3 py-1.5 text-sm text-text2">Removed {v.name.slice(0, 28)}{v.name.length > 28 ? '…' : ''} <button className={link}>Undo</button></div> : row(v, sub(v)))); // MOCK-HOOK
    return ( // MOCK-HOOK
      <> {/* MOCK-HOOK */}
        {mode === 'd' && <><div className={head}>Team views · set by owners</div>{list(shared)}</>} {/* MOCK-HOOK */}
        <div className={head}>Built in</div>{list(BUILT)} {/* MOCK-HOOK */}
        {mode === 'd' ? <><div className={head}>Mine</div>{list(mine)}</> : sv2 && mode !== 'b' ? <><div className={head}>Mine · only you see these</div>{list(mine)}<div className={head}>Shared with everyone</div>{list(shared)}</> : <><div className={head}>Saved</div>{list(saved)}</>} {/* MOCK-HOOK */}
      </> // MOCK-HOOK
    ); // MOCK-HOOK
  }; // MOCK-HOOK
  const footer = ( // MOCK-HOOK
    <div className="mt-1 flex flex-col border-t border-line p-1"> {/* MOCK-HOOK */}
      <button className="rounded-md px-3 py-2 text-left text-sm font-medium text-accent-ink hover:bg-surface2" data-testid="sv-save">+ Save these filters as a view</button> {/* MOCK-HOOK */}
      {(mode === 'a' || mode === 'b' || mode === 'd') && <button className="rounded-md px-3 py-2 text-left text-sm text-text hover:bg-surface2">Copy link to these filters</button>} {/* MOCK-HOOK */}
      {sv3 !== 'b' && <button className="rounded-md px-3 py-2 text-left text-sm text-text hover:bg-surface2" data-testid="sv-manage">Manage views</button>} {/* MOCK-HOOK */}
    </div> // MOCK-HOOK
  ); // MOCK-HOOK
  const saveOpen = open === 'save'; // MOCK-HOOK
  const panelBody = saveOpen ? <SaveForm name={typed} sv2={mode} /> : <>{groups()}{footer}</>; // MOCK-HOOK
  const popover = (cls: string) => phone ? ( // MOCK-HOOK
    <div className="fixed inset-0 z-40 flex flex-col justify-end bg-black/30"><div role="menu" className="max-h-[80vh] overflow-y-auto rounded-t-2xl border-t border-line-strong bg-surface pb-4"><div className="flex items-center justify-between px-3 pt-3"><span className="text-base font-semibold text-text">{saveOpen ? 'Save these filters' : 'Views'}</span><button className={ghost} aria-label="Close">✕</button></div>{panelBody}</div></div> // MOCK-HOOK
  ) : <div role="menu" data-testid="sv-menu" className={`${card} absolute z-30 ${cls} max-h-[70vh] ${open === 'more' ? 'overflow-visible' : 'overflow-y-auto'} py-1`}>{panelBody}</div>; // MOCK-HOOK

  // SV3 a: the Manage views sheet.
  const manage = sv3 === 'a' && (open === 'manage') && ( // MOCK-HOOK
    <div className={`fixed z-40 flex flex-col border-line-strong bg-surface shadow-2xl ${phone ? 'inset-0' : 'inset-y-0 right-0 w-[30rem] border-l'}`} data-testid="sv-manage-sheet"> {/* MOCK-HOOK */}
      <div className="flex items-center justify-between border-b border-line px-4 py-3"><span className="text-base font-semibold text-text">Manage views</span><button className={ghost} aria-label="Close">✕</button></div> {/* MOCK-HOOK */}
      <div className="flex-1 overflow-y-auto p-2"> {/* MOCK-HOOK */}
        {[...BUILT, ...saved].map((v, i) => removed === v.id ? null : ( // MOCK-HOOK
          <div key={v.id} className={`flex items-center gap-2 rounded-lg border px-2 py-1.5 ${p.get('drag') === v.id ? 'border-accent bg-accent-soft shadow-lg' : 'border-transparent'} hover:bg-surface2`}> {/* MOCK-HOOK */}
            <span className="cursor-grab text-text2" aria-label="Drag to reorder">⠿</span> {/* MOCK-HOOK */}
            {phase === 'mid' && v.id === 'alerts' ? <input defaultValue={typed} autoFocus className="h-8 min-w-0 flex-1 rounded-lg border border-accent bg-surface px-2 text-sm" /> : <button className={`min-w-0 flex-1 text-left text-sm text-text ${many ? 'line-clamp-2' : 'truncate'}`} title="Rename">{v.name}{renamed && v.id === 'alerts' && <span className="ml-2"><Tick>Renamed</Tick></span>}</button>} {/* MOCK-HOOK */}
            {v.kind !== 'built' && <span className="shrink-0 text-xs text-text2">{v.kind === 'mine' ? 'Only me' : 'Everyone'}</span>} {/* MOCK-HOOK */}
            <label className="flex shrink-0 items-center gap-1 text-xs text-text2"><input type="radio" name="sv-default" defaultChecked={i === 0} />Default</label> {/* MOCK-HOOK */}
            {v.kind === 'built' ? <button className={`${ghost} shrink-0`}>Hide</button> : <button className={`${ghost} shrink-0 text-crit`}>Remove</button>} {/* MOCK-HOOK */}
          </div> // MOCK-HOOK
        ))} {/* MOCK-HOOK */}
      </div> {/* MOCK-HOOK */}
    </div> // MOCK-HOOK
  ); // MOCK-HOOK

  let control: ReactNode = null; // MOCK-HOOK
  if (place === 'b') { // MOCK-HOOK
    control = ( // MOCK-HOOK
      <div className="relative flex flex-wrap items-center gap-2" data-testid="sv-views-menu"> {/* MOCK-HOOK */}
        <button className={`${btn} max-w-[22rem] ${open && open !== 'manage' ? 'bg-surface2' : ''}`} aria-haspopup="menu" aria-expanded={!!open}> {/* MOCK-HOOK */}
          <span className="font-normal text-text2">View</span><span className="truncate">{curName}</span>{sv2 && cur.kind === 'shared' && <span className="text-xs font-normal text-text2">{mode === 'd' ? 'Team' : 'Everyone'}</span>}<span aria-hidden>▾</span> {/* MOCK-HOOK */}
        </button> {/* MOCK-HOOK */}
        {editedBits} {doneTick} {/* MOCK-HOOK */}
        {mode === 'b' && !edited && phase !== 'done' && <button className={ghost}>Copy link</button>} {/* MOCK-HOOK */}
        {open && open !== 'manage' && popover('left-0 top-10 w-[24rem]')} {/* MOCK-HOOK */}
      </div> // MOCK-HOOK
    ); // MOCK-HOOK
  } else if (place === 'a') { // MOCK-HOOK
    const shown = phone ? all : all.slice(0, many ? 6 : all.length); // MOCK-HOOK
    const rest = all.length - shown.length; // MOCK-HOOK
    control = ( // MOCK-HOOK
      <div className="relative flex w-full items-end gap-1 border-b border-line" data-testid="sv-tabs"> {/* MOCK-HOOK */}
        <div className={`flex min-w-0 items-end gap-1 ${phone ? 'overflow-x-auto' : ''}`} role="tablist"> {/* MOCK-HOOK */}
          {shown.map((v) => removed === v.id ? null : ( // MOCK-HOOK
            <div key={v.id} role="tab" aria-selected={v.id === cur.id} className={`group relative flex h-9 shrink-0 items-center gap-1.5 border-b-2 px-3 text-sm ${v.id === cur.id ? 'border-accent font-semibold text-accent-ink' : 'border-transparent text-text2 hover:text-text'} ${p.get('drag') === v.id ? 'rounded-t-lg bg-accent-soft shadow-lg -translate-y-0.5' : ''}`}> {/* MOCK-HOOK */}
              {sv3 === 'c' && phase === 'mid' && v.id === cur.id ? <input defaultValue={typed} autoFocus className="h-7 w-56 rounded-md border border-accent bg-surface px-2 text-sm font-normal text-text" /> : <span className="max-w-[16rem] truncate" title={v.name}>{v.name}</span>} {/* MOCK-HOOK */}
              <span className="text-xs font-normal text-text2">{v.count}</span> {/* MOCK-HOOK */}
              {sv3 === 'c' && v.id === cur.id && v.kind !== 'built' && <button className="rounded px-1 text-text2" aria-label="More for this view">⋯</button>} {/* MOCK-HOOK */}
              {sv3 === 'c' && v.id === cur.id && open === 'more' && <div role="menu" className={`${card} absolute left-0 top-10 z-30 flex w-48 flex-col p-1 font-normal text-text`}>{['Rename', 'Make it the default', 'Copy link', 'Remove'].map((t) => <button key={t} className={`rounded-md px-3 py-1.5 text-left text-sm hover:bg-surface2 ${t === 'Rename' ? 'bg-surface2' : ''} ${t === 'Remove' ? 'text-crit' : ''}`}>{t}</button>)}</div>} {/* MOCK-HOOK */}
            </div> // MOCK-HOOK
          ))} {/* MOCK-HOOK */}
        </div> {/* MOCK-HOOK */}
        {rest > 0 && <div className="relative shrink-0"><button className={`${ghost} mb-0.5`} aria-expanded={open === 'overflow'}>+{rest} more ▾</button>{open === 'overflow' && <div role="menu" className={`${card} absolute right-0 top-10 z-30 w-[26rem] p-1`}>{all.slice(shown.length).map((v) => row(v, sv3 === 'c' ? <span className="text-text2" aria-label="Drag to reorder">⠿</span> : null))}</div>}</div>} {/* MOCK-HOOK */}
        <div className="relative mb-0.5 ml-auto flex shrink-0 items-center gap-2"> {/* MOCK-HOOK */}
          {edited ? <button className={solid}>+ Save view</button> : <button className={ghost}>+ Save view</button>} {doneTick} {/* MOCK-HOOK */}
          {saveOpen && popover('right-0 top-10 w-[22rem]')} {/* MOCK-HOOK */}
        </div> {/* MOCK-HOOK */}
      </div> // MOCK-HOOK
    ); // MOCK-HOOK
  } else if (place === 'c') { // MOCK-HOOK
    const side = ( // MOCK-HOOK
      <> {/* MOCK-HOOK */}
        <div className="flex items-center justify-between px-3 pt-3"><span className="text-base font-semibold text-text">Views</span><button className={ghost} aria-label="Hide views">⇥</button></div> {/* MOCK-HOOK */}
        <div className="px-3 pt-2"><button className={`${edited || saveOpen ? solid : btn} w-full`}>+ Save these filters</button></div> {/* MOCK-HOOK */}
        {saveOpen ? <SaveForm name={typed} sv2={mode} /> : null} {/* MOCK-HOOK */}
        <div className="flex-1 overflow-y-auto p-1">{groups()}</div> {/* MOCK-HOOK */}
        <div className="border-t border-line p-1"><button className="w-full rounded-md px-3 py-2 text-left text-sm text-text hover:bg-surface2">Manage views</button></div> {/* MOCK-HOOK */}
      </> // MOCK-HOOK
    ); // MOCK-HOOK
    control = phone ? ( // MOCK-HOOK
      <div className="flex items-center gap-2"><button className={btn}>Views · {curName}</button>{editedBits}{doneTick}{open && <div className="fixed inset-0 z-40 flex flex-col bg-surface">{side}</div>}</div> // MOCK-HOOK
    ) : ( // MOCK-HOOK
      <> {/* MOCK-HOOK */}
        <style>{`main{padding-right:17rem !important}`}</style> {/* MOCK-HOOK */}
        <aside className="fixed inset-y-0 right-0 z-20 flex w-64 flex-col border-l border-line-strong bg-surface" data-testid="sv-side">{side}</aside> {/* MOCK-HOOK */}
        <div className="flex items-center gap-2"><span className="text-sm text-text2">View</span><span className="text-sm font-semibold text-text">{curName}</span>{editedBits}{doneTick}</div> {/* MOCK-HOOK */}
      </> // MOCK-HOOK
    ); // MOCK-HOOK
  } else { // MOCK-HOOK
    // SV1 d: a View picker like the page's other pickers.
    control = ( // MOCK-HOOK
      <div className="relative flex flex-wrap items-center gap-2"> {/* MOCK-HOOK */}
        {saveOpen ? <span className="flex items-center gap-2 text-sm text-text2">Save as<input defaultValue={typed} autoFocus={!!typed} placeholder="Name this view" className="h-8 w-60 rounded-lg border border-accent bg-surface px-2 text-sm text-text" /><button className={solid}>Save</button><button className={ghost}>Cancel</button></span> : ( // MOCK-HOOK
          <label className="flex items-center gap-1.5 text-sm text-text2">View<span className={`flex h-8 max-w-[18rem] items-center gap-2 rounded-lg border px-2 text-sm text-text ${open ? 'border-accent' : 'border-line-strong'} bg-surface`}><span className="truncate">{curName}{edited ? ' (edited)' : ''}</span><span aria-hidden className="text-text2">⌄</span></span></label> // MOCK-HOOK
        )} {/* MOCK-HOOK */}
        {doneTick} {/* MOCK-HOOK */}
        {open === '1' && <div role="listbox" className="absolute left-10 top-9 z-30 w-[20rem] border border-line-strong bg-surface py-1 text-sm text-text shadow-lg">{all.map((v) => <div key={v.id} className={`truncate px-2 py-0.5 ${v.id === cur.id ? 'bg-accent text-on-accent' : ''}`}>{v.name}</div>)}<div className="border-t border-line px-2 py-0.5">Save these filters…</div></div>} {/* MOCK-HOOK */}
      </div> // MOCK-HOOK
    ); // MOCK-HOOK
  } // MOCK-HOOK

  const shareBanner = mode === 'b' && p.get('fromlink') === '1' && ( // MOCK-HOOK
    <div className="flex w-full flex-wrap items-center gap-2 rounded-lg border border-accent bg-accent-soft px-3 py-2 text-sm text-text" data-testid="sv-link-banner">Filters from Rosa Lind&rsquo;s link<span className="text-text2">· {cur.filters.join(' · ')}</span><button className={btn}>Save as my view</button><button className={ghost}>Clear</button></div> // MOCK-HOOK
  ); // MOCK-HOOK

  return ( // MOCK-HOOK
    <div className="flex w-full basis-full flex-col gap-2" data-testid="mock-saved-views" data-page={page}> {/* MOCK-HOOK */}
      {shareBanner} {/* MOCK-HOOK */}
      {place === 'a' ? <>{control}<div className="flex flex-wrap items-center gap-x-4 gap-y-2"><NewFilters on={filters} /></div></> : <div className="flex flex-wrap items-center gap-x-4 gap-y-2">{control}<NewFilters on={filters} /></div>} {/* MOCK-HOOK */}
      {manage} {/* MOCK-HOOK */}
      {toast && <div role="status" className="fixed bottom-6 left-1/2 z-50 flex -translate-x-1/2 items-center gap-3 rounded-xl bg-text px-4 py-2.5 text-sm text-bg shadow-lg">{toast}<button className="font-semibold underline">Undo</button></div>} {/* MOCK-HOOK */}
      {cost && <div className="fixed bottom-3 left-3 sm:left-[15.5rem] z-50 max-w-[22rem] rounded-lg border-2 border-dashed border-accent bg-surface px-3 py-2 text-xs text-text shadow" data-testid="sv-cost">{cost}</div>} {/* MOCK-HOOK */}
    </div> // MOCK-HOOK
  ); // MOCK-HOOK
} // MOCK-HOOK
