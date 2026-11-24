// MOCK-HOOK (whole file): mk-bulk-edit mock-ups, decisions BE1 (how several features are picked),
// BE2 (the bulk bar or sheet) and BE3 (mixed rights). Local-only URL switches:
//   ?be1=a|b|c  ?be2=a|b|c  ?be3=a|b|c  (any one turns the mock-up on; the others default to a)
//   &pick=2,4,6,7 (ranks picked)  &open=owner|status|dates|track|sheet  &set=status:Done,owner:Rosa Lind,shift:2
//   &role=commenter  &long=1  &mode=1 (BE1 b: select mode on)
// Never merged: the owner picks one proposal per decision from the frames.
'use client';

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

import { useSearchParams } from '@/lib/nav';
import { InfoTip, toast } from '@/components/ds';
import { FeatureMarks } from '@/components/current-state/CurrentState';
import {
  BULK_APPROVER,
  BULK_LONG,
  BULK_OWNER,
  BULK_PEOPLE,
  BULK_RIGHTS,
  BULK_STATUSES,
  BULK_TRACKS,
  BULK_WHY,
} from '@/lib/api/mock/bulk-mock';

type R = { feature_id: string; title: string; rank: number; own_key?: string | null; end_date?: string | null };
type Field = 'owner' | 'status' | 'dates' | 'track';
type Draft = { owner?: string; status?: string; shift?: number; end?: string; track?: string };
type Right = 'edit' | 'propose' | 'none';
type Result = { changed: string[]; proposed: string[]; skipped: string[]; words: string };

type Bulk = {
  be1: string;
  be2: string;
  be3: string;
  mixed: boolean;
  rows: R[];
  picked: Set<string>;
  pick: (r: R, i: number, shift: boolean) => void;
  setPicked: (s: Set<string>) => void;
  hover: number | null;
  setHover: (i: number | null) => void;
  anchor: number | null;
  mode: boolean;
  setMode: (m: boolean) => void;
  open: Field | 'sheet' | null;
  setOpen: (f: Field | 'sheet' | null) => void;
  draft: Draft;
  setDraft: (d: Draft) => void;
  applied: Record<string, Draft & { proposed?: boolean }>;
  apply: () => void;
  result: Result | null;
  setResult: (r: Result | null) => void;
  right: (r: R) => Right;
  long: boolean;
  shown: string | null;
  setShown: (s: string | null) => void;
  open2: Field | null;
  setOpen2: (f: Field | null) => void;
  commenter: boolean;
};

const Ctx = createContext<Bulk | null>(null);

export function useBulk(): Bulk | null {
  return useContext(Ctx);
}

const MS_DAY = 86_400_000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function day(iso: string | null | undefined, shiftWeeks = 0): string {
  if (!iso) return 'No date';
  const d = new Date(new Date(iso + 'T12:00:00Z').getTime() + shiftWeeks * 7 * MS_DAY);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}
const MARK_WORD: Record<string, string> = { new: 'New', in_progress: 'In progress', exists: 'Exists', exists_old: 'Exists' };
let marksNow: Map<string, { mark: string }> | null = null;
const statusOf = (r: R) => MARK_WORD[marksNow?.get(r.feature_id)?.mark ?? ''] ?? 'New';
const ownerOf = (r: R) => BULK_OWNER[r.title] ?? '';

export const BulkCtx = Ctx;

// A status set in bulk shows in the product's own pill and in the Show counts.
const WORD_MARK: Record<string, string> = { New: 'new', 'In progress': 'in_progress', Exists: 'exists' };
let over: Record<string, string> = {};
const subs = new Set<() => void>();
function setOver(o: Record<string, string>) {
  over = o;
  subs.forEach((f) => f());
}
export function useBulkMarks<T extends { mark: string }>(m: Map<string, T> | null): Map<string, T> | null {
  const [, force] = useState(0);
  useEffect(() => {
    const f = () => force((x) => x + 1);
    subs.add(f);
    return () => {
      subs.delete(f);
    };
  }, []);
  if (!m || !Object.keys(over).length) return m;
  const n = new Map(m);
  for (const [id, w] of Object.entries(over)) {
    const f = n.get(id);
    if (f) n.set(id, { ...f, mark: w });
  }
  return n;
}

export function useBulkState(rows: R[]): Bulk | null {
  const p = useSearchParams();
  const on = p.get('be1') || p.get('be2') || p.get('be3');
  const seed = useMemo(() => {
    const ranks = (p.get('pick') ?? '').split(',').filter(Boolean).map(Number);
    return new Set(rows.filter((r) => ranks.includes(r.rank)).map((r) => r.feature_id));
  }, [p, rows]);
  const seedDraft = useMemo(() => {
    const d: Draft = {};
    for (const kv of (p.get('set') ?? '').split(',').filter(Boolean)) {
      const [k, v] = kv.split(':');
      if (k === 'shift') d.shift = Number(v);
      else (d as Record<string, string>)[k] = v;
    }
    return d;
  }, [p]);
  const [picked, setPicked] = useState<Set<string>>(seed);
  const [hover, setHover] = useState<number | null>(null);
  const [anchor, setAnchor] = useState<number | null>(null);
  const [mode, setMode] = useState(p.get('mode') === '1');
  const [open, setOpen] = useState<Field | 'sheet' | null>((p.get('open') as Field) ?? null);
  const [draft, setDraft] = useState<Draft>(seedDraft);
  const [applied, setApplied] = useState<Record<string, Draft & { proposed?: boolean }>>({});
  const [result, setResult] = useState<Result | null>(null);
  const [shown, setShown] = useState<string | null>(null);
  const [open2, setOpen2] = useState<Field | null>(null);
  marksNow = useContext(FeatureMarks) as Map<string, { mark: string }> | null;
  if (!on) return null;
  const be3 = p.get('be3') ?? 'a';
  const mixed = !!p.get('be3');
  const commenter = p.get('role') === 'commenter';
  const right = (r: R): Right =>
    commenter ? 'propose' : mixed ? (BULK_RIGHTS[r.title] ?? 'edit') : 'edit';
  const pick = (r: R, i: number, shift: boolean) => {
    const next = new Set(picked);
    if (shift && anchor !== null) {
      const [a, b] = anchor < i ? [anchor, i] : [i, anchor];
      rows.slice(a, b + 1).forEach((x) => next.add(x.feature_id));
    } else if (next.has(r.feature_id)) next.delete(r.feature_id);
    else next.add(r.feature_id);
    setAnchor(i);
    setPicked(next);
  };
  const apply = () => {
    const got = rows.filter((r) => picked.has(r.feature_id));
    const changed = got.filter((r) => right(r) === 'edit').map((r) => r.feature_id);
    const proposed = got.filter((r) => right(r) === 'propose').map((r) => r.feature_id);
    const skipped = got.filter((r) => right(r) === 'none').map((r) => r.feature_id);
    const next = { ...applied };
    changed.forEach((id) => (next[id] = { ...draft }));
    proposed.forEach((id) => (next[id] = { ...draft, proposed: true }));
    setApplied(next);
    const before = over;
    if (draft.status) {
      const o = { ...over };
      changed.forEach((id) => (o[id] = WORD_MARK[draft.status!]));
      setOver(o);
    }
    const moved = draft.status && !draft.owner && !draft.shift && !draft.end && !draft.track
      ? got.filter((r) => right(r) === 'edit' && statusOf(r) !== draft.status).length
      : changed.length;
    const words = draftWords(draft);
    const res = { changed, proposed, skipped, words };
    setOpen(null);
    setPicked(new Set());
    setMode(false);
    const undo = { label: 'Undo', onClick: () => { setApplied(applied); setOver(before); } };
    if (!mixed && !commenter) {
      toast({ message: `${moved} features: ${words}`, action: undo, place: 'corner' });
    } else if (be3 === 'b') {
      toast({
        message: proposed.length
          ? changed.length
            ? `${changed.length} changed, ${proposed.length} sent to ${BULK_APPROVER} to approve`
            : `${proposed.length} changes sent to ${BULK_APPROVER} to approve`
          : `${changed.length} features: ${words}`,
        action: undo,
        place: 'corner',
      });
    } else setResult(res);
  };
  const v: Bulk = {
    be1: p.get('be1') ?? 'a',
    be2: p.get('be2') ?? 'a',
    be3,
    mixed: mixed || commenter,
    rows,
    picked,
    pick,
    setPicked,
    hover,
    setHover,
    anchor,
    mode,
    setMode,
    open,
    setOpen,
    draft,
    setDraft,
    applied,
    apply,
    result,
    setResult,
    right,
    long: p.get('long') === '1',
    shown,
    setShown,
    open2,
    setOpen2,
    commenter,
  };
  return v;
}

function draftWords(d: Draft): string {
  const w: string[] = [];
  if (d.status) w.push(`status ${d.status}`);
  if (d.owner) w.push(`owner ${d.owner}`);
  if (d.shift) w.push(`end dates ${d.shift > 0 ? '+' : ''}${d.shift} weeks`);
  if (d.end) w.push(`end date ${d.end}`);
  if (d.track) w.push(`moved to ${d.track}`);
  const t = w.join(', ') || 'no change';
  return t[0].toUpperCase() + t.slice(1);
}

/** The row's name (the hard case's long names). */
export function bulkTitle(b: Bulk | null, r: R): string {
  return (b?.long && BULK_LONG[r.title]) || r.title;
}

/** Extra classes and handlers on a row. */
export function bulkRow(b: Bulk | null, r: R, i: number) {
  if (!b) return { cls: '', props: {} };
  const on = b.picked.has(r.feature_id);
  const inRange =
    b.be1 === 'a' &&
    b.hover !== null &&
    b.anchor !== null &&
    b.picked.size > 0 &&
    i > Math.min(b.anchor, b.hover) &&
    i < Math.max(b.anchor, b.hover) &&
    !on;
  const clickPicks = (b.be1 === 'b' && b.mode) || b.be1 === 'c';
  return {
    cls: `group/bulk ${on ? '!border-accent ring-2 ring-accent !bg-accent-soft' : ''} ${inRange ? '!bg-accent-soft' : ''} ${b.shown && b.result && (b.result as Record<string, unknown>)[b.shown] && ((b.result as unknown as Record<string, string[]>)[b.shown] ?? []).includes(r.feature_id) ? '!border-accent ring-2 ring-accent' : ''}`,
    props: {
      'data-picked': on ? 'true' : undefined,
      onMouseEnter: () => b.setHover(i),
      onMouseLeave: () => b.setHover(null),
      onMouseDown: (e: React.MouseEvent) => {
        if (e.shiftKey || e.ctrlKey || e.metaKey) e.preventDefault();
      },
      onClickCapture: (e: React.MouseEvent) => {
        if (!clickPicks) return;
        if (b.be1 === 'c' && !(e.ctrlKey || e.metaKey || e.shiftKey)) return;
        if ((e.target as HTMLElement).closest('[data-bulk-keep]')) return;
        e.preventDefault();
        e.stopPropagation();
        b.pick(r, i, e.shiftKey);
      },
    },
  };
}

/** The checkbox before the drag handle (BE1 a: on hover, BE1 b: in select mode). */
export function BulkBox({ r, i }: { r: R; i: number }) {
  const b = useBulk();
  if (!b) return null;
  const on = b.picked.has(r.feature_id);
  const rt = b.right(r);
  if (b.be1 === 'c') return null;
  if (b.be1 === 'b' && !b.mode) return null;
  const lockB = b.be3 === 'b' && rt === 'none' && b.mixed;
  const show = b.be1 === 'b' || on || b.picked.size > 0 || b.hover === i;
  return (
    <span className={`flex w-6 items-center justify-center ${show ? '' : 'opacity-0 max-sm:opacity-100'}`}>
      {lockB ? (
        <span data-bulk-keep title={BULK_WHY[r.title]} aria-label={`Cannot change ${r.title}`}>
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden className="text-text2">
            <rect x="3" y="7" width="10" height="7" rx="1.5" fill="currentColor" />
            <path d="M5 7V5a3 3 0 0 1 6 0v2" stroke="currentColor" strokeWidth="1.6" fill="none" />
          </svg>
        </span>
      ) : (
        <input
          type="checkbox"
          data-bulk-keep
          data-testid="bulk-box"
          aria-label={`Pick ${r.title}`}
          className="h-5 w-5 cursor-pointer accent-[var(--color-accent)]"
          checked={on}
          onChange={() => undefined}
          onClick={(e) => b.pick(r, i, e.shiftKey)}
        />
      )}
    </span>
  );
}

const chip = 'rounded-md px-2 py-0.5 text-[length:var(--simple-small)] font-medium';

/** What a row will get (preview) or got (result), beside its name. */
export function BulkChips({ r }: { r: R }) {
  const b = useBulk();
  if (!b) return null;
  const got = b.applied[r.feature_id];
  const kept = !!b.result?.skipped.includes(r.feature_id); // a feature the change could not touch keeps its owner and its tag
  const rt = b.right(r);
  const on = b.picked.has(r.feature_id);
  const preview = on && b.be2 === 'c' && Object.values(b.draft).some(Boolean) ? b.draft : null;
  const d = got ?? preview;
  const out: ReactNode[] = [];
  if (b.long || on || got || kept) {
    const owner = ownerOf(r);
    out.push(
      <span key="o" className="whitespace-nowrap text-[length:var(--simple-small)] text-text2">
        {d?.owner && !got?.proposed ? (
          <>
            {owner && !got && <s className="mr-1">{owner}</s>}
            <b className="text-text">{d.owner}</b>
          </>
        ) : (
          owner || 'No owner'
        )}
      </span>,
    );
  }
  if (d?.status && !got)
    out.push(
      <span key="s" className={`${chip} whitespace-nowrap bg-[var(--simple-edited)] uppercase text-text`}>
        <s className="mr-1 text-text2">{statusOf(r)}</s>
        {d.status}
      </span>,
    );
  if (got && !got.proposed)
    out.push(
      <span key="t" aria-label="Just changed" title="Just changed" className="font-semibold text-accent">
        ✓
      </span>,
    );
  if ((d?.shift || d?.end) && !got?.proposed)
    out.push(
      <span key="d" className={`${chip} whitespace-nowrap bg-[var(--simple-edited)] text-text`}>
        End {!got && <s className="mr-1 text-text2">{day(r.end_date)}</s>}
        {d.end ?? day(r.end_date, d.shift)}
      </span>,
    );
  if (got?.proposed)
    out.push(
      <span key="p" className={`${chip} border border-dashed border-accent text-accent sm:whitespace-nowrap`}>
        {got.status ?? got.owner ?? `${got.shift} weeks`}, waiting for {BULK_APPROVER}
      </span>,
    );
  if ((on || kept) && b.mixed && rt !== 'edit' && !got && b.be3 !== 'c')
    out.push(
      <span key="r" className={`${chip} border border-line text-text2`}>
        {rt === 'propose' ? 'Proposal' : 'Cannot change'}
      </span>,
    );
  return out.length ? <span className="flex flex-wrap items-center gap-2">{out}</span> : null;
}

/** Hides today's status pill once a new status is applied (the chip says it). */
export function bulkHidesMark(_b: Bulk | null, _r: R): boolean {
  return false;
}

/** BE3 a and c: what happened, over the list (it stays in view while the list scrolls). */
function BulkResult({ b, res }: { b: Bulk; res: Result }) {
  return (
        <div
          data-testid="bulk-result"
          className="sticky top-2 z-30 mb-3 flex flex-wrap items-center gap-2 rounded-[var(--simple-card-radius)] border border-line bg-surface px-4 py-3 shadow-lg max-[600px]:top-[52px]"
        >
          <span className="font-semibold">{res.words}:</span>
          {(
            [
              ['changed', `${res.changed.length} changed`],
              ['proposed', `${res.proposed.length} sent to ${BULK_APPROVER}`],
              ['skipped', `${res.skipped.length} not changed`],
            ] as const
          ).map(([k, w]) =>
            res[k].length ? (
              <button
                key={k}
                type="button"
                className={`${btn} ${b.shown === k ? '!border-accent !bg-accent-soft' : ''}`}
                onClick={() => b.setShown(b.shown === k ? null : k)}
              >
                {w}
              </button>
            ) : null,
          )}
          <span className="ml-auto flex gap-2">
            <button type="button" className={btn} onClick={() => b.setResult(null)}>
              Undo
            </button>
            <button type="button" aria-label="Close" className={btn} onClick={() => b.setResult(null)}>
              ✕
            </button>
          </span>
          {b.be3 === 'c' && res.skipped.length > 0 && (
            <ul className="basis-full divide-y divide-line border-t border-line pt-1">
              {b.rows
                .filter((r) => res.skipped.includes(r.feature_id))
                .map((r) => (
                  <li key={r.feature_id} className="flex flex-wrap items-center gap-2 py-1.5">
                    <span className="font-medium">{bulkTitle(b, r)}</span>
                    {r.own_key && <span className="text-text2">{r.own_key}</span>}
                    <span className="text-text2">{BULK_WHY[r.title] ?? 'Read only'}</span>
                    <button type="button" className={`${btn} ml-auto`}>
                      Ask {(BULK_WHY[r.title] ?? '').match(/by ([A-Z][a-z]+ [A-Z][a-z]+)/)?.[1] ?? 'the owner'}
                    </button>
                  </li>
                ))}
            </ul>
          )}
        </div>
  );
}

/** Over the list: BE1 b's "Pick several" switch, BE1 c's tip, BE1 a's "pick all shown". */
export function BulkTop() {
  const b = useBulk();
  if (!b) return null;
  const all = b.picked.size === b.rows.length;
  if (b.result) return <BulkResult b={b} res={b.result} />;
  return (
    <div className="flex min-h-10 flex-wrap items-center gap-3 text-[length:var(--simple-small)]">
      {b.be1 === 'b' && (
        <button
          type="button"
          data-testid="bulk-mode"
          className={`rounded-md border px-3 py-1.5 font-medium ${b.mode ? 'border-accent bg-accent text-on-accent' : 'border-line bg-surface hover:bg-surface2'}`}
          onClick={() => {
            b.setMode(!b.mode);
            if (b.mode) b.setPicked(new Set());
          }}
        >
          {b.mode ? 'Done picking' : 'Pick several'}
        </button>
      )}
      {(b.be1 === 'a' || (b.be1 === 'b' && b.mode)) && (b.picked.size > 0 || b.be1 === 'b') && (
        <label className="flex items-center gap-2 text-text2">
          <input
            type="checkbox"
            ref={(el) => {
              if (el) el.indeterminate = !all && b.picked.size > 0;
            }}
            className="h-5 w-5 accent-[var(--color-accent)]"
            checked={all}
            onChange={() =>
              b.setPicked(all ? new Set() : new Set(b.rows.map((r) => r.feature_id)))
            }
          />
          Pick all {b.rows.length} shown
        </label>
      )}
      {b.be1 === 'b' && b.mode && (
        <span className="text-text2">
          Drag is off while picking
          <InfoTip label="Why drag is off">
            A click picks a row while you pick. Press Done picking to drag or open a feature again.
          </InfoTip>
        </span>
      )}
      {b.be1 === 'c' && (
        <span className="flex items-center gap-1 text-text2">
          Pick several
          <InfoTip label="How to pick several">
            1. Ctrl-click (⌘-click on a Mac) a row. 2. Shift-click another to pick all between.
          </InfoTip>
        </span>
      )}
    </div>
  );
}

const btn =
  'rounded-md border border-line bg-surface px-3 py-1.5 text-[length:var(--simple-small)] font-medium [word-spacing:0.12em] hover:bg-surface2';
const primary =
  'rounded-md bg-accent px-4 py-1.5 text-[length:var(--simple-small)] font-semibold text-on-accent';

const FIELDS: [Field, string][] = [
  ['owner', 'Owner'],
  ['status', 'Status'],
  ['dates', 'Dates'],
  ['track', 'Track'],
];

function FieldPick({ f, b }: { f: Field; b: Bulk }) {
  const opts =
    f === 'owner' ? BULK_PEOPLE : f === 'status' ? BULK_STATUSES : f === 'track' ? BULK_TRACKS : [];
  if (f === 'dates')
    return (
      <div className="flex flex-col gap-2">
        <span className="text-text2">Set end date</span>
        <div className="flex flex-wrap gap-2">
          {['Dec 15', 'Jan 12', 'Feb 9'].map((d) => (
            <button
              key={d}
              type="button"
              data-testid={`bulk-end-${d.replace(' ', '-')}`}
              className={`${btn} ${b.draft.end === d ? '!border-accent !bg-accent-soft' : ''}`}
              onClick={() => {
                b.setDraft({ ...b.draft, end: d, shift: undefined });
                if (b.be2 === 'c') b.setOpen(null);
              }}
            >
              {d}
            </button>
          ))}
        </div>
        <span className="text-text2">Or shift end dates by</span>
        <div className="flex flex-wrap gap-2">
          {[-2, -1, 1, 2, 4].map((w) => (
            <button
              key={w}
              type="button"
              data-testid={`bulk-shift-${w}`}
              className={`${btn} ${b.draft.shift === w ? '!border-accent !bg-accent-soft' : ''}`}
              onClick={() => {
                b.setDraft({ ...b.draft, shift: w, end: undefined });
                if (b.be2 === 'c') b.setOpen(null);
              }}
            >
              {w > 0 ? '+' : '−'}
              {Math.abs(w)} {Math.abs(w) === 1 ? 'week' : 'weeks'}
            </button>
          ))}
        </div>
      </div>
    );
  return (
    <div className="flex flex-col">
      {opts.map((o) => {
        const on = (b.draft as Record<string, unknown>)[f] === o;
        return (
          <button
            key={o}
            type="button"
            data-testid={`bulk-opt-${o}`}
            className={`flex items-center justify-between rounded-md px-3 py-2 text-left hover:bg-surface2 ${on ? 'bg-accent-soft font-semibold' : ''}`}
            onClick={() => {
              b.setDraft({ ...b.draft, [f]: o });
              if (b.be2 === 'c') b.setOpen(null);
            }}
          >
            {o}
            {on && <span aria-hidden>✓</span>}
          </button>
        );
      })}
    </div>
  );
}

/** The before → after list (BE2 a's popover, BE2 b's sheet), grouped by right when BE3 a. */
function Preview({ b, max: cap, grow }: { b: Bulk; max: number; grow?: boolean }) {
  const [whole, setWhole] = useState(false);
  const max = whole ? 999 : cap;
  const got = b.rows.filter((r) => b.picked.has(r.feature_id));
  const line = (r: R) => (
    <li key={r.feature_id} className="flex flex-wrap items-baseline gap-x-2 py-1">
      <span className="min-w-0 font-medium">
        {bulkTitle(b, r)} {r.own_key && <span className="text-text2">{r.own_key}</span>}
      </span>
      <span className="text-text2">
        {b.draft.status &&
          (statusOf(r) === b.draft.status ? (
            <i>already {b.draft.status}</i>
          ) : (
            <>
              <s>{statusOf(r)}</s> → <b className="text-text">{b.draft.status}</b>{' '}
            </>
          ))}
        {b.draft.owner && (
          <>
            <s>{ownerOf(r) || 'No owner'}</s> → <b className="text-text">{b.draft.owner}</b>{' '}
          </>
        )}
        {b.draft.shift || b.draft.end ? (
          <span className="whitespace-nowrap">
            End <s>{day(r.end_date)}</s> → <b className="text-text">{b.draft.end ?? day(r.end_date, b.draft.shift)}</b>
          </span>
        ) : null}
        {b.draft.track && (
          <>
            Track → <b className="text-text">{b.draft.track}</b>
          </>
        )}
      </span>
    </li>
  );
  const list = (rs: R[]) => (
    <ul className="divide-y divide-line">
      {rs.slice(0, max).map(line)}
      {rs.length > max && (
        <li className="py-1 text-text2">
          {grow ? (
            <button type="button" className="text-accent underline" onClick={() => setWhole(true)}>
              and {rs.length - max} more
            </button>
          ) : (
            <>and {rs.length - max} more</>
          )}
        </li>
      )}
    </ul>
  );
  if (b.mixed && b.be3 === 'a') {
    const groups: [Right, string][] = [
      ['edit', 'Changes now'],
      ['propose', `Sent to ${BULK_APPROVER} to approve`],
      ['none', 'Not changed'],
    ];
    return (
      <div className="flex flex-col gap-3" data-testid="bulk-preview">
        {groups.map(([k, label]) => {
          const rs = got.filter((r) => b.right(r) === k);
          if (!rs.length) return null;
          return (
            <section key={k}>
              <h4 className="flex items-center gap-1 font-semibold">
                {label} · {rs.length}
                {k === 'none' && (
                  <InfoTip label="Why not">{rs.map((r) => `${r.title}: ${BULK_WHY[r.title] ?? 'read only'}`).join('. ')}</InfoTip>
                )}
              </h4>
              {k === 'none' ? (
                <ul>
                  {rs.map((r) => (
                    <li key={r.feature_id} className="py-1 text-text2">
                      {bulkTitle(b, r)} · {BULK_WHY[r.title] ?? 'Read only'}
                    </li>
                  ))}
                </ul>
              ) : (
                list(rs)
              )}
            </section>
          );
        })}
      </div>
    );
  }
  return <div data-testid="bulk-preview">{list(got)}</div>;
}

function applyWords(b: Bulk): string {
  const got = b.rows.filter((r) => b.picked.has(r.feature_id));
  if (b.mixed && b.be3 === 'c') return `Change ${got.length}`;
  const now = got.filter((r) => b.right(r) === 'edit').length;
  const prop = got.filter((r) => b.right(r) === 'propose').length;
  if (!now && prop) return `Propose ${prop} changes`;
  if (prop) return `Change ${now}, propose ${prop}`;
  return `Change ${now}`;
}

/** The bulk bar (BE2 a and c) or bar + sheet (BE2 b), and BE3 a's result strip. */
export function BulkBar() {
  const b = useBulk();
  if (!b) return null;
  const n = b.picked.size;
  const has = Object.values(b.draft).some(Boolean);
  return (
    <>
      {n > 0 && <div aria-hidden className="h-28" />}
      {n > 0 && b.open !== 'sheet' && (
        <div
          data-testid="bulk-dock"
          className="fixed inset-x-0 bottom-0 z-40 border-t border-line bg-bg px-3 pt-2 pb-3 max-[600px]:bottom-[var(--phone-tab-bar)] max-[600px]:pb-2 md:left-[232px] md:px-9"
        >
        <div
          data-testid="bulk-bar"
          className="relative mx-auto flex max-w-4xl flex-wrap items-center gap-2 max-sm:grid max-sm:grid-cols-4 max-sm:gap-2 max-sm:px-3 whitespace-nowrap rounded-[var(--simple-card-radius)] border border-line bg-surface px-4 py-3 text-[length:var(--simple-small)] shadow-lg"
        >
          <span className="font-semibold max-sm:col-span-2" data-testid="bulk-count">
            {n} picked
          </span>
          <button type="button" className="text-accent underline max-sm:col-span-2 max-sm:text-right" onClick={() => b.setPicked(new Set())}>
            Clear
          </button>
          <span className="mx-1 h-6 w-px bg-line max-sm:hidden" aria-hidden />
          {b.commenter && (
            <span className="text-text2 max-sm:col-span-4 max-sm:order-last" data-testid="bulk-commenter">
              Your changes go to {BULK_APPROVER} to approve
            </span>
          )}
          {b.be2 === 'b' ? (
            <button type="button" className={`${primary} max-sm:col-span-4`} data-testid="bulk-edit" onClick={() => b.setOpen('sheet')}>
              Edit {n} features
            </button>
          ) : (
            FIELDS.map(([f, label]) => (
              <span key={f} className="relative">
                <button
                  type="button"
                  data-testid={`bulk-field-${f}`}
                  aria-expanded={b.open === f}
                  className={`${btn} max-sm:w-full max-sm:px-1 ${b.open === f || ((b.draft as Record<string, unknown>)[f === 'dates' ? 'shift' : f] || (f === 'dates' && b.draft.end)) ? '!border-accent !bg-accent-soft' : ''}`}
                  onClick={() => b.setOpen(b.open === f ? null : f)}
                >
                  {label} ▾
                </button>
                {b.open === f && b.be2 === 'a' && (
                  <div
                    data-testid="bulk-pop"
                    className="absolute bottom-full left-0 mb-2 whitespace-normal flex max-h-[70vh] w-[min(30rem,calc(100vw-1.5rem))] flex-col gap-3 overflow-auto rounded-[var(--simple-card-radius)] border border-line bg-surface p-3 shadow-lg max-sm:fixed max-sm:inset-x-3 max-sm:bottom-[calc(8.1rem+var(--phone-tab-bar))] max-sm:w-auto"
                  >
                    <FieldPick f={f} b={b} />
                    {has && (
                      <>
                        <Preview b={b} max={5} />
                        <div className="flex justify-end gap-2">
                          <button type="button" className={btn} onClick={() => b.setOpen(null)}>
                            Cancel
                          </button>
                          <button type="button" className={primary} data-testid="bulk-apply" onClick={b.apply}>
                            {applyWords(b)}
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                )}
                {b.open === f && b.be2 === 'c' && (
                  <div
                    data-testid="bulk-pop"
                    className="absolute bottom-full left-0 mb-2 whitespace-normal w-[min(22rem,calc(100vw-1.5rem))] rounded-[var(--simple-card-radius)] border border-line bg-surface p-3 shadow-lg max-sm:fixed max-sm:inset-x-3 max-sm:bottom-[calc(8.1rem+var(--phone-tab-bar))] max-sm:w-auto"
                  >
                    <FieldPick f={f} b={b} />
                  </div>
                )}
              </span>
            ))
          )}
          {b.be2 === 'c' && has && (
            <button type="button" className={`${primary} ml-auto max-sm:col-span-4`} data-testid="bulk-apply" onClick={b.apply}>
              {applyWords(b)}
            </button>
          )}
        </div>
        </div>
      )}
      {b.open === 'sheet' && n > 0 && (
        <aside
          data-testid="bulk-sheet"
          aria-label={`Edit ${n} features`}
          className="fixed inset-y-0 right-0 z-50 flex w-[min(30rem,100vw)] flex-col gap-2.5 overflow-auto border-l border-line bg-surface p-5 shadow-xl"
        >
          <header className="flex items-center justify-between">
            <h2 className="text-[length:var(--simple-h2)] font-semibold">Edit {n} features</h2>
          </header>
          {FIELDS.map(([f, label]) => (
            <details
              key={f}
              open={b.open2 === f || (f === 'dates' ? b.draft.shift !== undefined || !!b.draft.owner : f === 'owner' && !b.draft.owner && !b.open2)}
              className="rounded-md border border-line px-3 py-2"
            >
              <summary className="cursor-pointer font-semibold" data-testid={`bulk-sum-${f}`} onClick={(e) => { e.preventDefault(); b.setOpen2(b.open2 === f ? null : f); }}>
                {label}
                {(b.draft as Record<string, unknown>)[f === 'dates' ? 'shift' : f] || (f === 'dates' && b.draft.end) ? (
                  <span className="ml-2 font-normal text-accent">
                    {f === 'dates' ? (b.draft.end ? `End ${b.draft.end}` : `${b.draft.shift} weeks`) : String((b.draft as Record<string, unknown>)[f])}
                  </span>
                ) : (
                  <span className="ml-2 font-normal text-text2">keep</span>
                )}
              </summary>
              <div className="pt-2">
                <FieldPick f={f} b={b} />
              </div>
            </details>
          ))}
          {has && (
            <section className="pb-2">
              <h3 className="mb-1 font-semibold">What changes</h3>
              <Preview b={b} max={n > 4 ? 3 : 4} grow />
            </section>
          )}
          <footer className="sticky -bottom-5 -mx-5 -mb-5 mt-auto flex justify-end gap-2 border-t border-line bg-surface px-5 py-3">
            <button type="button" className={btn} onClick={() => b.setOpen(null)}>
              Cancel
            </button>
            <button type="button" className={primary} disabled={!has} data-testid="bulk-apply" onClick={b.apply}>
              {applyWords(b)}
            </button>
          </footer>
        </aside>
      )}
    </>
  );
}
