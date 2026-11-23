'use client';

// MOCK-HOOK mk-prd-review: the whole file is a mock-up for the owner to pick from (PR1..PR3).
// MOCK-HOOK URL switches: ?pr1=a|b|c|d (reading view) ?pr2=a|b|c (changing in place)
// MOCK-HOOK ?pr3=a|b|c|d (what changed), state: &phase=rest|open|mid|done, &task=section|feature|owner|date|milestone,
// MOCK-HOOK &big=1 (20 features), &who=viewer, &view=roadmap (the roadmap the PRD feeds).

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { InfoTip } from '@/components/ds/InfoTip';
import {
  MK_CHANGES,
  MK_GOALS,
  MK_MILESTONES,
  MK_PEOPLE,
  MK_PRD,
  MK_SECTIONS,
  mkFeatures,
  type MkChange,
  type MkFeature,
} from '@/lib/api/mock/mk-prd-review';

type P = Record<string, string>; // MOCK-HOOK
export function mkParams(): P {
  // MOCK-HOOK
  if (typeof window === 'undefined') return {};
  return Object.fromEntries(new URLSearchParams(window.location.search).entries());
}
export const mkActive = (p: P) => !!(p.pr1 || p.pr2 || p.pr3); // MOCK-HOOK

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const day = (iso: string) => {
  const [, m, d] = iso.split('-').map(Number);
  return `${MON[m - 1]} ${d}`;
};
const addDays = (iso: string, n: number) =>
  new Date(Date.parse(iso + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
const SPAN0 = Date.parse('2026-11-23T00:00:00Z');
const SPAN1 = Date.parse('2027-03-08T00:00:00Z');
const pct = (iso: string) =>
  Math.max(0, Math.min(100, ((Date.parse(iso + 'T00:00:00Z') - SPAN0) / (SPAN1 - SPAN0)) * 100));
const person = (id: string | null) => MK_PEOPLE.find((p) => p.id === id) ?? null;
const goalName = (id: string) => MK_GOALS.find((g) => g.id === id)?.name ?? '';
const MONTHS = [
  ['Dec', '2026-12-01'],
  ['Jan', '2027-01-01'],
  ['Feb', '2027-02-01'],
  ['Mar', '2027-03-01'],
];

type Mark = { kind: MkChange['kind']; change: MkChange } | null;
type Resolved = Record<string, 'accepted' | 'flagged' | 'undone'>;

/** One editable value: how it is marked and opened depends on PR2's proposal. */
function Editable({
  mode,
  label,
  open,
  onOpen,
  children,
  field,
  saved,
}: {
  mode: 'a' | 'b' | 'c' | 'none';
  label: string;
  open: boolean;
  onOpen: () => void;
  children: ReactNode;
  field: ReactNode;
  saved?: boolean;
}) {
  if (mode === 'none' || mode === 'c') return <>{children}</>;
  if (open || mode === 'b')
    return <span className="mk-field inline-flex items-center gap-2">{field}</span>;
  return (
    <button
      type="button"
      aria-label={`Change ${label}`}
      onClick={onOpen}
      className="mk-edit rounded-md text-left decoration-dotted decoration-[1.5px] underline-offset-4 hover:bg-accent-soft hover:underline focus-visible:bg-accent-soft"
    >
      {children}
      {saved && <span className="ml-2 text-xs font-semibold text-pass">Saved</span>}
    </button>
  );
}

function Chip({
  children,
  tone = 'plain',
}: {
  children: ReactNode;
  tone?: 'plain' | 'warn' | 'pass' | 'crit' | 'accent';
}) {
  const t = {
    plain: 'bg-surface2 text-text2',
    warn: 'bg-warn-bg text-warn',
    pass: 'bg-pass-bg text-pass',
    crit: 'bg-crit-bg text-crit',
    accent: 'bg-accent-soft text-accent-ink',
  }[tone];
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-sm font-semibold ${t}`}
    >
      {children}
    </span>
  );
}

function Avatar({ id }: { id: string | null }) {
  const p = person(id);
  if (!p) return null;
  return (
    <span className="inline-grid size-7 flex-none place-items-center rounded-full bg-accent-soft text-xs font-bold text-accent-ink">
      {p.initials}
    </span>
  );
}

function Bar({ f, mark, ghost }: { f: MkFeature; mark?: Mark; ghost?: string }) {
  const l = pct(f.start);
  const w = Math.max(2, pct(f.end) - l);
  const tone =
    f.status === 'draft'
      ? 'bg-[repeating-linear-gradient(135deg,var(--accent-soft)_0_6px,var(--surface2)_6px_12px)] border border-dashed border-accent'
      : 'bg-accent/55';
  return (
    <div className="relative h-5 w-full rounded bg-[var(--surface2)]/60" aria-hidden>
      {MONTHS.map(([m, iso]) => (
        <span
          key={m}
          className="absolute top-0 bottom-0 border-l border-line"
          style={{ left: `${pct(iso)}%` }}
        />
      ))}
      {ghost && (
        <span
          className="absolute top-1 bottom-1 rounded border border-dashed border-text-faint"
          style={{ left: `${l}%`, width: `${Math.max(2, pct(ghost) - l)}%` }}
        />
      )}
      <span
        className={`absolute top-0.5 bottom-0.5 rounded ${tone} ${mark?.kind === 'added' ? 'ring-2 ring-pass' : mark?.kind === 'changed' ? 'ring-2 ring-warn' : ''}`}
        style={{ left: `${l}%`, width: `${w}%` }}
      />
    </div>
  );
}

function MonthHead() {
  return (
    <div className="relative h-5 w-full text-xs text-text-faint" aria-hidden>
      {MONTHS.map(([m, iso]) => (
        <span key={m} className="absolute" style={{ left: `calc(${pct(iso)}% + 4px)` }}>
          {m}
        </span>
      ))}
      <span
        className="absolute top-0 h-5 border-l-2 border-accent"
        style={{ left: `${pct('2026-11-23')}%` }}
      />
    </div>
  );
}

/** MOCK-HOOK The meeting's result: Bulk reply added (as typed, with the PRD owner and dates after
 * Reply templates), Assign rules moved a week, Snooze a thread owned. */
function mkDoneStory(fs: MkFeature[]) {
  const inGoal = fs.filter((f) => f.goal === 'g1');
  const last = inGoal[inGoal.length - 1];
  const start = addDays(last.end, 3);
  fs.splice(fs.lastIndexOf(last) + 1, 0, {
    id: 'fn',
    code: 'F-227',
    name: 'Bulk reply to similar requests',
    goal: 'g1',
    owner: 'p1',
    start,
    end: addDays(start, 25),
    status: 'planned',
  });
  const f2 = fs.find((f) => f.id === 'f2');
  if (f2) f2.end = addDays(f2.end, 7);
  const f5 = fs.find((f) => f.id === 'f5');
  if (f5) Object.assign(f5, { owner: 'p3', status: 'planned' });
}

export function MkPrdReview() {
  const p = useMemo(mkParams, []);
  const d1 = (p.pr1 ?? 'a') as 'a' | 'b' | 'c' | 'd';
  const d2 = (p.pr2 ?? (p.pr3 ? '' : p.pr1 ? '' : 'a')) as 'a' | 'b' | 'c' | '';
  const d3 = (p.pr3 ?? '') as 'a' | 'b' | 'c' | 'd' | '';
  const phase = p.phase ?? 'rest';
  const task = p.task ?? '';
  const big = p.big === '1';
  const viewer = p.who === 'viewer';
  const canEdit = !viewer && !!d2;
  const mode: 'a' | 'b' | 'c' | 'none' = canEdit ? (d2 as 'a' | 'b' | 'c') : 'none';

  const [features, setFeatures] = useState<MkFeature[]>(() => {
    const fs = mkFeatures(big);
    if (phase === 'done' && d2) {
      mkDoneStory(fs); // MOCK-HOOK the result of the story
    }
    return fs;
  });
  const [milestones, setMilestones] = useState(MK_MILESTONES);
  const [sections, setSections] = useState(() =>
    MK_SECTIONS.map((s) =>
      phase === 'done' && d2 && s.key === 'risks'
        ? {
            ...s,
            text: 'Assign rules need a topic list from each team before beta; Theo asks the 20 beta teams this week. Open: do snoozed threads count as lost after 3 days?',
          }
        : s,
    ),
  );
  const [editing, setEditing] = useState<string | null>(() =>
    phase === 'open' || phase === 'mid'
      ? task === 'section'
        ? 'sec:risks'
        : task === 'owner'
          ? 'owner:f5'
          : task === 'date'
            ? 'date:f2'
            : task === 'feature'
              ? 'add:g1'
              : task === 'milestone'
                ? 'add:ms'
                : null
      : null,
  );
  const [panel, setPanel] = useState<string | null>(() =>
    d2 === 'c' && (phase === 'open' || phase === 'mid') && task !== 'section' && task !== 'feature'
      ? task === 'date'
        ? 'f2'
        : 'f5'
      : d2 === 'c' && task === 'feature' && phase === 'mid'
        ? 'new'
        : null,
  );
  // MOCK-HOOK the owner list drawn open (a native list can't be snapshotted open), pointer on Dot.
  const [ownerList, setOwnerList] = useState<string | null>(
    phase === 'open' && task === 'owner' ? 'f5' : null,
  );
  const [editAll, setEditAll] = useState(d2 === 'b' && phase !== 'rest');
  const [draft, setDraft] = useState(() =>
    phase === 'mid' && task === 'feature'
      ? 'Bulk reply to similar requests'
      : phase === 'mid' && task === 'milestone'
        ? 'Pricing rev'
        : '',
  );
  const [savedKey, setSavedKey] = useState<string | null>(phase === 'done' && d2 ? 'fn' : null);
  const [resolved, setResolved] = useState<Resolved>((): Resolved =>
    phase === 'done' && d3 ? { c3: 'accepted', c6: 'undone', c2: 'flagged', c4: 'accepted' } : {},
  );
  const [hoverChange, setHoverChange] = useState<string | null>(
    phase === 'open' && d3 ? 'c2' : null,
  );
  const [onlyChanges, setOnlyChanges] = useState(false);
  const [compare, setCompare] = useState<'now' | 'both'>(
    d3 === 'c' && phase !== 'rest' ? 'both' : 'now',
  );
  const inputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (editing?.startsWith('add:')) inputRef.current?.focus();
  }, [editing]);

  const editOn = mode === 'b' ? editAll : mode !== 'none';
  const fieldMode: 'a' | 'b' | 'c' | 'none' = mode === 'b' && !editAll ? 'none' : mode;
  const changes = d3 ? MK_CHANGES : [];
  const live = changes.filter((c) => resolved[c.id] !== 'accepted' && resolved[c.id] !== 'undone');
  const markOf = (where: string): Mark => {
    const c = changes.find(
      (x) => x.where === where && resolved[x.id] !== 'accepted' && resolved[x.id] !== 'undone',
    );
    return c && (d3 === 'a' || d3 === 'b' || d3 === 'c') ? { kind: c.kind, change: c } : null;
  };
  const undone = (where: string) =>
    changes.find((x) => x.where === where && resolved[x.id] === 'undone');
  const featView = (f: MkFeature): MkFeature => {
    const u = undone(f.id);
    if (u?.field === 'owner') return { ...f, owner: 'p6' };
    if (u?.field === 'dates') return { ...f, end: '2026-12-22' };
    return f;
  };
  const isSaved = (k: string) =>
    savedKey === k || (phase === 'done' && !!d2 && ['fn', 'f2', 'f5', 'sec:risks'].includes(k));
  const saved = (k: string) => {
    setSavedKey(k);
    setEditing(null);
  };

  const pickOwner = (f: MkFeature, id: string) => {
    setFeatures((fs) => fs.map((x) => (x.id === f.id ? { ...x, owner: id || null } : x)));
    setOwnerList(null);
    saved(f.id);
  };
  const ownerField = (f: MkFeature) => (
    <span className="relative inline-flex">
      <select
        aria-label={`Owner of ${f.name}`}
        className="rounded-md border border-accent bg-surface px-2 py-1 text-base"
        value={f.owner ?? ''}
        onChange={(e) => pickOwner(f, e.target.value)}
      >
        <option value="">No owner</option>
        {MK_PEOPLE.map((x) => (
          <option key={x.id} value={x.id}>
            {x.name}
          </option>
        ))}
      </select>
      {ownerList === f.id && (
        <ul
          role="listbox"
          aria-label={`Owner of ${f.name}`}
          className="absolute top-full left-0 z-30 mt-1 min-w-[12rem] rounded-md border border-line bg-surface py-1 text-base font-normal text-text shadow-lg"
        >
          {MK_PEOPLE.map((x) => (
            <li
              key={x.id}
              role="option"
              aria-selected={x.id === 'p3'}
              onClick={(e) => {
                e.stopPropagation();
                pickOwner(f, x.id);
              }}
              className={`flex cursor-pointer items-center gap-2 px-3 py-1.5 ${x.id === 'p3' ? 'bg-accent-soft' : 'hover:bg-surface2'}`}
            >
              <Avatar id={x.id} />
              {x.name}
              {x.id === 'p3' && (
                <span aria-hidden="true" className="ml-auto text-text-faint">
                  ◂
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </span>
  );
  const shift = (f: MkFeature, which: 'start' | 'end', n: number) =>
    setFeatures((fs) =>
      fs.map((x) => (x.id === f.id ? { ...x, [which]: addDays(x[which], n) } : x)),
    );
  const dateField = (f: MkFeature) => (
    <span className="inline-flex flex-wrap items-center gap-1 rounded-md border border-accent bg-surface px-1.5 py-0.5 text-base">
      {(['start', 'end'] as const).map((w) => (
        <span key={w} className="inline-flex items-center gap-0.5">
          <button
            type="button"
            aria-label={`${w === 'start' ? 'Start' : 'Delivery'} a week earlier`}
            className="rounded px-1.5 hover:bg-accent-soft"
            onClick={() => shift(f, w, -7)}
          >
            ‹
          </button>
          <span className="tabular-nums">{day(f[w])}</span>
          <button
            type="button"
            aria-label={`${w === 'start' ? 'Start' : 'Delivery'} a week later`}
            className="rounded px-1.5 hover:bg-accent-soft"
            onClick={() => shift(f, w, 7)}
          >
            ›
          </button>
          {w === 'start' && <span className="px-0.5 text-text-faint">–</span>}
        </span>
      ))}
    </span>
  );

  const changeActions = (c: MkChange, compact = false) =>
    viewer ? null : (
      <span className={`inline-flex items-center gap-1 ${compact ? '' : 'ml-2'}`}>
        <button
          type="button"
          className="rounded-md border border-line px-2 py-0.5 text-sm font-semibold hover:bg-pass-bg"
          onClick={() => setResolved((r) => ({ ...r, [c.id]: 'accepted' }))}
        >
          Accept
        </button>
        <button
          type="button"
          className="rounded-md border border-line px-2 py-0.5 text-sm font-semibold hover:bg-warn-bg"
          onClick={() => setResolved((r) => ({ ...r, [c.id]: 'flagged' }))}
        >
          Flag
        </button>
        <button
          type="button"
          className="rounded-md border border-line px-2 py-0.5 text-sm font-semibold hover:bg-crit-bg"
          onClick={() => setResolved((r) => ({ ...r, [c.id]: 'undone' }))}
        >
          Undo
        </button>
      </span>
    );
  const changeWords = (c: MkChange) => {
    const f = features.find((x) => x.id === c.where);
    const g = MK_GOALS.find((x) => x.id === c.where);
    const s = MK_SECTIONS.find((x) => x.key === c.where);
    const what = f ? `${f.code} ${f.name}` : g ? `Goal ${g.name}` : s ? s.title : '';
    if (c.kind === 'added') return `Added ${what}`;
    if (c.kind === 'removed') return `Removed from ${what}: “${c.before}”`;
    const field =
      c.field === 'dates'
        ? 'dates'
        : c.field === 'owner'
          ? 'owner'
          : c.field === 'target'
            ? 'target'
            : 'wording';
    return `${what}: ${field} ${c.field === 'text' ? 'changed' : `${c.before} → ${c.after}`}`;
  };
  const markBar = (m: Mark, id?: string) =>
    m
      ? `border-l-[3px] pl-3 ${m.kind === 'added' ? 'border-pass' : m.kind === 'removed' ? 'border-crit' : 'border-warn'} ${hoverChange && hoverChange === m.change.id ? 'bg-accent-soft' : ''}`
      : id && changes.some((c) => c.where === id && resolved[c.id] === 'flagged')
        ? 'border-l-[3px] border-dashed border-warn pl-3'
        : d3
          ? 'border-l-[3px] border-transparent pl-3'
          : '';
  const inlineMark = (m: Mark) => {
    if (!m || d3 !== 'a') return null;
    const c = m.change;
    return (
      <span className="inline-flex flex-wrap items-center gap-1 text-sm">
        <Chip tone={c.kind === 'added' ? 'pass' : c.kind === 'removed' ? 'crit' : 'warn'}>
          {c.kind === 'added' ? 'New' : c.kind === 'removed' ? 'Removed' : 'Changed'}
        </Chip>
        {c.before && c.kind === 'changed' && c.field !== 'text' && (
          <span className="text-text-faint line-through">{c.before}</span>
        )}
        {hoverChange === c.id && changeActions(c)}
      </span>
    );
  };
  const flagged = (id: string) =>
    changes.some((c) => c.where === id && resolved[c.id] === 'flagged') ? (
      <Chip tone="warn">Flagged for Mara</Chip>
    ) : null;

  const featureRow = (f0: MkFeature, dense = false) => {
    const f = featView(f0);
    const m = markOf(f.id);
    const owner = person(f.owner);
    const rowClick = mode === 'c' ? () => setPanel(f.id) : undefined;
    return (
      <li
        key={f.id}
        data-mk-row={f.id}
        onMouseEnter={() => d3 === 'a' && m && setHoverChange(m.change.id)}
        className={`grid items-center gap-x-4 gap-y-1 border-b border-[var(--simple-rule)] py-${dense ? '1.5' : '2.5'} last:border-b-0 max-[600px]:grid-cols-1 ${d1 === 'c' ? 'grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.1fr)]' : 'grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)_minmax(0,0.9fr)_minmax(0,1.2fr)]'} ${markBar(m, f.id)} ${isSaved(f.id) ? 'bg-accent-soft/60' : ''} ${mode === 'c' ? 'cursor-pointer hover:bg-surface2' : ''}`}
        onClick={rowClick}
      >
        <span className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="font-semibold">
            <span className="mr-1.5 text-sm font-semibold text-text-faint">{f.code}</span>
            {f.name}
          </span>
          {inlineMark(m)}
          {flagged(f.id)}
          {isSaved(f.id) && <span className="text-xs font-semibold text-pass">Saved · Undo</span>}
        </span>
        {d1 === 'c' && <span className="simple-small max-[600px]:hidden">{goalName(f.goal)}</span>}
        <span className="flex min-w-0 items-center gap-2 text-base">
          <Editable
            mode={fieldMode}
            label={`owner of ${f.name}`}
            open={editing === `owner:${f.id}`}
            onOpen={() => setEditing(`owner:${f.id}`)}
            field={ownerField(f)}
          >
            {owner ? (
              <span className="inline-flex items-center gap-2">
                <Avatar id={f.owner} />
                {owner.name}
              </span>
            ) : (
              <Chip tone="warn">No owner{editOn && fieldMode !== 'c' ? ' · pick' : ''}</Chip>
            )}
          </Editable>
        </span>
        <span className="text-base tabular-nums">
          <Editable
            mode={fieldMode}
            label={`dates of ${f.name}`}
            open={editing === `date:${f.id}`}
            onOpen={() => setEditing(`date:${f.id}`)}
            field={dateField(f)}
          >
            {day(f.start)} – {day(f.end)}
          </Editable>
        </span>
        {d1 !== 'c' ? (
          <span className="max-[600px]:hidden">
            <Bar
              f={f}
              mark={m}
              ghost={d3 && m?.change.field === 'dates' ? '2026-12-22' : undefined}
            />
          </span>
        ) : (
          <span className="simple-small max-[600px]:hidden">
            {f.status === 'draft' ? 'Draft' : f.status === 'building' ? 'Building' : 'Planned'}
            {f.milestone ? ` · ${MK_MILESTONES.find((x) => x.id === f.milestone)?.name ?? ''}` : ''}
          </span>
        )}
      </li>
    );
  };

  const addRow = (key: string, what: string, onAdd: (name: string) => void) => {
    if (!canEdit || (mode === 'b' && !editAll)) return null;
    const open = editing === key;
    return (
      <li className="py-2">
        {open ? (
          <span className="flex flex-wrap items-center gap-2">
            <input
              ref={inputRef}
              aria-label={`New ${what}`}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && draft.trim()) {
                  onAdd(draft.trim());
                  setDraft('');
                }
                if (e.key === 'Escape') setEditing(null);
              }}
              placeholder={`Name the ${what}`}
              className="min-w-[16rem] flex-1 rounded-md border-2 border-accent bg-surface px-3 py-1.5 text-base outline-none"
            />
            <span className="simple-small">Enter adds it</span>
            <InfoTip label={`Adding a ${what}`} align="start">
              {what === 'feature'
                ? 'It lands here, under this goal, starting after the last feature of the goal. Its owner is the PRD’s owner until you pick another. The roadmap shows it at once.'
                : 'It lands on the day the last feature before it ends. Drag its diamond on the timeline to move it.'}
            </InfoTip>
          </span>
        ) : (
          <button
            type="button"
            onClick={() => (mode === 'c' && what === 'feature' ? setPanel('new') : setEditing(key))}
            className="flex w-full items-center gap-2 rounded-md border border-dashed border-line px-3 py-1.5 text-left text-base font-semibold text-accent-ink hover:border-accent hover:bg-accent-soft"
          >
            + Add a {what}
          </button>
        )}
      </li>
    );
  };
  const addFeature = (goal: string) => (name: string) => {
    const inGoal = features.filter((f) => f.goal === goal);
    const last = inGoal[inGoal.length - 1];
    const start = last ? addDays(last.end, 3) : '2026-12-01';
    const nf: MkFeature = {
      id: `n${Date.now()}`,
      code: 'F-227', // MOCK-HOOK the story's one new feature
      name,
      goal,
      owner: 'p1',
      start,
      end: addDays(start, 25),
      status: 'planned',
    };
    setFeatures((fs) => {
      const i = fs.lastIndexOf(last!);
      const c = [...fs];
      c.splice(i + 1, 0, nf);
      return c;
    });
    saved(nf.id);
  };

  const sectionBlock = (s: (typeof MK_SECTIONS)[number], folded: boolean) => {
    const m = markOf(s.key);
    const open = editing === `sec:${s.key}`;
    const removed = d3 && s.key === 'not' && m ? MK_CHANGES.find((c) => c.id === 'c6') : null;
    const changedText = d3 && s.key === 'problem' && m;
    const body =
      open || (mode === 'b' && editAll) ? (
        <textarea
          aria-label={s.title}
          defaultValue={s.text}
          autoFocus={open}
          onBlur={(e) => {
            const v = e.target.value;
            setSections((ss) => ss.map((x) => (x.key === s.key ? { ...x, text: v } : x)));
            if (open) saved(`sec:${s.key}`);
          }}
          rows={phase === 'mid' && open ? 3 : 2}
          className="w-full resize-y rounded-md border-2 border-accent bg-surface px-3 py-2 text-base leading-6"
        />
      ) : (
        <Editable
          mode={mode === 'c' ? 'a' : fieldMode}
          label={s.title}
          open={false}
          onOpen={() => setEditing(`sec:${s.key}`)}
          field={null}
          saved={isSaved(`sec:${s.key}`)}
        >
          {changedText && d3 === 'a' ? (
            <span>
              Small support teams answer customers from personal mailboxes. Requests get lost
              between people
              <span className="rounded bg-warn-bg px-0.5 text-text">
                , and the first reply takes most of a working day
              </span>
              .
            </span>
          ) : (
            s.text
          )}
          {removed && d3 === 'a' && (
            <span className="ml-1 rounded bg-crit-bg px-0.5 text-crit line-through">
              {removed.before}
            </span>
          )}
        </Editable>
      );
    return (
      <div
        key={s.key}
        onMouseEnter={() => d3 === 'a' && m && setHoverChange(m.change.id)}
        className={`grid gap-x-6 gap-y-1 py-2.5 ${folded ? 'grid-cols-[11rem_minmax(0,1fr)] max-[600px]:grid-cols-1' : 'grid-cols-1'} ${markBar(m, s.key)}`}
      >
        <h3 className={folded ? 'text-base font-semibold text-text2' : 'simple-h2'}>
          {s.title} {inlineMark(m)}
        </h3>
        <div className={`${folded ? 'text-base leading-6' : ''} max-w-[70ch]`}>
          {body}
          {open && phase === 'mid' && (
            <span className="simple-small mt-1 block">
              Saves when you click away · Esc puts it back
            </span>
          )}
        </div>
      </div>
    );
  };

  const goalHead = (g: (typeof MK_GOALS)[number]) => {
    const m = markOf(g.id);
    return (
      <div
        className={`flex flex-wrap items-baseline gap-x-3 gap-y-1 ${markBar(m, g.id)}`}
        onMouseEnter={() => d3 === 'a' && m && setHoverChange(m.change.id)}
      >
        <h3 className="simple-h2">{g.name}</h3>
        <span className="text-base text-text2">
          {g.measure} · from {g.start} to{' '}
          <Editable
            mode={fieldMode}
            label={`target of ${g.name}`}
            open={editing === `target:${g.id}`}
            onOpen={() => setEditing(`target:${g.id}`)}
            field={
              <input
                aria-label="Target"
                defaultValue={undone(g.id) ? '3 h' : g.target}
                className="w-16 rounded-md border border-accent bg-surface px-2 text-base"
              />
            }
          >
            <b className="text-text">{undone(g.id) ? '3 h' : g.target}</b>
          </Editable>
        </span>
        {inlineMark(m)}
      </div>
    );
  };

  const shown = (fs: MkFeature[]) => (onlyChanges ? fs.filter((f) => markOf(f.id)) : fs);

  // ---------- PR1: the reading view ----------
  const byGoal = (
    <div className="flex flex-col gap-7">
      {MK_GOALS.map((g) => (
        <section key={g.id} aria-label={g.name} className="flex flex-col gap-1">
          {goalHead(g)}
          <ul className="flex flex-col">
            {shown(features.filter((f) => f.goal === g.id)).map((f) => featureRow(f, big))}
            {addRow(`add:${g.id}`, 'feature', addFeature(g.id))}
          </ul>
        </section>
      ))}
    </div>
  );
  const timeline = (
    <section aria-label="Timeline" className="flex flex-col gap-2">
      <div className="flex items-baseline gap-3">
        <h2 className="simple-h2">Timeline</h2>
        <InfoTip label="Timeline" align="start">
          The same dates the roadmap shows. A change here moves the roadmap item too.
        </InfoTip>
      </div>
      <div className="grid grid-cols-[minmax(0,13rem)_minmax(0,1fr)] gap-x-4 gap-y-1 max-[600px]:grid-cols-1">
        <span />
        <MonthHead />
        {milestones.map((ms) => (
          <div key={ms.id} className="contents">
            <span
              className={`truncate text-base font-semibold ${ms.id === 'mn' ? 'text-accent-ink' : ''}`}
            >
              ◆ {ms.name}
            </span>
            <div className="relative h-6">
              <span
                className="absolute top-0 text-base text-accent"
                style={{ left: `calc(${pct(ms.date)}% - 6px)` }}
              >
                ◆
              </span>
              <span
                className="absolute top-0.5 text-sm text-text2"
                style={{ left: `calc(${pct(ms.date)}% + 12px)` }}
              >
                {day(ms.date)}
                {ms.id === 'mn' && savedKey === 'fn' ? ' · new' : ''}
              </span>
            </div>
          </div>
        ))}
        {canEdit && (mode !== 'b' || editAll) && (
          <div className="col-span-full">
            <ul>
              {addRow('add:ms', 'milestone', (name) => {
                setMilestones((m) => [...m, { id: 'mn', name, date: '2027-02-08' }]);
                saved('mn');
              })}
            </ul>
          </div>
        )}
      </div>
    </section>
  );

  let reading: ReactNode;
  if (d1 === 'a') {
    reading = (
      <>
        <section aria-label="Goals and features" className="simple-card">
          <div className="grid grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)_minmax(0,0.9fr)_minmax(0,1.2fr)] gap-x-4 text-sm font-semibold text-text-faint max-[600px]:hidden">
            <span>Feature</span>
            <span>Owner</span>
            <span>Dates</span>
            <MonthHead />
          </div>
          {byGoal}
        </section>
        <section aria-label="The PRD" className="simple-card gap-0">
          {sections.map((s) => sectionBlock(s, true))}
        </section>
        <section className="simple-card">{timeline}</section>
      </>
    );
  } else if (d1 === 'b') {
    reading = (
      <article className="simple-card gap-6">
        {sections.slice(0, 2).map((s) => sectionBlock(s, false))}
        <div>
          <h2 className="simple-h2 mb-2">What we will build</h2>
          <ul className="flex list-disc flex-col gap-1 pl-6">
            {features.map((f) => (
              <li key={f.id} className="text-base">
                <span className="font-semibold">
                  <span className="mr-1 text-sm text-text-faint">{f.code}</span>
                  {f.name}
                </span>{' '}
                <span className="text-text2">
                  · for {goalName(f.goal)} ·{' '}
                  {person(f.owner)?.name ?? <Chip tone="warn">No owner</Chip>} · {day(f.start)} –{' '}
                  {day(f.end)}
                </span>
              </li>
            ))}
          </ul>
        </div>
        <div>
          <h2 className="simple-h2 mb-2">Outcomes and how we measure them</h2>
          <ul className="flex list-disc flex-col gap-1 pl-6 text-base">
            {MK_GOALS.map((g) => (
              <li key={g.id}>
                <b>{g.name}</b>: {g.measure}, from {g.start} to {g.target}
              </li>
            ))}
          </ul>
        </div>
        {sections.slice(2).map((s) => sectionBlock(s, false))}
        {timeline}
      </article>
    );
  } else if (d1 === 'c') {
    reading = (
      <>
        <section className="simple-card gap-0">
          {sections.slice(0, 2).map((s) => sectionBlock(s, true))}
        </section>
        <section aria-label="Features" className="simple-card">
          <div className="grid grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.1fr)] gap-x-4 border-b border-line pb-1 text-sm font-semibold text-text-faint max-[600px]:hidden">
            <span>Feature</span>
            <span>Goal</span>
            <span>Owner and dates</span>
            <span>Status · milestone</span>
          </div>
          <ul className="flex flex-col">{features.map((f) => featureRow(f, true))}</ul>
        </section>
        <section className="simple-card gap-0">
          {sections.slice(2).map((s) => sectionBlock(s, true))}
        </section>
      </>
    );
  } else {
    reading = (
      <>
        <section aria-label="Timeline" className="simple-card">
          <div className="grid grid-cols-[minmax(0,18rem)_minmax(0,1fr)] gap-x-4 gap-y-1.5 max-[600px]:grid-cols-[minmax(0,10rem)_minmax(0,1fr)]">
            {/* MOCK-HOOK names wrap whole instead of being cut */}
            <span className="text-sm font-semibold text-text-faint">Feature</span>
            <MonthHead />
            {MK_GOALS.map((g) => (
              <div key={g.id} className="contents">
                <span className="col-span-full mt-2 text-base font-semibold text-text2">
                  {g.name} · {g.start} → {g.target}
                </span>
                {features
                  .filter((f) => f.goal === g.id)
                  .map((f) => (
                    <div key={f.id} className="contents">
                      <span className="text-base">
                        <span className="mr-1 text-sm text-text-faint">{f.code}</span>
                        {f.name}
                      </span>
                      <Bar f={f} />
                    </div>
                  ))}
              </div>
            ))}
          </div>
        </section>
        <section className="simple-card gap-0">
          {sections.map((s) => sectionBlock(s, true))}
        </section>
      </>
    );
  }

  // ---------- PR3: what changed ----------
  const changeCard = (c: MkChange) => (
    <li
      key={c.id}
      onMouseEnter={() => setHoverChange(c.id)}
      className={`flex flex-col gap-1 rounded-lg border px-3 py-2 ${hoverChange === c.id ? 'border-accent bg-accent-soft' : 'border-line'} ${resolved[c.id] ? 'opacity-70' : ''}`}
    >
      <span className="flex items-start gap-2 text-base">
        <span
          className={`mt-1.5 size-2 flex-none rounded-full ${c.kind === 'added' ? 'bg-pass' : c.kind === 'removed' ? 'bg-crit' : 'bg-warn'}`}
        />
        <span className="min-w-0">{changeWords(c)}</span>
      </span>
      <span className="simple-small flex flex-wrap items-center gap-2 text-sm">
        {person(c.by)?.name} · {c.at}
        {resolved[c.id] ? (
          <Chip
            tone={
              resolved[c.id] === 'accepted'
                ? 'pass'
                : resolved[c.id] === 'flagged'
                  ? 'warn'
                  : 'crit'
            }
          >
            {resolved[c.id] === 'accepted'
              ? 'Accepted'
              : resolved[c.id] === 'flagged'
                ? 'Flagged'
                : 'Undone'}
          </Chip>
        ) : (
          changeActions(c, true)
        )}
      </span>
    </li>
  );
  const deltaBar = d3 ? (
    <div
      role="status"
      className="flex flex-wrap items-center gap-3 rounded-lg border border-accent bg-accent-soft px-4 py-2.5 text-base"
    >
      <span className="font-semibold">
        {live.length} {live.length === 1 ? 'change' : 'changes'} since version {MK_PRD.lastVersion}{' '}
        · {MK_PRD.lastVersionAt}
      </span>
      <span className="inline-flex gap-2 text-sm">
        {live.some((c) => c.kind === 'added') && (
          <Chip tone="pass">{live.filter((c) => c.kind === 'added').length} new</Chip>
        )}
        {live.some((c) => c.kind === 'changed') && (
          <Chip tone="warn">{live.filter((c) => c.kind === 'changed').length} changed</Chip>
        )}
        {live.some((c) => c.kind === 'removed') && (
          <Chip tone="crit">{live.filter((c) => c.kind === 'removed').length} removed</Chip>
        )}
      </span>
      {d3 === 'a' && (
        <label className="inline-flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={onlyChanges}
            onChange={(e) => setOnlyChanges(e.target.checked)}
          />{' '}
          Only changed features
        </label>
      )}
      {d3 === 'c' && (
        <span className="inline-flex rounded-lg border border-line bg-surface p-0.5 text-sm">
          {(['now', 'both'] as const).map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => setCompare(v)}
              className={`rounded-md px-3 py-1 font-semibold ${compare === v ? 'bg-accent-soft text-accent-ink' : 'text-text2'}`}
            >
              {v === 'now' ? 'Now' : `Version ${MK_PRD.lastVersion} beside now`}
            </button>
          ))}
        </span>
      )}
      {!viewer && live.length > 0 && (
        <button
          type="button"
          onClick={() => setResolved(Object.fromEntries(live.map((c) => [c.id, 'accepted'])))}
          className="ml-auto rounded-md border border-line bg-surface px-3 py-1 text-sm font-semibold"
        >
          Accept all
        </button>
      )}
      <InfoTip label="Changes since the last version" align="end">
        Accept keeps a change and clears its mark. Flag keeps it and asks its owner to look. Undo
        puts back what version {MK_PRD.lastVersion} said.
      </InfoTip>
    </div>
  ) : null;

  const compareView =
    d3 === 'c' && compare === 'both' ? (
      <section aria-label="Compare versions" className="simple-card">
        <div className="grid grid-cols-2 gap-6 text-sm font-semibold text-text-faint max-[600px]:grid-cols-1">
          <span>
            Version {MK_PRD.lastVersion} · {MK_PRD.lastVersionAt}
          </span>
          <span>Now · version {MK_PRD.version}</span>
        </div>
        <ul className="flex flex-col">
          {MK_CHANGES.map((c) => (
            <li
              key={c.id}
              className="grid grid-cols-2 gap-6 border-b border-[var(--simple-rule)] py-2.5 text-base last:border-b-0 max-[600px]:grid-cols-1"
            >
              <span
                className={c.kind === 'added' ? 'text-text-faint' : 'rounded bg-crit-bg/60 px-1'}
              >
                {c.kind === 'added' ? 'Not there' : `${changeWords(c).split(':')[0]}: ${c.before}`}
              </span>
              <span className="flex flex-wrap items-center gap-2">
                <span
                  className={
                    c.kind === 'removed' ? 'text-text-faint' : 'rounded bg-pass-bg/60 px-1'
                  }
                >
                  {c.kind === 'removed'
                    ? 'Gone'
                    : c.kind === 'added'
                      ? changeWords(c)
                      : `${changeWords(c).split(':')[0]}: ${c.after}`}
                </span>
                {resolved[c.id] ? (
                  <Chip
                    tone={
                      resolved[c.id] === 'accepted'
                        ? 'pass'
                        : resolved[c.id] === 'flagged'
                          ? 'warn'
                          : 'crit'
                    }
                  >
                    {resolved[c.id] === 'accepted'
                      ? 'Accepted'
                      : resolved[c.id] === 'flagged'
                        ? 'Flagged'
                        : 'Undone'}
                  </Chip>
                ) : (
                  changeActions(c, true)
                )}
              </span>
            </li>
          ))}
        </ul>
      </section>
    ) : null;

  // ---------- PR2 c: the side panel ----------
  const pf = panel === 'new' ? null : features.find((f) => f.id === panel);
  const sidePanel =
    mode === 'c' && panel ? (
      <aside
        role="dialog"
        aria-label="Feature"
        className="fixed top-0 right-0 bottom-0 z-40 flex w-[420px] max-w-full flex-col gap-4 overflow-auto border-l border-line bg-surface p-6 shadow-xl"
      >
        <div className="flex items-center justify-between">
          <span className="text-sm font-semibold text-text-faint">
            {pf ? pf.code : 'New feature'}
          </span>
          <button
            type="button"
            aria-label="Close"
            onClick={() => setPanel(null)}
            className="rounded-md px-2 text-xl"
          >
            ×
          </button>
        </div>
        <input
          aria-label="Name"
          defaultValue={pf?.name ?? draft}
          autoFocus={!pf}
          placeholder="Name the feature"
          className="rounded-md border border-line bg-surface px-3 py-2 text-xl font-semibold focus:border-accent"
        />
        <label className="flex flex-col gap-1 text-sm font-semibold text-text2">
          Goal
          <select
            defaultValue={pf?.goal ?? 'g1'}
            className="rounded-md border border-line bg-surface px-2 py-1.5 text-base font-normal text-text"
          >
            {MK_GOALS.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm font-semibold text-text2">
          Owner
          {pf ? (
            ownerField(pf)
          ) : (
            <select className="rounded-md border border-line bg-surface px-2 py-1.5 text-base">
              <option>Mara Quint (you)</option>
            </select>
          )}
        </label>
        <div className="flex flex-col gap-1 text-sm font-semibold text-text2">
          Start and delivery
          {pf ? (
            dateField(pf)
          ) : (
            <span className="text-base font-normal text-text">
              Feb 1 – Feb 26 · after Reply templates
            </span>
          )}
        </div>
        <div className="flex flex-col gap-1 text-sm font-semibold text-text2">
          Depends on
          <span className="text-base font-normal text-text">
            {pf?.id === 'f2' ? 'F-201 One shared inbox per team' : 'Nothing'}
          </span>
        </div>
        <p className="simple-small mt-auto">
          {pf ? 'Each change saves as you make it.' : 'Saves when you name it.'}
        </p>
      </aside>
    ) : null;

  const owner = person(MK_PRD.owner);
  const edited =
    savedKey && phase !== 'done'
      ? 'Saved'
      : phase === 'done' && d2
        ? 'All changes saved · 4 just now'
        : null;
  return (
    <div
      className="simple-page"
      data-testid="simple-page"
      data-mk="prd-review"
      style={
        d3 === 'b' ? { maxWidth: 1360 } : undefined /* MOCK-HOOK room for the changes column */
      }
    >
      <header className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-3 text-base">
          <a href="/simple/one-pagers" className="font-semibold text-accent-ink">
            ‹ One-pagers
          </a>
          <span className="ml-auto flex flex-wrap gap-2">
            {mode === 'b' && (
              <button
                type="button"
                onClick={() => setEditAll((e) => !e)}
                className={`rounded-lg border px-4 py-1.5 font-semibold ${editAll ? 'border-accent bg-accent text-surface' : 'border-line'}`}
              >
                {editAll ? 'Done' : 'Edit'}
              </button>
            )}
            <button
              type="button"
              className="rounded-lg border border-line px-4 py-1.5 font-semibold"
            >
              Present
            </button>
            {!viewer && (
              <button
                type="button"
                className="rounded-lg border border-line px-4 py-1.5 font-semibold max-[600px]:hidden"
              >
                Start a review meeting
              </button>
            )}
          </span>
        </div>
        <h1 className="simple-h1 max-[600px]:sr-only">{MK_PRD.title}</h1>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-base text-text2">
          <Chip tone="accent">{MK_PRD.status}</Chip>
          <span>Version {MK_PRD.version}</span>·
          <span>
            Owner <b className="text-text">{owner?.name}</b>
          </span>
          ·<span className="font-semibold text-text">Nov 30, 2026 → Mar 1, 2027</span>
          <span>
            · {features.length} features · {MK_GOALS.length} goals
          </span>
          {viewer && <Chip>You can read this</Chip>}
          {edited && <span className="font-semibold text-pass">{edited}</span>}
          {mode === 'b' && editAll && <Chip tone="accent">Editing · saves as you type</Chip>}
        </div>
      </header>
      {deltaBar}
      {d3 === 'd' && (
        <section aria-label="What changed" className="simple-card">
          <h2 className="simple-h2">What changed since version {MK_PRD.lastVersion}</h2>
          <ul className="grid grid-cols-2 gap-2 max-[900px]:grid-cols-1">
            {MK_CHANGES.map(changeCard)}
          </ul>
        </section>
      )}
      {compareView}
      {d3 === 'b' ? (
        <div className="grid grid-cols-[minmax(0,1fr)_300px] items-start gap-6 max-[1100px]:grid-cols-1">
          <div className="flex flex-col gap-[var(--simple-space)]">{reading}</div>
          <aside aria-label="Changes" className="sticky top-4 flex flex-col gap-2">
            <h2 className="text-sm font-semibold tracking-wide text-text-faint uppercase">
              Changes since version {MK_PRD.lastVersion}
            </h2>
            <ul className="flex flex-col gap-2">{MK_CHANGES.map(changeCard)}</ul>
          </aside>
        </div>
      ) : (
        reading
      )}
      {sidePanel}
    </div>
  );
}

/** MOCK-HOOK The roadmap the PRD feeds (Simple Roadmap's Timeline, its lane for this PRD), after the meeting's changes. */
export function MkPrdRoadmap() {
  const p = useMemo(mkParams, []);
  const done = p.phase === 'done';
  const fs = mkFeatures(p.big === '1');
  if (done) mkDoneStory(fs); // MOCK-HOOK
  const ms = MK_MILESTONES;
  return (
    <div className="simple-page" data-testid="simple-page" style={{ maxWidth: 'none' }}>
      <header className="flex flex-wrap items-center gap-3">
        <h1 className="simple-h1">Roadmap</h1>
        <span className="simple-small">Timeline · Shared team inbox track</span>
        {done && <Chip tone="pass">3 changes from the PRD review · Nov 23, 10:40 AM PST</Chip>}
      </header>
      <section className="simple-card">
        <div className="grid grid-cols-[minmax(0,22rem)_minmax(0,1fr)] gap-x-4 gap-y-1.5 max-[600px]:grid-cols-[minmax(0,8rem)_minmax(0,1fr)]">
          <span className="text-sm font-semibold text-text-faint">Milestones</span>
          <div className="relative h-16">
            {ms.map((m, i) => (
              <span
                key={m.id}
                className={`absolute text-sm font-semibold whitespace-nowrap ${m.id === 'mn' ? 'rounded bg-pass-bg px-1 text-pass' : 'text-accent-ink'}`}
                style={{
                  left: `calc(${pct(m.date)}% - 6px)`,
                  top: `${i * 20}px`,
                  transform: pct(m.date) > 70 ? 'translateX(calc(-100% + 14px))' : undefined,
                }}
              >
                ◆ {m.name} · {day(m.date)}
              </span>
            ))}
          </div>
          <span />
          <MonthHead />
          {MK_GOALS.map((g) => (
            <div key={g.id} className="contents">
              <span className="col-span-full mt-2 text-base font-semibold text-text2">
                {g.name}
              </span>
              {fs
                .filter((f) => f.goal === g.id)
                .map((f) => {
                  const isNew = done && f.id === 'fn';
                  const moved = done && f.id === 'f2';
                  const owned = done && f.id === 'f5';
                  return (
                    <div key={f.id} className="contents">
                      <span className="flex min-w-0 flex-col items-start gap-0.5 text-base">
                        {/* MOCK-HOOK names wrap whole; badges sit on their own line */}
                        <span>
                          <span className="mr-1 text-sm text-text-faint">{f.code}</span>
                          {f.name}
                        </span>
                        {isNew && <Chip tone="pass">New</Chip>}
                        {moved && <Chip tone="warn">Moved a week</Chip>}
                        {owned && <Chip tone="pass">Owner set</Chip>}
                        {!f.owner && <Chip tone="warn">No owner</Chip>}
                      </span>
                      <Bar
                        f={f}
                        ghost={moved ? '2027-01-12' : undefined}
                        mark={isNew ? { kind: 'added', change: MK_CHANGES[0] } : null}
                      />
                    </div>
                  );
                })}
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
