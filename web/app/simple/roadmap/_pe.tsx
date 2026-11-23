'use client';
// MOCK-HOOK: this whole file is the mk-panel-edit mock-up (throwaway branch, never merged).
// The feature panel's proposals, switched by the address: ?pe1=a|b|c|d (how a field is edited),
// ?pe2=a|b|c (reading order and marks), ?pe3=a|b|c (acting on flags), plus &viewer=1 (read-only),
// &hard=1 (a long title and 8 dependencies), &hover=<field> (the hover look, held for a frame).

import { useEffect, useRef, useState, type ReactNode } from 'react';

import { toast as dsToast } from '@/components/ds';
import { InfoTip } from '@/components/ds/InfoTip';
import { api, unwrap } from '@/lib/api/client';
import { PE_FLAGS, PE_HARD, PE_MILESTONES, PE_PEOPLE } from '@/lib/api/mock/mk-panel-edit';

import type { Act } from './_card';
import { propose, type Item } from './_lib';

const q = () => new URLSearchParams(typeof window === 'undefined' ? '' : window.location.search);
export const peOn = () => ['pe1', 'pe2', 'pe3'].some((k) => q().has(k));
const pick = <T extends string>(k: string, ok: readonly T[], d: T): T => {
  const v = q().get(k) as T | null;
  return v && ok.includes(v) ? v : d;
};

const MON = 'Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec'.split(' ');
const iso = (word: string, near: string) => {
  const m = word.trim().match(/^([A-Za-z]{3})\w*\s+(\d{1,2})$/);
  if (!m) return null;
  const mo = MON.findIndex((x) => x.toLowerCase() === m[1].toLowerCase());
  if (mo < 0) return null;
  const [y, nm] = near.split('-').map(Number);
  const year = mo + 1 < nm - 6 ? y + 1 : y;
  return `${year}-${String(mo + 1).padStart(2, '0')}-${m[2].padStart(2, '0')}`;
};
const day = (iso?: string | null) => {
  if (!iso) return '';
  const [, m, d] = iso.split('-').map(Number);
  return `${MON[m - 1]} ${d}`;
};

type K =
  | 'title'
  | 'start'
  | 'end'
  | 'status'
  | 'confidence'
  | 'milestone'
  | 'goal'
  | 'measure'
  | 'target'
  | 'owner'
  | 'decider'
  | 'tdate'
  | 'outcome'
  | 'notes'
  | 'horizon'
  | 'track';
type Vals = Record<K, string> & { deps: string[]; needed: string[] };
const LABEL: Record<K, string> = {
  title: 'Name',
  start: 'Starts',
  end: 'Ends',
  status: 'Status',
  confidence: 'Confidence',
  milestone: 'Milestone',
  goal: 'Goal',
  measure: 'Measure',
  target: 'Target',
  owner: 'Owner',
  decider: 'Decider',
  tdate: 'Date',
  outcome: 'Outcome',
  notes: 'Notes',
  horizon: 'Horizon',
  track: 'Track',
};
const OPTIONS: Partial<Record<K, string[]>> = {
  status: ['Draft', 'Planned', 'In progress', 'Done'],
  confidence: ['High', 'Medium', 'Low'],
  owner: PE_PEOPLE.map((p) => p.name),
  decider: PE_PEOPLE.map((p) => p.name),
  milestone: PE_MILESTONES,
  horizon: ['Now', 'Next', 'Later'],
  track: ['Usage alerts track', 'Billing track', 'Onboarding track'],
  goal: ['Grow retention', 'Win mid-size teams', 'Cut time to first value'],
};
const KEYS: Partial<Record<K, string>> = { start: 'S', end: 'E', owner: 'O', milestone: 'M', status: 'T' };

/** A text field grows to show all its words (a long name wraps instead of being cut). */
const grow = (el: HTMLTextAreaElement | null) => {
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = `${el.scrollHeight + 2}px`;
};

const Pencil = () => (
  <svg aria-hidden width="13" height="13" viewBox="0 0 16 16" className="flex-none">
    <path d="M11 2l3 3-8 8H3v-3z" fill="none" stroke="currentColor" strokeWidth="1.5" />
  </svg>
);
const Warn = () => (
  <svg aria-hidden width="14" height="14" viewBox="0 0 16 16" className="flex-none text-warn">
    <path d="M8 1.5l7 13H1z" fill="currentColor" />
    <path d="M8 6v4M8 11.6v.8" stroke="var(--surface)" strokeWidth="1.6" />
  </svg>
);
const Tick = () => (
  <svg aria-hidden width="13" height="13" viewBox="0 0 16 16" className="flex-none text-accent">
    <path d="M3 8.5l3 3 7-7" fill="none" stroke="currentColor" strokeWidth="2" />
  </svg>
);

export function PePanel({
  item,
  items,
  phone,
  canChange,
  onClose,
  className,
  style,
  act,
}: {
  act: Act;
  item: Item;
  items: Map<string, Item>;
  phone: boolean;
  canChange: boolean;
  onClose: () => void;
  className: string;
  style?: React.CSSProperties;
}) {
  const model = pick('pe1', ['a', 'b', 'c', 'd'] as const, 'a');
  const order = pick('pe2', ['a', 'b', 'c'] as const, 'a');
  const fix = pick('pe3', ['a', 'b', 'c'] as const, 'a');
  const hard = q().get('hard') === '1';
  const ro = q().get('viewer') === '1' || !canChange;
  const held = q().get('hover');
  const name = (id: string) => {
    const i = items.get(id);
    return i ? `${i.code ? `${i.code} ` : ''}${i.title}` : id;
  };
  const init: Vals = {
    title: hard ? PE_HARD.title : item.title,
    start: day(item.start.date),
    end: day(item.end.date),
    status: 'In progress',
    confidence: item.confidence ? item.confidence[0].toUpperCase() + item.confidence.slice(1) : 'High',
    milestone: item.milestone?.name ?? '',
    goal: item.goal?.title ?? 'Grow retention',
    measure: 'Teams active after 90 days',
    target: '70% of teams',
    tdate: 'Mar 31, 2027',
    outcome: '',
    notes: '',
    horizon: 'Now',
    track: 'Usage alerts track',
    owner: item.owner?.name ?? '',
    decider: 'Avery Stone',
    deps: hard ? [...item.depends_on.map(name), ...PE_HARD.deps].slice(0, 8) : item.depends_on.map(name),
    needed: item.needed_by.map(name),
  };
  const [vals, setVals] = useState<Vals>(init);
  const [draftVals, setDraftVals] = useState<Vals | null>(null); // pe1=c: the Edit mode's values
  const [changed, setChanged] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<string | null>(null);
  const [flags, setFlags] = useState(
    { owner: true, dates: true, link: !hard },
  );
  const [step, setStep] = useState(false); // pe3=c: the flags' one-at-a-time card is open
  const [adding, setAdding] = useState<'deps' | 'needed' | null>(null);
  const [cmd, setCmd] = useState('');
  const cmdRef = useRef<HTMLInputElement>(null);
  const v = draftVals ?? vals;
  const editing = model !== 'c' || !!draftVals;
  const live = !ro && editing;

  useEffect(() => {
    if (model !== 'd' || ro) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.tagName === 'INPUT') return;
      if (e.key === '/') {
        e.preventDefault();
        cmdRef.current?.focus();
      }
      const k = (Object.keys(KEYS) as K[]).find((x) => KEYS[x]!.toLowerCase() === e.key);
      if (k) {
        e.preventDefault();
        setOpen(k);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [model, ro]);

  const toast = (message: string, undo?: () => void) =>
    dsToast({ place: 'corner', message, action: undo ? { label: 'Undo', onClick: undo } : undefined });

  /** Saves one field at once (every model but the Edit mode, which saves on Done). */
  const commit = (k: K | 'deps' | 'needed', val: string | string[], said?: string, quiet = false) => {
    setOpen(null);
    const before = vals;
    if (JSON.stringify(v[k]) === JSON.stringify(val)) return;
    if (draftVals) return setDraftVals({ ...draftVals, [k]: val });
    setVals({ ...vals, [k]: val });
    setChanged((c) => new Set(c).add(k));
    if (k === 'owner' && flags.owner) setFlags({ ...flags, owner: false });
    if ((k === 'start' || k === 'end') && typeof val === 'string') {
      // The dates are saved for real, so the roadmap's bar moves at once (the change's own toast and Undo).
      const s0 = k === 'start' ? iso(val, item.start.date) : item.start.date;
      const e0 = k === 'end' ? iso(val, item.end.date) : item.end.date;
      if (s0 && e0) return moveDates(s0, e0);
    }
    if (quiet) return; // MOCK-HOOK: the real change's own toast says it
    toast(said ?? `Saved: ${k in LABEL ? LABEL[k as K] : 'links'} ${Array.isArray(val) ? '' : val}`.trim(), () => {
      setVals(before);
      setChanged(new Set([...changed].filter((x) => x !== k)));
    });
  };
  /** A feature typed under Needed by: added for real, depending on this one, dated after it (its own Roadmap row). */
  const addAfter = async (t: string) => {
    try {
      const r = await propose({
        op: 'add_item',
        target: { roadmap_id: item.roadmap.id, where: { kind: 'horizon', value: 'next' } },
        before: {},
        after: { title: t, ...(item.track ? { track_id: item.track.id } : {}) },
      });
      const id = r.change.target.item_id as string;
      await propose({ op: 'set_depends', target: { item_id: id }, before: { depends_on: [] }, after: { depends_on: [item.key] } });
      const s0 = new Date(`${item.end.date}T12:00:00Z`);
      s0.setUTCDate(s0.getUTCDate() + 1);
      const e0 = new Date(s0);
      e0.setUTCDate(e0.getUTCDate() + 27);
      const f = (d: Date) => d.toISOString().slice(0, 10);
      await act(
        { applied: `Added ${t}, placed after this feature`, proposed: `add ${t}` },
        { op: 'move_dates', target: { item_id: id }, before: { start_date: null, end_date: null }, after: { start_date: f(s0), end_date: f(e0) } },
      );
    } catch {
      /* the panel keeps it in Needed by */
    }
  };
  /** A milestone typed in the Milestone list: made on the Roadmap's Milestones strip, then picked. */
  const addMilestone = async (typed: string) => {
    const [nm, when] = typed.split('·').map((x) => x.trim());
    const date = when ? iso(when, item.end.date) : null;
    if (!date) return;
    try {
      const made = await unwrap(
        api.POST('/v1/simple/roadmap/milestones', {
          body: {
            roadmap_id: item.roadmap.id,
            name: nm,
            date,
            goal_id: item.goal?.id ?? null,
            item_ids: [item.id],
            counts_when: 'Holds 7 days in a row',
            kind: 'delivery',
            status_set: null,
            status_reason: null,
            done_when_line: '',
            measure: null,
            baseline: null,
            target: null,
            current: null,
            sub_goal_of_id: null,
            home_track_id: null,
            from_track_id: null,
            to_track_id: null,
          } as never,
        }),
      );
      const m = item.milestone;
      await act(
        { applied: `Added the milestone ${typed}`, proposed: `add the milestone ${typed}` },
        {
          op: 'set_milestone',
          target: { item_id: item.id },
          before: { milestone: m && m.source === 'item' ? { id: m.id ?? null, name: m.name ?? null, date: m.date ?? null } : null },
          after: { milestone: { id: (made as { id: string }).id } },
        },
      );
    } catch {
      /* the panel keeps it */
    }
  };
  const moveDates = (s0: string, e0: string) =>
    void act(
      { applied: `Dates set: ${day(s0)} – ${day(e0)}`, proposed: `move the dates to ${day(s0)} – ${day(e0)}` },
      {
        op: 'move_dates',
        target: { item_id: item.id },
        before: { start_date: item.start.date, end_date: item.end.date },
        after: { start_date: s0, end_date: e0 },
      },
    );
  const done = () => {
    if (!draftVals) return;
    const ks = (Object.keys(draftVals) as (keyof Vals)[]).filter(
      (k) => JSON.stringify(draftVals[k]) !== JSON.stringify(vals[k]),
    );
    const before = vals;
    setVals(draftVals);
    setDraftVals(null);
    setChanged((c) => new Set([...c, ...ks]));
    if (draftVals.owner && flags.owner) setFlags({ ...flags, owner: false });
    toast(`Saved ${ks.length} change${ks.length === 1 ? '' : 's'}`, () => setVals(before));
    const s0 = iso(draftVals.start, item.start.date);
    const e0 = iso(draftVals.end, item.end.date);
    if (s0 && e0 && (s0 !== item.start.date || e0 !== item.end.date)) moveDates(s0, e0);
    // MOCK-HOOK: a new milestone or a new feature typed in Edit mode is made for real on Done.
    if (draftVals.milestone !== vals.milestone && !PE_MILESTONES.includes(draftVals.milestone)) void addMilestone(draftVals.milestone);
    draftVals.needed.filter((n) => !vals.needed.includes(n)).forEach((n) => void addAfter(n));
  };

  // ---- flags (PE3) ----
  const suggested = PE_PEOPLE.slice(0, 2).map((p) => p.name);
  const fixOwner = (who: string) => {
    const before = { vals, flags };
    setVals({ ...vals, owner: who });
    setChanged((c) => new Set(c).add('owner'));
    setFlags({ ...flags, owner: false });
    toast(`${who} owns it now`, () => {
      setVals(before.vals);
      setFlags(before.flags);
    });
  };
  const fixDates = (use: boolean) => {
    const before = { vals, flags };
    if (use) {
      setVals({ ...vals, start: 'Oct 6', end: 'Nov 24' });
      setChanged((c) => new Set(c).add('start').add('end'));
      setFlags({ ...flags, dates: false });
      return moveDates(iso('Oct 6', item.start.date)!, iso('Nov 24', item.end.date)!);
    }
    setFlags({ ...flags, dates: false });
    toast(use ? 'Using Oracle’s dates: Oct 6 – Nov 24' : 'Kept your dates', () => {
      setVals(before.vals);
      setFlags(before.flags);
    });
  };
  const fixLink = (how: 'move' | 'remove') => {
    const before = { vals, flags };
    if (how === 'remove') setVals({ ...vals, needed: vals.needed.slice(1) });
    setChanged((c) => new Set(c).add('needed'));
    setFlags({ ...flags, link: false });
    toast(
      how === 'move' ? 'F-79 Weekly alert digest now starts Nov 11, after this ends' : 'Link removed',
      () => {
        setVals(before.vals);
        setFlags(before.flags);
      },
    );
  };
  const nFlags = Object.values(flags).filter(Boolean).length;
  const btn = (children: ReactNode, onClick: () => void, main?: boolean, id?: string, key?: string) => (
    <button
      key={key}
      type="button"
      data-testid={id}
      disabled={ro}
      onClick={onClick}
      className={`rounded-md px-2 py-0.5 text-sm font-[650] ${main ? 'bg-accent text-on-accent' : 'border border-line bg-surface text-accent-ink hover:bg-accent-soft'} disabled:opacity-60`}
    >
      {children}
    </button>
  );
  const flagBody = (f: 'owner' | 'dates' | 'link', compact = false) => (
    <div data-testid={`pe-flag-${f}`} className={`flex flex-wrap items-center gap-1.5 ${compact ? '' : 'mt-1'}`}>
      <span className="flex w-full min-w-0 items-start gap-1.5">
        <span className="pt-0.5"><Warn /></span>
        <span className="min-w-0 text-sm text-text">{PE_FLAGS[f]}</span>
      </span>
      {!ro && <span className="flex flex-wrap gap-1.5">
        {f === 'owner' &&
          suggested.map((p, i) => (
            btn(p, () => fixOwner(p), i === 0, `pe-fix-owner-${i}`, p)
          ))}
        {f === 'owner' && btn('Someone else', () => setOpen('owner'), false, 'pe-fix-owner-other')}
        {f === 'dates' && (
          <>
            {btn('Use these', () => fixDates(true), true, 'pe-fix-dates')}
            {btn('Keep mine', () => fixDates(false))}
          </>
        )}
        {f === 'link' && (
          <>
            {btn('Move it after', () => fixLink('move'), true, 'pe-fix-link')}
            {btn('Remove link', () => fixLink('remove'))}
          </>
        )}
      </span>}
    </div>
  );
  const onField = fix === 'a';

  // ---- one field ----
  const markRow = (k: string) => {
    if (!changed.has(k)) return '';
    if (order === 'a') return 'pe-changed-a shadow-[inset_3px_0_0_var(--accent)]';
    if (order === 'b') return 'bg-accent-soft';
    return 'border-accent';
  };
  const value = (k: K, wide = false) => {
    const val = v[k];
    const opts = OPTIONS[k];
    const isOpen = open === k;
    const hoverHeld = held === k && !changed.has(k) && !isOpen;
    const empty = !val;
    const shown = empty
      ? ({ owner: 'No owner yet', milestone: 'No milestone', outcome: 'Not written yet', notes: 'No notes yet' } as Partial<Record<K, string>>)[k] ?? '—'
      : val;
    const valueCls = `${empty ? 'text-text2' : ''} ${changed.has(k) && order === 'a' ? 'text-accent-ink font-[650]' : ''}`;
    if (ro || !editing)
      return (
        <span data-testid={`pe-value-${k}`} className={`${valueCls} ${k === 'title' ? '' : 'min-w-0 break-words'}`}>
          {shown}
        </span>
      );
    // A text field.
    if (!opts) {
      const inputCls = `-mx-1.5 w-[calc(100%+12px)] min-w-0 rounded-md border bg-transparent px-1.5 py-0.5 outline-none ${
        model === 'c'
          ? 'border-line-strong bg-surface'
          : isOpen
            ? 'border-accent bg-surface'
            : `border-transparent hover:border-line-strong hover:bg-surface2 data-[hover=true]:border-line-strong data-[hover=true]:bg-surface2 ${model === 'a' ? 'border-b-line border-dashed' : ''}`
      } ${k === 'title' ? 'text-lg font-[650] leading-6' : ''} ${valueCls}`;
      if (model === 'a' || model === 'c' || isOpen)
        return (
          <textarea
            data-testid={`pe-input-${k}`}
            data-hover={hoverHeld}
            aria-label={LABEL[k]}
            autoFocus={isOpen && model !== 'a'}
            defaultValue={val}
            key={`${k}-${val}`}
            rows={1}
            placeholder={empty && k !== 'title' ? shown : undefined}
            ref={grow}
            onInput={(e) => grow(e.currentTarget)}
            onFocus={() => setOpen(k)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !(k === 'notes' && e.shiftKey)) {
                e.preventDefault();
                (e.target as HTMLTextAreaElement).blur();
              }
              if (e.key === 'Escape') {
                (e.target as HTMLInputElement).value = val;
                setOpen(null);
                (e.target as HTMLInputElement).blur();
              }
            }}
            onBlur={(e) => commit(k, e.target.value)}
            className={`${inputCls} block resize-none break-words placeholder:text-text2 ${wide ? '' : ''}`}
          />
        );
    }
    // A pick field (or a text field at rest in b and d).
    return (
      <span className="relative block min-w-0">
        <button
          type="button"
          data-testid={`pe-input-${k}`}
          data-hover={hoverHeld}
          aria-label={`${LABEL[k]}: ${shown}`}
          onClick={() => setOpen(isOpen ? null : k)}
          className={`group/f -mx-1.5 flex w-[calc(100%+12px)] min-w-0 items-center gap-1.5 rounded-md border px-1.5 py-0.5 text-left ${
            model === 'c'
              ? 'mx-0 w-full border-line-strong bg-surface'
              : isOpen
                ? 'border-accent bg-surface'
                : `border-transparent hover:border-line-strong hover:bg-surface2 data-[hover=true]:border-line-strong data-[hover=true]:bg-surface2 ${model === 'a' ? 'border-b-line border-dashed' : ''}`
          } ${k === 'title' ? 'text-lg font-[650] leading-6' : ''}`}
        >
          <span className={`min-w-0 flex-1 break-words ${valueCls}`}>{shown}</span>
          {model === 'b' && (
            <span className="text-text2 opacity-0 group-hover/f:opacity-100 group-data-[hover=true]/f:opacity-100">
              <Pencil />
            </span>
          )}
          {model === 'd' && !phone && KEYS[k] && (
            <kbd className="rounded border border-line px-1 font-mono text-xs text-text2">{KEYS[k]}</kbd>
          )}
          {model === 'a' && opts && (
            <svg aria-hidden width="10" height="10" viewBox="0 0 10 10" className="flex-none text-text2">
              <path d="M2 3.5l3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.5" />
            </svg>
          )}
        </button>
        {isOpen && opts && (
          <span
            role="listbox"
            data-testid={`pe-list-${k}`}
            className="absolute left-0 top-full z-10 mt-1 flex w-[240px] flex-col rounded-lg border border-line bg-surface p-1 shadow-tip"
          >
            {opts.map((o) => (
              <button
                key={o}
                type="button"
                role="option"
                aria-selected={o === val}
                data-testid={`pe-opt-${o}`}
                onClick={() => commit(k, o)}
                className={`flex items-center justify-between rounded-md px-2 py-1 text-left text-base hover:bg-accent-soft ${o === val ? 'font-[650]' : ''}`}
              >
                <span>{o}</span>
                {k === 'owner' && <span className="text-sm text-text2">{PE_PEOPLE.find((p) => p.name === o)?.role}</span>}
              </button>
            ))}
            {k === 'milestone' && (
              <input
                data-testid="pe-new-milestone"
                placeholder="+ New milestone: name and date"
                className="mt-1 rounded-md border border-line px-2 py-1 text-base outline-none focus:border-accent"
                onKeyDown={(e) => {
                  if (e.key !== 'Enter') return;
                  const typed = (e.target as HTMLInputElement).value;
                  commit('milestone', typed, `Added the milestone ${typed}`, !draftVals);
                  if (!draftVals) void addMilestone(typed);
                }}
              />
            )}
          </span>
        )}
      </span>
    );
  };
  const row = (k: K, children?: ReactNode) => (
    <div
      data-testid={`pe-field-${k}`}
      className={`grid grid-cols-[92px_minmax(0,1fr)] items-start gap-x-3 rounded-md py-1 pl-2 -ml-2 ${markRow(k)}`}
    >
      <span className="pt-0.5 text-text2">{LABEL[k]}</span>
      <div className="min-w-0">
        {value(k)}
        {children}
      </div>
    </div>
  );
  const tile = (k: K, children?: ReactNode) => (
    <div
      data-testid={`pe-field-${k}`}
      className={`min-w-0 rounded-lg border px-2.5 py-1.5 ${changed.has(k) ? 'border-accent' : 'border-line'}`}
    >
      <span className="flex items-center gap-1 text-sm text-text2">
        {LABEL[k]}
        {changed.has(k) && <Tick />}
      </span>
      {value(k)}
      {children}
    </div>
  );
  const links = (which: 'deps' | 'needed') => {
    const list = v[which];
    return (
      <div data-testid={`pe-field-${which}`} className={`rounded-md pl-2 -ml-2 ${markRow(which)}`}>
        <ul className="flex flex-col gap-0.5">
          {list.length === 0 && <li className="text-text2">Nothing</li>}
          {list.map((n, i) => (
            <li key={n} className="flex min-w-0 items-start gap-1.5">
              <span className="min-w-0 flex-1 break-words text-accent-ink">
                {n}
                {!/^[A-Z]+-\d+ /.test(n) && <span className="text-sm text-warn"> · Not in the Ground Truth</span>}
              </span>
              {live && (
                <button
                  type="button"
                  aria-label={`Remove ${n}`}
                  className="px-1 text-text2 hover:text-crit"
                  onClick={() => commit(which, list.filter((x) => x !== n), `Removed the link to ${n}`)}
                >
                  ×
                </button>
              )}
              {which === 'needed' && i === 0 && flags.link && onField && null}
            </li>
          ))}
        </ul>
        {which === 'needed' && flags.link && onField && list.length > 0 && flagBody('link')}
        {live &&
          (adding === which ? (
            <input
              autoFocus
              data-testid={`pe-add-${which}`}
              placeholder="Find a feature, or type a new one"
              className="mt-1 w-full rounded-md border border-accent bg-surface px-1.5 py-0.5 outline-none"
              onKeyDown={(e) => {
                const t = (e.target as HTMLInputElement).value.trim();
                if (e.key === 'Enter' && t) {
                  setAdding(null);
                  const real = which === 'needed' && !draftVals;
                  commit(which, [...list, t], `Added ${t}, placed ${which === 'deps' ? 'before' : 'after'} this feature`, real);
                  if (real) void addAfter(t);
                }
                if (e.key === 'Escape') setAdding(null);
              }}
              onBlur={() => setAdding(null)}
            />
          ) : (
            <button
              type="button"
              data-testid={`pe-plus-${which}`}
              onClick={() => setAdding(which)}
              className="mt-0.5 text-sm font-[650] text-accent-ink"
            >
              + Add
            </button>
          ))}
      </div>
    );
  };

  // ---- the head ----
  const flagChip = nFlags > 0 && !ro && (
    <button
      type="button"
      data-testid="pe-flags-badge"
      onClick={() => (fix === 'c' ? setStep(!step) : undefined)}
      className="flex flex-none items-center gap-1 rounded-full bg-warn-bg px-2 py-0.5 text-sm font-[650] text-text"
    >
      <Warn /> {nFlags} to fix
    </button>
  );
  const head = (
    <div>
    <div className="flex items-start gap-2">
      <div className="min-w-0 flex-1">
        {order === 'b' || model === 'c' || ro ? (
          <h2 className="break-words text-lg font-[650] leading-6">
            {ro || !editing ? v.title : value('title')}
          </h2>
        ) : (
          <h2 className="-ml-1.5 break-words">
            {value('title')}
          </h2>
        )}
      </div>
      {flagChip}
      {model === 'c' && !ro && (
        <button
          type="button"
          data-testid={draftVals ? 'pe-done' : 'pe-edit'}
          onClick={() => (draftVals ? done() : setDraftVals(vals))}
          className={`flex-none rounded-md px-2.5 py-1 text-base font-[650] ${draftVals ? 'bg-accent text-on-accent' : 'border border-line text-accent-ink'}`}
        >
          {draftVals ? 'Done' : 'Edit'}
        </button>
      )}
      {ro && (
        <InfoTip label="Read only">You can read this feature. Avery Stone, its decider, can change it.</InfoTip>
      )}
      <button type="button" aria-label="Close" onClick={onClose} className="flex-none px-1 text-lg text-text2">
        ×
      </button>
    </div>
        <span data-testid="pe-code" className="mt-0.5 flex flex-wrap items-center gap-x-1 text-sm text-text2">
          Code {item.code ?? 'None'}
          {!item.code && (
            <>
              {' · '}
              <span className="text-warn">Not in the Ground Truth</span>
              <InfoTip label="Not in the Ground Truth">Roadmap items that are no feature of the Ground Truth, or one only proposed so far.</InfoTip>
            </>
          )}
        </span>
    </div>
  );
  const cmdBar = model === 'd' && !ro && !phone && (
    <div className="mt-2 flex items-center gap-2 rounded-lg border border-line bg-surface2 px-2 py-1">
      <kbd className="rounded border border-line px-1 font-mono text-xs text-text2">/</kbd>
      <input
        ref={cmdRef}
        data-testid="pe-cmd"
        value={cmd}
        onChange={(e) => setCmd(e.target.value)}
        placeholder="Type a change: owner Mira, ends Dec 4"
        className="min-w-0 flex-1 bg-transparent text-base outline-none"
        onKeyDown={(e) => {
          if (e.key !== 'Enter') return;
          const m = cmd.match(/^(owner|ends|starts|milestone|status)\s+(.+)$/i);
          if (!m) return;
          const k = ({ owner: 'owner', ends: 'end', starts: 'start', milestone: 'milestone', status: 'status' } as const)[
            m[1].toLowerCase() as 'owner'
          ] as K;
          const val =
            k === 'owner' ? (PE_PEOPLE.find((p) => p.name.toLowerCase().startsWith(m[2].toLowerCase()))?.name ?? m[2]) : m[2];
          setCmd('');
          commit(k, val);
        }}
      />
      <InfoTip label="Keys">Press a field’s letter to open it, / to type a change, Enter to save, Esc to undo the typing.</InfoTip>
    </div>
  );
  const strip =
    (fix === 'b' || (fix === 'c' && (step || ro))) && nFlags > 0 ? (
      <div data-testid="pe-strip" className="mt-2 flex flex-col gap-2 rounded-lg border border-warn bg-warn-bg px-3 py-2">
        {(fix === 'b' || ro
          ? (['owner', 'dates', 'link'] as const).filter((f) => flags[f])
          : (['owner', 'dates', 'link'] as const).filter((f) => flags[f]).slice(0, 1)
        ).map((f) => (
          <div key={f}>{flagBody(f, true)}</div>
        ))}
      </div>
    ) : null;

  // ---- the body, by reading order ----
  const h = (children: ReactNode) => (
    <h3 className="mt-3 mb-0.5 text-xs font-[650] uppercase tracking-wide text-text2">{children}</h3>
  );
  const ownerFlag = onField && flags.owner && !v.owner ? flagBody('owner') : null;
  const datesFlag = onField && flags.dates ? flagBody('dates') : null;
  // The built panel's other fields, folded (every proposal keeps them; Notes grows as it is typed).
  const line = (label: string, text: string) => (
    <div className="grid grid-cols-[92px_minmax(0,1fr)] items-start gap-x-3 py-1">
      <span className="text-text2">{label}</span>
      <span className="min-w-0 break-words">{text}</span>
    </div>
  );
  const more = (
    <details data-testid="pe-more" className="mt-2">
      <summary className="cursor-pointer py-1 text-xs font-[650] uppercase tracking-wide text-text2">
        More: outcome, notes, horizon, track, why
      </summary>
      {row('outcome')}
      {row('notes')}
      {row('horizon')}
      {row('track')}
      {line('PRD', 'Usage alerts')}
      {line('Reading', 'Today 61% · target 70% of teams by Mar 31, 2027')}
      {line('Near', 'Customer conference (Nov 14): ends 4 days before')}
      {line('Why', 'Admins asked for it most this quarter. Serves the goal Grow retention.')}
      {line('Open decisions', 'None')}
      {line('Tasks', 'None')}
    </details>
  );
  let body: ReactNode;
  if (order === 'a')
    body = (
      <>
        {h('Plan')}
        {row('start')}
        {row('end', datesFlag)}
        {row('status')}
        {row('confidence')}
        {row('milestone')}
        {h('People')}
        {row('owner', ownerFlag)}
        {row('decider')}
        {h('Goal')}
        {row('goal')}
        {row('measure')}
        {row('target')}
        {row('tdate')}
        {h('Links')}
        <div className="grid grid-cols-[92px_minmax(0,1fr)] gap-x-3 py-1">
          <span className="text-text2">Depends on</span>
          {links('deps')}
        </div>
        <div className="grid grid-cols-[92px_minmax(0,1fr)] gap-x-3 py-1">
          <span className="text-text2">Needed by</span>
          {links('needed')}
        </div>
        {more}
      </>
    );
  else if (order === 'b')
    body = (
      <>
        <div className="mt-2 rounded-lg border border-line p-2.5">
          <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-x-3 text-lg font-[650]">
            <span data-testid="pe-field-start" className={`min-w-0 rounded-md px-1.5 ${markRow('start')}`}>{value('start')}</span>
            <span className="text-text2">–</span>
            <span data-testid="pe-field-end" className={`min-w-0 rounded-md px-1.5 ${markRow('end')}`}>{value('end')}</span>
          </div>
          {datesFlag}
          <div className="mt-1 grid grid-cols-2 gap-x-3 px-1.5">
            <span data-testid="pe-field-owner" className={`rounded-md ${markRow('owner')}`}>{value('owner')}</span>
            <span data-testid="pe-field-status" className={`rounded-md ${markRow('status')}`}>{value('status')}</span>
          </div>
          {ownerFlag}
        </div>
        <details open className="mt-2">
          <summary className="cursor-pointer py-1 text-xs font-[650] uppercase tracking-wide text-text2">Goal and milestone</summary>
          {row('goal')}
          {row('target')}
          {row('tdate')}
          {row('milestone')}
        </details>
        <details className="mt-1">
          <summary className="cursor-pointer py-1 text-xs font-[650] uppercase tracking-wide text-text2">More: confidence, decider, measure</summary>
          {row('confidence')}
          {row('decider')}
          {row('measure')}
        </details>
        <details open className="mt-1">
          <summary className="cursor-pointer py-1 text-xs font-[650] uppercase tracking-wide text-text2">
            Links ({v.deps.length + v.needed.length})
          </summary>
          <span className="text-sm text-text2">Depends on</span>
          {links('deps')}
          <span className="mt-1 block text-sm text-text2">Needed by</span>
          {links('needed')}
        </details>
        {more}
      </>
    );
  else
    body = (
      <div className="mt-2 grid grid-cols-2 gap-2">
        {tile('start')}
        {tile('end')}
        {datesFlag && <div className="col-span-2">{datesFlag}</div>}
        {tile('owner')}
        {tile('status')}
        {ownerFlag && <div className="col-span-2">{ownerFlag}</div>}
        {tile('milestone')}
        {tile('confidence')}
        <div className="col-span-2">{tile('goal')}</div>
        {tile('target')}
        {tile('tdate')}
        <div className="col-span-2">{tile('decider')}</div>
        <div className="col-span-2 rounded-lg border border-line px-2.5 py-1.5">
          <span className="text-sm text-text2">Depends on</span>
          {links('deps')}
        </div>
        <div className="col-span-2 rounded-lg border border-line px-2.5 py-1.5">
          <span className="text-sm text-text2">Needed by</span>
          {links('needed')}
        </div>
        <div className="col-span-2">{more}</div>
      </div>
    );

  return (
    <div
      role="dialog"
      aria-label={v.title}
      data-testid="floating-card"
      data-pe={`${model}${order}${fix}`}
      style={style}
      className={`${className} ${phone ? 'max-w-none overflow-hidden' : 'max-h-[calc(100dvh-24px)] max-w-[calc(100vw-16px)]'} border-line bg-surface text-base leading-[22px] text-text shadow-tip outline-none`}
    >
      {phone && <span aria-hidden className="mx-auto mt-2 mb-1 block h-1 w-10 flex-none rounded-sm bg-line-strong opacity-60" />}
      <div className={`flex-none px-4 ${phone ? 'pt-1.5' : 'pt-4'}`}>
        {head}
        {cmdBar}
        {strip}
      </div>
      <div data-fit-body="" className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-4">
        {body}
      </div>
    </div>
  );
}
