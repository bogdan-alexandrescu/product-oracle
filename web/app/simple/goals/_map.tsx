'use client';

/**
 * Simple Goal map, drawn as "Goals by tracks grid" (the owner's pick of Nov 11, proposal B): the
 * goals across as columns, each with its milestone strip under it, and the roadmap's tracks as
 * rows; each cell lists the features where that track serves that goal, as chips with their
 * milestones of that goal (a feature serving two goals has a chip under each). A phone scrolls the grid sideways with the track names held at the left. Every chip
 * opens Simple's one feature panel; the menus rename, add, move and trash, each with Undo, and open
 * the goal map's own editors (a gate, a proposed milestone, a goal's metric, a PRD from a milestone).
 */
import { Link, useRouter, useSearchParams } from '@/lib/nav';
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';

import { Button, toast as dsToast, type ToastAsk } from '@/components/ds';
import { Icon } from '@/components/ds/Icon';
import { InfoTip } from '@/components/ds/InfoTip';
import {
  ITEM_GOING_EVENT,
  useFeatureDelete,
  type ItemGoingDetail,
} from '@/components/simple/FeatureDelete';
import { FeatureName } from '@/components/simple/FeatureName';
import { useGoalDrag } from '@/components/simple/GoalDrag';
import { storeGoalOrder } from '@/components/simple/GoalOrder';
import { NewPrdSheet, useCanStartPrd } from '@/components/simple/NewPrd';
import { api, unwrap, type Schemas } from '@/lib/api/client';
import type { GmFeature, GmGoal, GmMilestone, GoalMap } from '@/lib/api/mock/goal-map';
import { CURRENCY_SIGNS, goalFigure } from '@/lib/format';
import { joinTwins } from '@/lib/goal-map-twins';
import { keyResults, type KeyResults } from '@/lib/key-results';
import { useMe } from '@/lib/me';
import { errorMessage, useQuery } from '@/lib/use-query';

import { PendingMark, useFeatureOrder } from '../priorities/feature-order';
import { ChangeFailed, propose, resultWords, undo, type ChangeResult } from '../roadmap/_lib';
import { Editor, type Edit, type EditSave } from './_editors';
import { FeaturePanel, type Placement } from './_panel';

const toast = (ask: ToastAsk) => dsToast({ place: 'corner', ...ask });

type M = GmMilestone;
/** A key result of a goal on the map, shown behind its goal's (i). */
type KrLine = { id: string; code: string | null; name: string };

// Each track its own colour, in turn past the last; No track is grey.
const TRACK_COLORS = [
  '#3b82f6',
  '#0d9488',
  '#8b5cf6',
  '#d97706',
  '#db2777',
  '#0891b2',
  '#65a30d',
  '#dc2626',
  '#4f46e5',
  '#ca8a04',
  '#059669',
  '#c026d3',
];
const NO_TRACK = '#64748b';
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const day = (iso: string | null | undefined) =>
  iso ? `${MON[Number(iso.slice(5, 7)) - 1]} ${Number(iso.slice(8, 10))}` : '';
const STATUS: Record<string, [string, string]> = {
  met: ['Met', 'bg-pass-bg text-pass'],
  on_track: ['On track', 'bg-accent-soft text-accent-ink'],
  at_risk: ['At risk', 'bg-warn-bg text-warn'],
  missed: ['Missed', 'bg-crit-bg text-crit'],
  not_measured: ['Not measured', 'bg-na-bg text-na'],
  no_gate: ['No gate', 'bg-na-bg text-na'],
};

function num(v: number | null, unit: string): string {
  if (v === null) return '—';
  // goal-figure-words: "$20,000", "1,200 shops"; a count to one decimal.
  return goalFigure(CURRENCY_SIGNS[unit.trim().toLowerCase()] ? v : Math.round(v * 10) / 10, unit);
}
const progress = (g: GmGoal) =>
  g.current === null
    ? 0
    : g.target === 0
      ? g.current <= 0
        ? 1
        : 1 / (1 + g.current)
      : Math.min(1, g.current / g.target);
const byDate = (a: M, b: M) => (a.due_on ?? '9999').localeCompare(b.due_on ?? '9999');

/** One feature in the grid: on a milestone (a map feature) or on its goal only (unplaced). */
interface Chip {
  id: string;
  name: string;
  /** Its map feature (null: on no milestone). */
  f: GmFeature | null;
  /** Its first milestone of this goal, by date (null: none). */
  m: M | null;
  /** Every milestone of this goal it serves, by date. */
  ms: M[];
  goal: string;
  /** Its roadmap track (null: none). */
  track: string | null;
  done: boolean;
  lift: GmFeature['lift'];
}

function fstate(c: Chip): { w: string; mark: string; cls: string } {
  if (!c.done) return { w: 'Planned', mark: '', cls: 'text-text2' };
  return c.lift === 'not_helping'
    ? { w: 'Not helping yet', mark: '⚠', cls: 'text-warn' }
    : { w: 'Shipped', mark: '✓', cls: 'text-pass' };
}

/**
 * kr-in-goal-map: the map as Simple shows it. Only top-level goals are goals; a key result (a
 * subgoal of a goal on the map) shows behind its goal's (i), and its milestones and work sit
 * under that goal.
 */
function withKeyResults(
  raw: GoalMap,
  krs: KeyResults,
): { map: GoalMap; lines: Map<string, KrLine[]>; top: (id: string | null) => string | null } {
  const onMap = new Set(raw.goals.map((g) => g.id));
  const top = (id: string | null) => {
    const p = krs.parentOf(id);
    return p && onMap.has(p.id) ? p.id : id;
  };
  const goals = raw.goals.filter((g) => top(g.id) === g.id);
  const lines = new Map(
    goals.map((g) => [
      g.id,
      krs.of(g.id).map((k): KrLine => ({ id: k.id, code: k.code, name: k.name })),
    ]),
  );
  return {
    map: {
      ...raw,
      goals,
      milestones: raw.milestones.map((m) =>
        top(m.goal) === m.goal ? m : { ...m, goal: top(m.goal)! },
      ),
      unplaced: raw.unplaced.map((u) =>
        top(u.goal ?? null) === (u.goal ?? null) ? u : { ...u, goal: top(u.goal ?? null) },
      ),
      off_map: raw.off_map.filter((g) => top(g.id) === g.id),
    },
    lines,
    top,
  };
}

/** The goal and milestones (with their roadmap codes and expected lifts) a chip sits under, for its panel. */
function placement(map: GoalMap, c: Chip, codes: Map<string, string>): Placement | null {
  const gi = map.goals.findIndex((g) => g.id === c.goal);
  const g = map.goals[gi];
  if (!c.m || !g) return null;
  const served = c.ms.map((m) => ({
    milestone: mWords(m, { mcode: codes }),
    expected: c.f?.links.find((l) => l.milestone === m.id)?.expected ?? '',
  }));
  return {
    goal: {
      id: g.id,
      title: g.name,
      metric: g.metric?.title ?? null,
      target: num(g.target, g.unit),
      position: gi + 1,
    },
    milestone: served[0].milestone,
    served,
  };
}

/** After an edit, brings what changed into view. */
/** The ring's key: one chip, a feature under one goal. */
const ringOf = (feature: string, goal: string) => `${feature} ${goal}`;

/** #1748: the chip of the feature the panel shows: the clicked one, else one of the feature it moved to (none: no chip). */
function markOf(
  panel: Chip | null,
  shown: { id: string; code: string | null; title: string } | null,
  chips: Chip[],
  codes: Map<string, string>,
): string | null {
  if (!panel) return null;
  const is = (f: Chip) =>
    !shown ||
    f.id === shown.id ||
    (!!shown.code && codes.get(f.id)?.toLowerCase() === shown.code.toLowerCase());
  const hit = is(panel) ? panel : chips.find(is);
  return hit ? ringOf(hit.id, hit.goal) : null;
}

function reveal(sel: string, block: ScrollLogicalPosition = 'center') {
  setTimeout(() => document.querySelector(sel)?.scrollIntoView({ block, inline: 'nearest' }), 50);
}

/* ---------- Shared pieces ---------- */

interface Track {
  id: string | null;
  name: string;
  color: string;
}

interface Ctx {
  map: GoalMap;
  codes: Map<string, string>;
  /** gt-proposed: each feature whose Ground Truth feature is still to confirm (its confirm_feature_id), by id. */
  confirm: Map<string, string>;
  mcode: Map<string, string>;
  tracks: Track[];
  onOpen: (c: Chip) => void;
  /** #1748: the chip whose panel is open (its ringOf key), marked. */
  opened: string | null;
  menu: string | null;
  setMenu: (k: string | null) => void;
  setMover: (c: Chip | null) => void;
  renaming: string | null;
  setRenaming: (k: string | null) => void;
  /** The chip just moved (its ringOf key), ringed. */
  moved: string | null;
  act: ReturnType<typeof useActs>;
  onAttach: (milestone: string, track?: string | null) => void;
  /** Each PRD milestone's PRD: its menu opens it (never Trash). */
  prdOf: Map<string, NonNullable<Schemas['SimpleGoalMilestone']['prd']>>;
  go: (href: string) => void;
  /** Opens one of the goal map's own editors. */
  onEdit: (e: Edit) => void;
  /** Whether this person may start a PRD (New PRD from it). */
  canPrd: boolean;
  /** de-gm: whether this person may add, rename or move features here (applied or proposed, as the change engine decides). */
  canChange: boolean;
  /** de-gm: features typed in and not yet back from the API, shown at once in their cell. */
  ghosts: Ghost[];
  addHere: (title: string, goal: string, track: string | null) => void;
  /** de-gm: chips dragged to another cell, shown there before the API answers (by ringOf). */
  shifted: Map<string, { goal: string; track: string | null }>;
  dropOn: (key: string, goal: string, track: string | null) => void;
  /** prioritize: the goals in the order shown, reordered by their header. */
  goalDrag: ReturnType<typeof useGoalDrag>;
  /** prioritize: a cell's chips in the one feature order (Priorities' rank), moved in place. */
  order: ReturnType<typeof useFeatureOrder>;
}

interface Ghost {
  key: number;
  title: string;
  goal: string;
  track: string | null;
  /** Filed as a proposal: it waits for someone who decides. */
  proposed?: boolean;
}

const mWords = (m: M, c: { mcode: Map<string, string> }) =>
  `${c.mcode.get(m.id) ?? ''} ${m.name}`.trim();

/** A status badge; one that asks for something (No gate, Not measured) leads to the action that resolves it. */
function Status({
  s,
  on,
  small,
  hint,
}: {
  s: string;
  on?: () => void;
  small?: boolean;
  hint?: string;
}) {
  const [w, cls] = STATUS[s] ?? STATUS.not_measured;
  const look = `whitespace-nowrap rounded-full font-semibold ${small ? 'px-1.5 text-xs' : 'px-2 py-0.5 text-sm'} ${cls}`;
  if (!on) return <span className={look}>{w}</span>;
  return (
    <button
      type="button"
      title={hint}
      onClick={(e) => (e.stopPropagation(), on())}
      className={`${look} hover:brightness-95`}
    >
      {w}
    </button>
  );
}

function Bar({ g }: { g: GmGoal }) {
  const p = progress(g);
  const tone =
    g.status === 'at_risk'
      ? 'bg-warn'
      : g.status === 'missed'
        ? 'bg-crit'
        : g.status === 'met'
          ? 'bg-pass'
          : 'bg-accent';
  return (
    <span
      className="block h-1.5 w-full overflow-hidden rounded-full bg-surface2"
      role="img"
      aria-label={`${num(g.current, g.unit)} now, aiming at ${num(g.target, g.unit)}`}
    >
      <span
        className={`block h-full rounded-full ${tone}`}
        style={{ width: `${Math.max(4, p * 100)}%` }}
      />
    </span>
  );
}

function GoalInfo({ g, krs }: { g: GmGoal; krs: KrLine[] }) {
  return (
    <InfoTip label={g.name} testId={`gm-goal-info-${g.id}`}>
      <span className="flex flex-col gap-1">
        <b>Measured as {g.measure}</b>
        <span>
          {krs.length
            ? krs.map((k) => `${k.code ? `${k.code} ` : ''}${k.name}`).join(' · ')
            : g.math.replace(/^Key results: /, '')}
        </span>
        {g.read_on && <span>Read on {g.read_on}</span>}
      </span>
    </InfoTip>
  );
}

/** A ⋯ menu; Escape closes it and puts focus back on its ⋯; focus moving elsewhere (Tab past its last item) closes it
 * and leaves focus there. A blur to nowhere (a click Safari does not focus) keeps it open, so the click still lands. */
function Menu({
  k,
  label,
  items,
  c,
  pin,
}: {
  k: string;
  label: string;
  items: { w: string; on: () => void; crit?: boolean }[];
  c: Ctx;
  /** #1769: placed on the window under its ⋯, so the held goal row (a sideways scroll box) does not cut it. */
  pin?: boolean;
}) {
  const open = c.menu === k;
  const more = useRef<HTMLButtonElement>(null);
  const [at, setAt] = useState<CSSProperties | undefined>(undefined);
  return (
    <span
      className="relative inline-flex"
      onKeyDown={(e) => {
        if (!open || e.key !== 'Escape') return;
        e.stopPropagation();
        c.setMenu(null);
        more.current?.focus();
      }}
      onBlur={(e) => {
        if (open && e.relatedTarget instanceof Node && !e.currentTarget.contains(e.relatedTarget))
          c.setMenu(null);
      }}
    >
      <button
        ref={more}
        type="button"
        aria-label={`More for ${label}`}
        aria-expanded={open}
        data-testid={`gm-menu-${k}`}
        onClick={(e) => {
          e.stopPropagation();
          const r = e.currentTarget.getBoundingClientRect();
          if (pin)
            setAt({
              position: 'fixed',
              top: r.bottom,
              right: document.documentElement.clientWidth - r.right,
            });
          c.setMenu(open ? null : k);
        }}
        className={`rounded-md px-1 leading-none text-text2 hover:bg-surface2 ${open ? 'bg-surface2' : ''}`}
      >
        <Icon name="more" size={16} />
      </button>
      {open && (
        <span
          role="menu"
          style={pin ? at : undefined}
          className="absolute top-full right-0 z-30 mt-1 flex w-max min-w-[180px] flex-col rounded-xl border border-line bg-surface py-1 text-sm shadow-lg"
        >
          {items.map((it) => (
            <button
              key={it.w}
              type="button"
              role="menuitem"
              onClick={(e) => (e.stopPropagation(), c.setMenu(null), it.on())}
              className={`px-3 py-1.5 text-left hover:bg-surface2 ${it.crit ? 'text-crit' : ''}`}
            >
              {it.w}
            </button>
          ))}
        </span>
      )}
    </span>
  );
}

const featureMenuKey = (f: Chip) => `f-${f.goal}-${f.id}`;

function featureMenu(f: Chip, c: Ctx) {
  const name = `${c.codes.get(f.id) ?? ''} ${f.name}`.trim();
  return (
    <Menu
      k={featureMenuKey(f)}
      label={name}
      c={c}
      items={[
        { w: 'Open', on: () => c.onOpen(f) },
        ...(c.map.can_edit
          ? [
              { w: 'Move to…', on: () => c.setMover(f) },
              { w: 'Move to Trash', on: () => void c.act.trashFeature(f), crit: true },
            ]
          : []),
      ]}
    />
  );
}

function milestoneMenu(m: M, c: Ctx) {
  if (!m.can_change) return null;
  const prd = c.prdOf.get(m.id);
  const items = [
    { w: 'Rename', on: () => c.setRenaming(m.id) },
    { w: 'Add a feature', on: () => c.onAttach(m.id) },
    { w: 'Set the gate', on: () => c.onEdit({ kind: 'gate', milestone: m.id }) },
    ...(c.canPrd && !prd
      ? [{ w: 'New PRD from it', on: () => c.onEdit({ kind: 'prd', milestone: m.id }) }]
      : []),
    prd
      ? { w: `Open ${prd.title}`, on: () => c.go(`/simple/one-pagers/${prd.slug}`) }
      : { w: 'Move to Trash', on: () => void c.act.trashMilestone(m), crit: true },
  ];
  return <Menu k={`m-${m.id}`} label={mWords(m, c)} c={c} items={items} />;
}

function goalMenu(g: GmGoal, ms: M[], c: Ctx) {
  if (!c.map.can_edit) return null;
  const next = ms.find((m) => m.status !== 'met') ?? ms[0];
  const items = [
    // qa-nov17 G1: a goal with no measure, target or date is renamed in its Goal buckets form, which asks for them in the same step.
    {
      w: 'Rename',
      on: () =>
        void c.act
          .whole(g.id)
          .then((ok) =>
            ok
              ? c.setRenaming(g.id)
              : ok === false &&
                c.go(`/simple/priorities?tab=buckets&edit=${encodeURIComponent(g.id)}`),
          ),
    },
    ...(next ? [{ w: 'Add a feature', on: () => c.onAttach(next.id) }] : []),
    { w: 'Propose a milestone', on: () => c.onEdit({ kind: 'propose', goal: g.id }) },
    { w: 'Pick its metric', on: () => c.onEdit({ kind: 'metric', goal: g.id }) },
  ];
  return <Menu k={`g-${g.id}`} label={g.name} c={c} items={items} pin />;
}

/** What resolves a goal's badge: Not measured, its metric; No gate, its first milestone's gate. */
function goalFix(g: GmGoal, ms: M[], c: Ctx): { on: () => void; hint: string } | undefined {
  if (!c.map.can_edit) return undefined;
  if (g.status === 'not_measured')
    return { on: () => c.onEdit({ kind: 'metric', goal: g.id }), hint: 'Pick its metric' };
  const open = ms.find((m) => m.threshold === null && m.can_change);
  if (g.status === 'no_gate' && open)
    return { on: () => c.onEdit({ kind: 'gate', milestone: open.id }), hint: 'Set the gate' };
  return undefined;
}

function Rename({
  id,
  was,
  c,
  className,
}: {
  id: string;
  was: string;
  c: Ctx;
  className?: string;
}) {
  const [v, setV] = useState(was);
  const done = (save: boolean) => {
    c.setRenaming(null);
    if (save && v.trim() && v.trim() !== was) void c.act.rename(id, v.trim(), was);
  };
  return (
    <input
      autoFocus
      aria-label={`Rename ${was}`}
      data-testid="gm-rename"
      value={v}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => done(true)}
      onKeyDown={(e) => (e.key === 'Enter' ? done(true) : e.key === 'Escape' ? done(false) : null)}
      onClick={(e) => e.stopPropagation()}
      className={`min-w-0 rounded-md border border-accent bg-surface px-1.5 py-0.5 font-semibold outline-none ring-2 ring-accent/30 ${className ?? ''}`}
    />
  );
}

/** de-gm: a milestone's date; who may change it clicks it and picks another, saved at once with Undo (Esc keeps it). */
function MilestoneDay({ m, c }: { m: M; c: Ctx }) {
  const [open, setOpen] = useState(false);
  if (!m.can_change) return <span className="whitespace-nowrap text-text2">{day(m.due_on)}</span>;
  if (open)
    return (
      <input
        type="date"
        autoFocus
        aria-label={`Date of ${m.name}`}
        data-testid="gm-strip-date-input"
        defaultValue={m.due_on ?? ''}
        onKeyDown={(e) => {
          if (e.key === 'Escape') setOpen(false);
          else if (e.key === 'Enter') e.currentTarget.blur();
        }}
        onBlur={(e) => {
          setOpen(false);
          const to = e.currentTarget.value;
          if (to && to !== m.due_on) void c.act.redate(m, to);
        }}
        className="rounded-md border border-accent bg-surface px-1 text-xs outline-none"
      />
    );
  return (
    <Button
      variant="ghost"
      data-testid="gm-strip-date"
      className="h-auto! gap-0! rounded-none! p-0! text-xs! font-normal! hover:bg-transparent hover:underline"
      onClick={() => setOpen(true)}
    >
      {day(m.due_on) || '+'}
    </Button>
  );
}

/** #1771: a milestone with no number to reach (its gate). Plain words, and one that can be set looks like a button. */
function NoTarget({ m, c }: { m: M; c: Ctx }) {
  if (!m.can_change)
    return (
      <span className="rounded-full bg-na-bg px-1.5 text-xs font-semibold whitespace-nowrap text-na">
        No target
      </span>
    );
  return (
    <Button
      variant="ghost"
      data-testid="gm-strip-target"
      title="Set the number this milestone must reach"
      onClick={(e) => (e.stopPropagation(), c.onEdit({ kind: 'gate', milestone: m.id }))}
      className="h-auto! min-h-0! cursor-pointer gap-0! rounded-full! border! border-dashed! border-accent! px-1.5! py-0! text-xs! leading-[18px]! font-semibold! whitespace-nowrap text-accent-ink! hover:bg-accent-soft!"
    >
      + Target
    </Button>
  );
}

/** A feature's status mark; its ⋯ menu takes the same place on hover or focus, and while its menu is open.
 * The open menu is read from state, not CSS :has(): a :has() rule is global and made every style
 * recalculation on the 500-item Roadmap's drag ten times slower (dod-perf). */
function Slot({ f, c }: { f: Chip; c: Ctx }) {
  const s = fstate(f);
  const open = c.menu === featureMenuKey(f);
  return (
    <span className="flex w-6 shrink-0 justify-center max-[600px]:w-auto max-[600px]:gap-1">
      <span
        className={`${open ? 'hidden' : 'flex'} text-xs group-hover:hidden group-focus-within:hidden max-[600px]:flex! ${s.cls}`}
        title={s.w}
      >
        {s.mark || <span className="m-1 size-2 rounded-full border border-text-faint" />}
      </span>
      {/* A phone has no hover: its ⋯ stays beside the mark. */}
      <span
        className={`${open ? 'inline-flex' : 'hidden'} group-hover:inline-flex group-focus-within:inline-flex max-[600px]:inline-flex`}
      >
        {featureMenu(f, c)}
      </span>
    </span>
  );
}

function Legend({ tracks, guardrail }: { tracks: Track[]; guardrail: GoalMap['guardrail'] }) {
  return (
    <span className="flex flex-wrap items-center gap-1.5" data-testid="gm-legend">
      {tracks.map((t) => (
        <span key={t.id ?? 'none'} className="flex items-center gap-1.5 px-1 text-sm">
          <span className="size-2.5 rounded-full" style={{ background: t.color }} />
          {t.name}
        </span>
      ))}
      {/* #1770: what a chip's mark means. */}
      <span className="flex items-center gap-1.5 px-1 text-sm" data-testid="gm-legend-marks">
        <span className="flex items-center gap-1">
          <span className="text-xs text-pass">✓</span>Shipped
        </span>
        <span className="flex items-center gap-1">
          <span className="size-2 rounded-full border border-text-faint" />
          Planned
        </span>
      </span>
      {guardrail && <Guardrail g={guardrail} />}
    </span>
  );
}

/** The guardrail as the legend row's last item (the owner's "Fold into legend row"): its status, the rest on hover. */
function Guardrail({ g }: { g: NonNullable<GoalMap['guardrail']> }) {
  return (
    <InfoTip
      label="the guardrail"
      testId="gm-legend-guardrail"
      side="bottom"
      trigger={
        <span className="flex items-center gap-1 px-1 text-sm">
          <Icon name="lock" size={16} className={g.held ? 'text-pass' : 'text-crit'} />
          {g.held ? (
            'Guardrails: on track ✓'
          ) : (
            <>
              Guardrails: <span className="font-semibold text-crit">at risk</span>
            </>
          )}
        </span>
      }
    >
      <span className="flex flex-col gap-1">
        <b>
          {g.name} {g.rule}
        </b>
        <span>Held {g.days.filter((v) => v === 0).length} of 7 days</span>
        <span>
          Every milestone must hold it.{' '}
          {g.current === null ? 'Not measured today' : `${num(g.current, '')} today`}
        </span>
      </span>
    </InfoTip>
  );
}

/* ---------- The actions (the API's own routes, each with Undo) ---------- */

function useActs(
  map: GoalMap,
  setMap: (m: GoalMap) => void,
  reload: () => Promise<unknown>,
  codes: Map<string, string>,
  mcode: Map<string, string>,
  tracks: Track[],
  setMoved: (key: string | null) => void,
  top: (id: string | null) => string | null,
) {
  const named = (f: Chip) => `${codes.get(f.id) ?? ''} ${f.name}`.trim();
  const msWords = (id: string | null) => {
    const m = map.milestones.find((x) => x.id === id);
    return m ? mWords(m, { mcode }) : 'No milestone';
  };
  const failed = (e: unknown) => {
    toast({ message: e instanceof ChangeFailed ? e.message : errorMessage(e) });
  };
  const remove = useFeatureDelete(reload, toast);
  type Link = Pick<GmFeature['links'][number], 'milestone' | 'expected' | 'confidence'>;
  // A link put (back) on a milestone, with its own expected lift and confidence, filed under the
  // feature's own area, else the map's first.
  const attach = (f: Chip, l: Link) =>
    unwrap(
      api.POST('/v1/simple/goal-map/links', {
        body: {
          feature: f.id,
          milestone: l.milestone,
          area: f.f?.area ?? map.areas[0]?.id ?? '',
          expected: l.expected,
          confidence: l.confidence.toLowerCase() as 'high' | 'medium' | 'low',
        },
      }),
    );
  const detach = (f: Chip, milestone: string) =>
    unwrap(api.POST('/v1/simple/goal-map/links/detach', { body: { feature: f.id, milestone } }));
  const linkOf = (f: Chip, milestone: string): Link =>
    f.f?.links.find((l) => l.milestone === milestone) ?? {
      milestone,
      expected: '',
      confidence: 'Medium',
    };
  /** Each in turn; the map as the last one left it. */
  const each = async <T,>(xs: T[], one: (x: T) => Promise<GoalMap>): Promise<GoalMap | null> => {
    let next: GoalMap | null = null;
    for (const x of xs) next = await one(x);
    return next;
  };
  /**
   * Moves the links of a chip's own goal; its Undo puts each back as it was. To a milestone: the
   * first moves there and the rest of that goal let go; No milestone: every one of them lets go.
   */
  const moveRaw = async (
    f: Chip,
    to: string | null,
  ): Promise<{ next: GoalMap | null; back: () => Promise<GoalMap | null> }> => {
    const [first, ...rest] = f.ms.map((m) => linkOf(f, m.id));
    if (!to) {
      if (!first) return { next: null, back: async () => null };
      const links = [first, ...rest];
      return {
        next: await each(links, (l) => detach(f, l.milestone)),
        back: () => each(links, (l) => attach(f, l)),
      };
    }
    if (!first)
      return {
        next: await attach(f, { milestone: to, expected: '', confidence: 'Medium' }),
        back: () => detach(f, to),
      };
    const moved = await unwrap(
      api.POST('/v1/simple/goal-map/links/move', {
        body: { feature: f.id, from_milestone: first.milestone, to_milestone: to },
      }),
    );
    const next = (await each(rest, (l) => detach(f, l.milestone))) ?? moved;
    return {
      next,
      back: async () => {
        const was = await unwrap(
          api.POST('/v1/simple/goal-map/links/move', {
            body: { feature: f.id, from_milestone: to, to_milestone: first.milestone },
          }),
        );
        return (await each(rest, (l) => attach(f, l))) ?? was;
      },
    };
  };
  /** A move's toast, with its Undo and what that Undo says once done. */
  const told = (message: string, back: () => Promise<GoalMap | null>, backWords: string) =>
    toast({
      message,
      action: {
        label: 'Undo',
        onClick: () =>
          void back().then((m) => {
            if (m) setMap(m);
            toast({ message: backWords });
          }, failed),
      },
    });
  /** A milestone's name, with its goal's when that is not the goal named. */
  const where = (id: string, goal: string | null) => {
    const g = map.goals.find((x) => x.id === map.milestones.find((m) => m.id === id)?.goal);
    return `${msWords(id)}${g && g.id !== goal ? ` (${g.name})` : ''}`;
  };
  /** A change through the change engine: applied (with Undo), else what it waits for. */
  const change = async (r: ChangeResult, words: string, back: string) => {
    await reload();
    if (r.change.status !== 'applied') return toast({ message: resultWords(r, words) });
    toast({
      message: words,
      action: {
        label: 'Undo',
        onClick: () =>
          void undo(r.change.id)
            .then(reload)
            .then(() => toast({ message: back }), failed),
      },
    });
  };
  return {
    move: async (f: Chip, to: string | null) => {
      try {
        const { next, back } = await moveRaw(f, to);
        if (!next) return;
        setMap(next);
        const was = f.ms.length ? f.ms.map((m) => msWords(m.id)).join(' and ') : msWords(null);
        // No milestone puts a feature with no other link under its own goal, which may not be this chip's.
        const toGoal = to
          ? (map.milestones.find((m) => m.id === to)?.goal ?? f.goal)
          : (top(next.unplaced.find((u) => u.id === f.id)?.goal ?? null) ?? f.goal);
        const lands = toGoal !== f.goal ? map.goals.find((g) => g.id === toGoal)?.name : undefined;
        setMoved(ringOf(f.id, toGoal));
        reveal(`[data-testid="gm-chip"][data-feature="${f.id}"][data-goal="${toGoal}"]`);
        // No milestone on one goal's links while others stay: it says which stay.
        const stays = to
          ? []
          : (f.f?.milestones ?? []).filter((id) => !f.ms.some((m) => m.id === id));
        const message = stays.length
          ? `Took ${named(f)} off ${was}; it stays on ${stays.map((id) => where(id, f.goal)).join(' and ')}`
          : `Moved ${named(f)}${f.ms.length && to ? ` from ${was}` : ''} to ${to ? where(to, f.goal) : `${msWords(null)}${lands ? ` (${lands})` : ''}`}`;
        told(message, back, `Moved ${named(f)} back to ${was}`);
      } catch (e) {
        failed(e);
      }
    },
    /** Add a feature: a new link on a milestone, or (Move here) its link moved from another milestone of that goal. */
    add: async (
      feature: string,
      name: string,
      milestone: string,
      expected: string,
      from: string | null,
    ): Promise<boolean> => {
      const f: Chip = {
        id: feature,
        name,
        f: map.features.find((x) => x.id === feature) ?? null,
        m: null,
        ms: [],
        goal: '',
        track: null,
        done: false,
        lift: 'not_measured',
      };
      try {
        const next = from
          ? await unwrap(
              api.POST('/v1/simple/goal-map/links/move', {
                body: { feature, from_milestone: from, to_milestone: milestone },
              }),
            )
          : await attach(f, { milestone, expected, confidence: 'Medium' });
        setMap(next);
        const goal = map.milestones.find((m) => m.id === milestone)?.goal ?? '';
        setMoved(ringOf(feature, goal));
        reveal(`[data-testid="gm-chip"][data-feature="${feature}"][data-goal="${goal}"]`);
        if (from)
          told(
            `Moved ${named(f)} from ${msWords(from)} to ${msWords(milestone)}`,
            () =>
              unwrap(
                api.POST('/v1/simple/goal-map/links/move', {
                  body: { feature, from_milestone: milestone, to_milestone: from },
                }),
              ),
            `Moved ${named(f)} back to ${msWords(from)}`,
          );
        else
          told(
            `Added ${named(f)} to ${msWords(milestone)}`,
            () => detach(f, milestone),
            `Took ${named(f)} off ${msWords(milestone)}`,
          );
        return true;
      } catch (e) {
        failed(e);
        return false;
      }
    },
    track: async (f: Chip, to: string | null) => {
      const name = (id: string | null) => tracks.find((t) => t.id === id)?.name ?? 'No track';
      try {
        const r = await propose({
          op: 'set_track',
          target: { item_id: f.id },
          before: { track_id: f.track },
          after: { track_id: to },
        });
        setMoved(ringOf(f.id, f.goal));
        await change(
          r,
          `Moved ${named(f)} to ${name(to)}`,
          `Moved ${named(f)} back to ${name(f.track)}`,
        );
      } catch (e) {
        failed(e);
      }
    },
    /** Whether a goal's bucket has its measure, target and date, so a rename alone saves; null when it cannot be read. */
    whole: async (id: string): Promise<boolean | null> => {
      try {
        const b = (await unwrap(api.GET('/v1/simple/goal-buckets'))).goals.find((x) => x.id === id);
        return !b || (!!b.measure && !!b.target && !!b.due);
      } catch (e) {
        failed(e);
        return null;
      }
    },
    rename: async (id: string, name: string, was: string) => {
      const m = map.milestones.find((x) => x.id === id);
      // de-gm: a feature's chip renames it through the change engine (proposed for who may only propose).
      if (!m && !map.goals.some((g) => g.id === id)) {
        // The new name shows at once; a refusal reads the map again, so the old one comes back.
        setMap({
          ...map,
          features: map.features.map((x) => (x.id === id ? { ...x, name } : x)),
          unplaced: map.unplaced.map((x) => (x.id === id ? { ...x, name } : x)),
        });
        try {
          const r = await propose({
            op: 'edit_title',
            target: { item_id: id },
            before: { title: was },
            after: { title: name },
          });
          await change(r, `Renamed ${was} to ${name}`, `Renamed ${name} back to ${was}`);
        } catch (e) {
          failed(e);
          await reload();
        }
        return;
      }
      // A goal's name through its goal bucket, its measure, target and date as they are.
      const goalTo = async (title: string, seen: string) => {
        const b = (await unwrap(api.GET('/v1/simple/goal-buckets'))).goals.find((x) => x.id === id);
        if (!b) throw new Error(`${seen} is not a goal you can rename here`);
        return unwrap(
          api.PATCH('/v1/simple/goal-buckets/goals/{goal_id}', {
            params: { path: { goal_id: id } },
            body: {
              title,
              measure: b.measure ?? '',
              target: b.target ?? '',
              due: b.due ?? '',
              seen: {
                title: seen,
                measure: b.measure ?? null,
                target: b.target ?? null,
                due: b.due ?? null,
              },
            },
          }),
        );
      };
      const msTo = (n: string) =>
        unwrap(
          api.PATCH('/v1/simple/roadmap/milestones/{milestone_id}', {
            params: { path: { milestone_id: id } },
            body: { name: n },
          }),
        );
      try {
        if (m) await msTo(name);
        else await goalTo(name, was);
        await reload();
        toast({
          message: `Renamed ${was} to ${name}`,
          action: {
            label: 'Undo',
            onClick: () => void (m ? msTo(was) : goalTo(was, name)).then(reload, failed),
          },
        });
      } catch (e) {
        failed(e);
      }
    },
    /** de-gm: a feature typed into a cell: it serves that goal (on its next open milestone) on that track, with its code. */
    create: async (title: string, goal: string, track: string | null, roadmap?: string) => {
      try {
        const r = await propose({
          op: 'add_item',
          target: { roadmap_id: roadmap ?? null, where: { kind: 'goal', value: goal } },
          before: {},
          after: track ? { title, track_id: track } : { title },
        });
        const id = r.change.target.item_id;
        if (r.change.status !== 'applied' || typeof id !== 'string') {
          toast({ message: resultWords(r, `Added ${title}`) });
          return 'proposed' as const;
        }
        const ms = map.milestones.filter((m) => m.goal === goal).sort(byDate);
        const m = ms.find((x) => x.status !== 'met') ?? ms[0];
        if (m)
          await attach(
            {
              id,
              name: title,
              f: null,
              m: null,
              ms: [],
              goal,
              track,
              done: false,
              lift: 'not_measured',
            },
            { milestone: m.id, expected: '', confidence: 'Medium' },
          );
        // Its track as the roadmap reads it, then the cell's.
        const now = await unwrap(api.GET('/v1/simple/roadmap', { params: { query: {} } }));
        const had = now.items.find((i) => i.id === id)?.track?.id ?? null;
        if (had !== track)
          await propose({
            op: 'set_track',
            target: { item_id: id },
            before: { track_id: had },
            after: { track_id: track },
          });
        await reload();
        setMoved(ringOf(id, goal));
        toast({
          message: `Added ${title}`,
          action: r.change.can_undo
            ? {
                label: 'Undo',
                onClick: () =>
                  void undo(r.change.id)
                    .then(reload)
                    .then(() => toast({ message: `Took back ${title}` }), failed),
              }
            : undefined,
        });
        return 'applied' as const;
      } catch (e) {
        failed(e);
        await reload();
        return 'failed' as const;
      }
    },
    // de-gm: Move to Trash at once (its chip hidden before the call returns), with Undo in the note.
    trashFeature: (f: Chip) => remove({ id: f.id, title: named(f), now: true }),
    /** de-gm: a milestone's date in one step, the strip showing it at once, with Undo. */
    redate: async (m: M, to: string) => {
      const patch = (date: string | null) =>
        unwrap(
          api.PATCH('/v1/simple/roadmap/milestones/{milestone_id}', {
            params: { path: { milestone_id: m.id } },
            body: { date },
          }),
        );
      setMap({
        ...map,
        milestones: map.milestones.map((x) => (x.id === m.id ? { ...x, due_on: to } : x)),
      });
      try {
        await patch(to);
        await reload();
        toast({
          message: `Moved ${mWords(m, { mcode })} to ${day(to)}`,
          action: {
            label: 'Undo',
            onClick: () => void patch(m.due_on ?? null).then(reload, failed),
          },
        });
      } catch (e) {
        failed(e);
        await reload();
      }
    },
    trashMilestone: async (m: M) => {
      try {
        await unwrap(
          api.DELETE('/v1/simple/roadmap/milestones/{milestone_id}', {
            params: { path: { milestone_id: m.id } },
          }),
        );
        await reload();
        toast({
          message: `Moved ${mWords(m, { mcode })} to Trash`,
          action: {
            label: 'Undo',
            onClick: () =>
              void unwrap(
                api.POST('/v1/simple/roadmap/milestones/{milestone_id}/restore', {
                  params: { path: { milestone_id: m.id } },
                }),
              ).then(reload, failed),
          },
        });
      } catch (e) {
        failed(e);
      }
    },
  };
}

/** Move to…: every goal's milestones by date, its own goal's No milestone, and the tracks; it moves the links of the chip's own goal. */
function MovePicker({ f, c, onClose }: { f: Chip; c: Ctx; onClose: () => void }) {
  const pick = (to: string | null) => {
    onClose();
    void c.act.move(f, to);
  };
  const row =
    'flex items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-accent-soft disabled:opacity-60 disabled:hover:bg-transparent';
  const head = 'px-2 pt-1 text-xs font-semibold tracking-wide text-text2 uppercase';
  return (
    <div
      className="fixed inset-0 z-40 flex items-start justify-center bg-black/20 pt-[10vh] max-[600px]:items-end max-[600px]:pt-0"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-label={`Move ${c.codes.get(f.id) ?? ''} ${f.name}`}
        data-testid="gm-mover"
        onClick={(e) => e.stopPropagation()}
        className="simple-card w-[720px] max-w-full gap-2 max-[600px]:rounded-b-none"
      >
        <div className="flex items-center gap-2">
          <h2 className="min-w-0 flex-1 truncate text-lg font-semibold">
            Move{' '}
            {c.codes.get(f.id) && <span className="text-text-faint">{c.codes.get(f.id)} </span>}
            {f.name}
          </h2>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="rounded-full p-1 hover:bg-surface2"
          >
            <Icon name="x" />
          </button>
        </div>
        <div className="grid max-h-[70vh] grid-cols-2 gap-x-4 gap-y-2 overflow-y-auto max-[600px]:grid-cols-1">
          {c.map.goals.map((g) => {
            const own = g.id === f.goal;
            return (
              <div key={g.id} className="flex flex-col">
                <span className={head}>{g.name}</span>
                {[
                  ...c.map.milestones.filter((m) => m.goal === g.id).sort(byDate),
                  ...(own ? [null] : []),
                ].map((m) => {
                  // Here now: a milestone it is on, of any goal (its chip there is that goal's).
                  const here = m ? (f.f?.milestones.includes(m.id) ?? false) : own && !f.m;
                  return (
                    <button
                      key={m?.id ?? 'none'}
                      type="button"
                      disabled={here}
                      data-to={m?.id ?? 'none'}
                      onClick={() => pick(m?.id ?? null)}
                      className={row}
                    >
                      {m ? (
                        <>
                          <span className="font-semibold text-accent-ink">{c.mcode.get(m.id)}</span>
                          <span className="flex-1 truncate" title={m.name}>
                            {m.name}
                          </span>
                          <span className="text-xs text-text2">{day(m.due_on)}</span>
                        </>
                      ) : (
                        <span className="flex-1">No milestone</span>
                      )}
                      {here && <span className="text-xs text-text2">✓ Here now</span>}
                    </button>
                  );
                })}
              </div>
            );
          })}
          <div className="flex flex-col" data-testid="gm-mover-tracks">
            <span className={head}>Tracks</span>
            {c.tracks.map((t) => {
              const here = t.id === f.track;
              return (
                <button
                  key={t.id ?? 'none'}
                  type="button"
                  disabled={here}
                  data-to-track={t.id ?? 'none'}
                  onClick={() => {
                    onClose();
                    void c.act.track(f, t.id);
                  }}
                  className={row}
                >
                  <span
                    className="size-2.5 shrink-0 rounded-full"
                    style={{ background: t.color }}
                  />
                  <span className="flex-1 truncate">{t.name}</span>
                  {here && <span className="text-xs text-text2">✓ Here now</span>}
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---------- The grid ---------- */

/** The grid's columns: the track names, then one per goal (the goal row and the rest share them). */
const GRID =
  'grid min-w-[1000px] grid-cols-[150px_repeat(var(--gm-n),minmax(0,1fr))] gap-x-3 max-[600px]:grid-cols-[96px_repeat(var(--gm-n),220px)]';

function TracksGrid({ chips, lines, c }: { chips: Chip[]; lines: Map<string, KrLine[]>; c: Ctx }) {
  const goals = c.goalDrag.shown
    .map((id) => c.map.goals.find((g) => g.id === id))
    .filter((g): g is GmGoal => !!g);
  const all = [...c.map.milestones].sort(byDate);
  const order = new Map(all.map((m, i) => [m.id, i]));
  // A cell's chips in milestone order (No milestone last), so a moved chip lands in its place.
  const inOrder = (xs: Chip[]) =>
    [...xs].sort(
      (a, b) => (a.m ? order.get(a.m.id)! : all.length) - (b.m ? order.get(b.m.id)! : all.length),
    );
  const n = goals.length;
  // de-gm: a chip dragged to another cell sits there at once, before the API answers.
  const at = (f: Chip) => c.shifted.get(ringOf(f.id, f.goal)) ?? f;
  const clickAt = useRef<number | undefined>(undefined);
  // prioritize: a cell's chips in rank order (unranked after, in milestone order), a move in flight first.
  const cellIds = (goal: string, track: string | null) =>
    c.order.sorted(inOrder(inCell(goal, track)).map((f) => f.id));
  const cellOrder = (goal: string, track: string | null) =>
    c.order
      .arrange(`${goal}:${track}`, cellIds(goal, track))
      .map((id) => inCell(goal, track).find((f) => f.id === id)!);
  const inCell = (goal: string, track: string | null) =>
    chips.filter((f) => at(f).goal === goal && at(f).track === track);
  const wrap = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const grid = useRef<HTMLDivElement>(null);
  // The goal row's own sideways scroll (no bar) and the grid's move as one, either way.
  const follow = (to: HTMLDivElement | null, x: number) => {
    if (to && to.scrollLeft !== x) to.scrollLeft = x;
  };
  useEffect(() => {
    const [w, b, g] = [wrap.current, box.current, grid.current];
    if (!w || !b || !g) return;
    const ro = new ResizeObserver(() => {
      w.style.setProperty('--gm-head-h', `${b.offsetHeight}px`);
      follow(b, g.scrollLeft);
    });
    ro.observe(b);
    ro.observe(g);
    return () => ro.disconnect();
  }, []);
  return (
    // #1769: the goal row holds at the top at every width. It sits outside the sideways scroll box (a sticky row
    // needs no scrolling box between it and the page) and follows that box's scroll; focus stops clear of it.
    <div ref={wrap} className="@container" style={{ '--gm-n': n } as CSSProperties}>
      <div
        ref={box}
        data-testid="gm-head-box"
        onScroll={(e) => follow(grid.current, e.currentTarget.scrollLeft)}
        className="sticky top-0 z-20 overflow-x-auto overflow-y-hidden bg-bg [scrollbar-width:none] max-[600px]:top-(--phone-top-bar)"
      >
        <div data-testid="gm-head" className={`${GRID} pb-px`}>
          {/* The corner: on a phone it holds still with the track names, so the goal cards pass under it. */}
          <span
            data-testid="gm-corner"
            className="max-[600px]:sticky max-[600px]:left-0 max-[600px]:z-10 max-[600px]:bg-bg"
          />
          {goals.map((g) => (
            <div
              key={g.id}
              data-goal={g.id}
              data-testid="gm-goal"
              {...c.goalDrag.target(g.id)}
              className="group flex flex-col gap-1 rounded-2xl border border-line bg-surface p-3"
            >
              {/* One row when it fits; else the target wraps beside the (i) and ⋯ (floated top right, so never pushed
                out) and the status moves under it, still on the right. Lines as tall as the target's glyphs, so a
                status under it never meets them; -3px so the row takes the room it did. */}
              <div className="-my-[3px] flow-root">
                <span className="float-right ml-1 flex h-[30px] items-center gap-1">
                  <GoalInfo g={g} krs={lines.get(g.id) ?? []} />
                  {goalMenu(
                    g,
                    all.filter((m) => m.goal === g.id),
                    c,
                  )}
                </span>
                <span className="text-xl leading-[30px] font-bold">{num(g.target, g.unit)}</span>
                <span className="float-right ml-2 flex h-[30px] items-center">
                  <Status
                    s={g.status}
                    {...goalFix(
                      g,
                      all.filter((m) => m.goal === g.id),
                      c,
                    )}
                  />
                </span>
              </div>
              {c.renaming === g.id ? (
                <Rename id={g.id} was={g.name} c={c} className="text-base" />
              ) : (
                <span
                  {...c.goalDrag.handle(g.id, g.name)}
                  className="line-clamp-2 min-h-[2.5em] text-base leading-[1.25] font-semibold"
                  title={g.name}
                >
                  {g.name}
                </span>
              )}
              <Bar g={g} />
            </div>
          ))}
        </div>
      </div>
      <div
        ref={grid}
        data-testid="gm-grid"
        onScroll={(e) => follow(box.current, e.currentTarget.scrollLeft)}
        className="relative flex flex-col overflow-x-auto @min-[1000px]:overflow-x-visible [&_*]:scroll-mt-[calc(var(--gm-head-h,0px)+8px)]"
      >
        <div className={GRID}>
          <span className="pt-2 text-xs font-semibold text-text2 uppercase max-[600px]:sticky max-[600px]:left-0 max-[600px]:z-10 max-[600px]:bg-bg">
            Milestones
          </span>
          {/* The milestone strip: by date across the goals, each under the goal it measures. */}
          <div
            className="col-span-(--gm-n) grid grid-cols-[repeat(var(--gm-n),minmax(0,1fr))] gap-x-3 pt-2 max-[600px]:grid-cols-[repeat(var(--gm-n),220px)]"
            data-testid="gm-strip"
          >
            {goals.map((g) => (
              <div
                key={g.id}
                className="flex flex-wrap content-start items-start gap-1 border-t-4 pt-1.5"
                style={{ borderColor: 'var(--accent-mid)' }}
              >
                {all
                  .filter((m) => m.goal === g.id)
                  .map((m) => (
                    <span
                      key={m.id}
                      data-milestone={m.id}
                      data-testid="gm-strip-milestone"
                      className="group flex max-w-full items-center gap-1 rounded-md bg-surface2 px-1.5 py-0.5 text-xs"
                    >
                      <b className="text-accent-ink">{c.mcode.get(m.id)}</b>
                      {c.renaming === m.id ? (
                        <Rename id={m.id} was={m.name} c={c} className="text-xs" />
                      ) : (
                        <span
                          className="line-clamp-2 min-w-0 break-words"
                          title={m.name}
                          data-testid="gm-strip-name"
                          onDoubleClick={() => m.can_change && c.setRenaming(m.id)}
                        >
                          {m.name}
                        </span>
                      )}
                      <MilestoneDay m={m} c={c} />
                      {m.threshold === null && <NoTarget m={m} c={c} />}
                      {/* Out of sight at rest, not display:none, so Tab reaches it; it shows on hover or focus as a chip's ⋯. */}
                      <span
                        className={`${c.menu === `m-${m.id}` ? 'inline-flex' : 'sr-only'} group-hover:not-sr-only group-hover:inline-flex group-focus-within:not-sr-only group-focus-within:inline-flex max-[600px]:not-sr-only max-[600px]:inline-flex`}
                      >
                        {milestoneMenu(m, c)}
                      </span>
                    </span>
                  ))}
              </div>
            ))}
          </div>
          {c.tracks.map((t) => (
            <div key={t.id ?? 'none'} className="contents">
              <span
                className="flex items-start gap-1.5 border-t border-line pt-2 text-sm leading-[18px] font-semibold max-[600px]:sticky max-[600px]:left-0 max-[600px]:z-10 max-[600px]:bg-bg"
                data-testid="gm-track"
                data-track={t.id ?? 'none'}
              >
                <span
                  className="mt-1 size-2.5 shrink-0 rounded-full"
                  style={{ background: t.color }}
                />
                {t.name}
              </span>
              {goals.map((g) => (
                <ul
                  key={g.id}
                  className="group flex min-h-10 flex-col gap-1 border-t border-line py-1.5"
                  data-testid="gm-cell"
                  data-track={t.id ?? 'none'}
                  data-goal={g.id}
                  onDragOver={(e) => {
                    if (c.canChange && e.dataTransfer.types.includes('text/x-gm-chip'))
                      e.preventDefault();
                  }}
                  onDrop={(e) => {
                    const key = e.dataTransfer.getData('text/x-gm-chip');
                    if (!key) return;
                    e.preventDefault();
                    c.dropOn(key, g.id, t.id);
                  }}
                >
                  {/* simple-goals: an empty cell adds a feature of its track to its goal's first milestone (out of sight at rest, as a chip's ⋯). */}
                  {c.map.can_edit &&
                    !chips.some((f) => f.goal === g.id && f.track === t.id) &&
                    all.some((m) => m.goal === g.id) && (
                      <li className="sr-only group-hover:not-sr-only group-focus-within:not-sr-only max-[600px]:not-sr-only">
                        <button
                          type="button"
                          data-testid="gm-cell-add"
                          className="text-sm font-semibold text-accent-ink hover:underline"
                          onClick={() => c.onAttach(all.find((m) => m.goal === g.id)!.id, t.id)}
                        >
                          + Add a feature
                        </button>
                      </li>
                    )}
                  {cellOrder(g.id, t.id).map((f) => (
                    <li
                      key={f.id}
                      data-testid="gm-chip"
                      data-feature={f.id}
                      data-goal={g.id}
                      data-track={t.id ?? 'none'}
                      data-moved={c.moved === ringOf(f.id, g.id) ? '1' : undefined}
                      aria-current={c.opened === ringOf(f.id, g.id) ? 'true' : undefined}
                      draggable={c.canChange && c.renaming !== ringOf(f.id, f.goal)}
                      onDragStart={(e) => {
                        e.dataTransfer.setData('text/x-gm-chip', ringOf(f.id, f.goal));
                        e.dataTransfer.effectAllowed = 'move';
                      }}
                      onDrop={(e) => {
                        // prioritize: dropped on another chip of its own cell, it takes that chip's place.
                        const from = cellIds(g.id, t.id).find(
                          (id) => ringOf(id, g.id) === e.dataTransfer.getData('text/x-gm-chip'),
                        );
                        if (!from || from === f.id) return;
                        e.preventDefault();
                        e.stopPropagation();
                        void c.order.move(`${g.id}:${t.id}`, cellIds(g.id, t.id), from, f.id);
                      }}
                      className={`group flex items-center gap-1 rounded-lg border px-2 py-0.5 text-sm leading-[17px] ${c.moved === ringOf(f.id, g.id) ? 'border-accent bg-surface ring-2 ring-accent' : c.opened === ringOf(f.id, g.id) ? 'border-accent bg-accent-soft ring-1 ring-accent' : 'border-line bg-surface'}`}
                      style={{ borderLeft: `3px solid ${t.color}` }}
                    >
                      {c.renaming === ringOf(f.id, f.goal) && (
                        <Rename id={f.id} was={f.name} c={c} className="flex-1 text-sm" />
                      )}
                      <button
                        type="button"
                        onClick={() => {
                          // A double-click renames, so the panel waits a beat for a second click.
                          window.clearTimeout(clickAt.current);
                          clickAt.current = window.setTimeout(
                            () => c.onOpen(f),
                            c.canChange ? 220 : 0,
                          );
                        }}
                        onDoubleClick={() => {
                          window.clearTimeout(clickAt.current);
                          if (c.canChange) c.setRenaming(ringOf(f.id, f.goal));
                        }}
                        onKeyDown={(e) => {
                          c.order.keys(`${g.id}:${t.id}`, cellIds(g.id, t.id), f.id)(e);
                          if (e.key === 'F2' && c.canChange) {
                            e.preventDefault();
                            c.setRenaming(ringOf(f.id, f.goal));
                          } else if (
                            (e.key === 'Delete' || e.key === 'Backspace') &&
                            c.map.can_edit
                          ) {
                            e.preventDefault();
                            void c.act.trashFeature(f);
                          }
                        }}
                        className={`min-w-0 flex-1 text-left ${c.renaming === ringOf(f.id, f.goal) ? 'hidden' : ''}`}
                      >
                        <span
                          data-testid="gm-chip-name"
                          className="line-clamp-2 break-words hover:underline"
                          title={`${c.codes.get(f.id) ?? ''} ${f.name}`.trim()}
                        >
                          <FeatureName
                            item={{
                              code: c.codes.get(f.id),
                              title: f.name,
                              confirm_feature_id: c.confirm.get(f.id),
                            }}
                          />
                          {c.order.pending(f.id) && <PendingMark />}
                        </span>
                        {/* The milestones' codes and names, as people named them (a list, not prose); #1770: No milestone
                          is for a screen reader only, not a line on nearly every chip. */}
                        <span
                          data-user-content
                          data-testid="gm-chip-ms"
                          className={`${f.ms.length ? 'line-clamp-2' : 'sr-only'} text-xs text-text2 [overflow-wrap:anywhere]`}
                          title={
                            f.ms.length ? f.ms.map((m) => mWords(m, c)).join(' · ') : undefined
                          }
                        >
                          {f.ms.length ? f.ms.map((m) => mWords(m, c)).join(' · ') : 'No milestone'}
                        </span>
                      </button>
                      <Slot f={f} c={c} />
                    </li>
                  ))}
                  {c.ghosts
                    .filter((x) => x.goal === g.id && x.track === t.id)
                    .map((x) => (
                      <li
                        key={x.key}
                        data-testid="gm-chip-pending"
                        data-proposed={x.proposed ? '1' : undefined}
                        aria-busy={!x.proposed}
                        className="flex items-center gap-1 rounded-lg border border-dashed border-line bg-surface px-2 py-0.5 text-sm leading-[17px] opacity-60"
                        style={{ borderLeft: `3px solid ${t.color}` }}
                      >
                        <span className="min-w-0 flex-1 truncate">{x.title}</span>
                        {x.proposed && (
                          <span className="text-xs text-text2" title="Waiting for a decision">
                            ◷
                          </span>
                        )}
                      </li>
                    ))}
                  {c.canChange && <CellAdd goal={g.id} track={t.id} c={c} />}
                </ul>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/** de-gm: a cell's faint + Add (out of sight at rest, as a chip's ⋯): type, Enter adds a feature there and keeps the
 * field for the next; Esc or leaving it empty closes it. */
function CellAdd({ goal, track, c }: { goal: string; track: string | null; c: Ctx }) {
  const [open, setOpen] = useState(false);
  const [v, setV] = useState('');
  if (!open)
    return (
      <li className="sr-only group-hover:not-sr-only group-focus-within:not-sr-only max-[600px]:not-sr-only">
        <Button
          variant="ghost"
          data-testid="gm-cell-new"
          className="h-6 justify-start px-1"
          onClick={() => setOpen(true)}
        >
          + Add
        </Button>
      </li>
    );
  return (
    <li>
      <input
        autoFocus
        aria-label="Add a feature"
        data-testid="gm-cell-input"
        value={v}
        onChange={(e) => setV(e.target.value)}
        onBlur={() => {
          if (!v.trim()) setOpen(false);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            setV('');
            setOpen(false);
          } else if (e.key === 'Enter' && v.trim()) {
            c.addHere(v.trim(), goal, track);
            setV('');
          }
        }}
        className="w-full min-w-0 rounded-md border border-accent bg-surface px-1.5 py-0.5 text-sm outline-none ring-2 ring-accent/30"
      />
    </li>
  );
}

/* ---------- Add a feature ---------- */

/**
 * A feature already on another milestone of the same goal is offered as a move from there (never a
 * second link the grid would not show); one already on this milestone is left out.
 */
function AttachDrawer({
  map,
  milestone,
  track,
  codes,
  mcode,
  onClose,
  onSave,
}: {
  map: GoalMap;
  milestone: string;
  track?: string | null;
  codes: Map<string, string>;
  mcode: Map<string, string>;
  onClose: () => void;
  onSave: (feature: string, milestone: string, expected: string, from: string | null) => void;
}) {
  const roadmap = useQuery('simple-roadmap:goal-map', () =>
    unwrap(api.GET('/v1/simple/roadmap', { params: { query: {} } })),
  );
  const [m, setM] = useState(milestone);
  const [search, setSearch] = useState('');
  const [feature, setFeature] = useState('');
  const [expected, setExpected] = useState('');
  const label = 'flex flex-col gap-1.5 font-semibold';
  const field = 'w-full rounded-xl border border-line-strong bg-surface px-3 py-2 text-lg';
  const on = new Map(map.features.map((f) => [f.id, f]));
  const term = search.toLowerCase();
  const goal = map.milestones.find((x) => x.id === m)?.goal;
  const sameGoal = (id: string) =>
    [...map.milestones]
      .sort(byDate)
      .find((x) => x.id !== m && x.goal === goal && on.get(id)?.milestones.includes(x.id)) ?? null;
  const named = (roadmap.data?.items ?? []).map((i) => ({
    id: i.id,
    code: codes.get(i.id) ?? i.code ?? '',
    name: on.get(i.id)?.name ?? i.title,
    from: sameGoal(i.id),
  }));
  // From an empty cell: its track's features only.
  const ofTrack = new Set(
    (roadmap.data?.items ?? []).filter((i) => !track || i.track?.id === track).map((i) => i.id),
  );
  const list = named.filter(
    (i) =>
      ofTrack.has(i.id) &&
      !on.get(i.id)?.milestones.includes(m) &&
      (!term || `${i.code} ${i.name}`.toLowerCase().includes(term)),
  );
  const from = list.find((i) => i.id === feature)?.from ?? null;
  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-black/20 max-[600px]:items-end">
      <div
        role="dialog"
        aria-label="Add a feature"
        data-testid="gm-editor"
        className="simple-card m-3 w-[460px] max-w-[calc(100vw-24px)] overflow-y-auto max-[600px]:m-0 max-[600px]:max-h-[85vh] max-[600px]:w-full max-[600px]:max-w-full max-[600px]:rounded-b-none"
      >
        <div className="flex items-center justify-between gap-2">
          <h2 className="simple-h2">Add a feature</h2>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="rounded-full p-1 hover:bg-surface2"
          >
            <Icon name="x" />
          </button>
        </div>
        <label className={label}>
          Milestone
          <select className={field} value={m} onChange={(e) => setM(e.target.value)}>
            {[...map.milestones].sort(byDate).map((x) => (
              <option key={x.id} value={x.id}>
                {mWords(x, { mcode })}
              </option>
            ))}
          </select>
        </label>
        <label className={label}>
          Feature
          <input
            className={field}
            value={search}
            placeholder="Search the roadmap"
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
        <ul className="flex max-h-72 flex-col gap-1.5 overflow-y-auto" data-testid="gm-attach-list">
          {!roadmap.data && (
            <li className="simple-small">
              {roadmap.error ? errorMessage(roadmap.error) : 'Loading the roadmap…'}
            </li>
          )}
          {list.map((i) => (
            <li key={i.id}>
              <button
                type="button"
                aria-describedby={i.from ? `gm-from-${i.id}` : undefined}
                onClick={() => setFeature(i.id)}
                className={`w-full rounded-xl border px-3 py-2 text-left font-semibold ${feature === i.id ? 'border-accent bg-accent-soft' : 'border-line'}`}
              >
                {i.code && (
                  <>
                    <span className="simple-code">{i.code}</span>{' '}
                  </>
                )}
                {i.name}
              </button>
              {i.from && (
                <span id={`gm-from-${i.id}`} className="simple-small block px-3">
                  Move from {mWords(i.from, { mcode })}
                </span>
              )}
            </li>
          ))}
        </ul>
        {!from && (
          <label className={label}>
            Expected lift here
            <input
              className={field}
              value={expected}
              placeholder="For example +5 a day"
              onChange={(e) => setExpected(e.target.value)}
            />
          </label>
        )}
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-full border border-line bg-surface px-4 py-1.5 text-base font-semibold hover:bg-surface2"
          >
            Cancel
          </button>
          <button
            type="button"
            data-testid="gm-save"
            disabled={!feature || !m}
            onClick={() => onSave(feature, m, expected, from?.id ?? null)}
            className="rounded-full border border-accent bg-accent px-4 py-1.5 text-base font-semibold text-on-accent disabled:opacity-40"
          >
            {from ? 'Move here' : 'Add'}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ---------- The page ---------- */

export function GoalMapPage() {
  const { can } = useMe();
  const q = useQuery('simple-goal-map', () => unwrap(api.GET('/v1/simple/goal-map')));
  // kr-in-goal-map: the goals' parents, read before the map is drawn so no key result shows as a goal.
  const goalList = useQuery('simple-goal-map-goal-tree', () =>
    unwrap(api.GET('/v1/baseline/entities', { params: { query: { type: 'goal' } } })),
  );
  const krs = useMemo(() => keyResults(goalList.data ?? []), [goalList.data]);
  const folded = useMemo(
    () => (q.data && (goalList.data || goalList.error) ? withKeyResults(q.data, krs) : null),
    [q.data, goalList.data, goalList.error, krs],
  );
  // The roadmap read: each feature's code and track, the tracks in order, each milestone's code.
  const roadmap = useQuery('simple-roadmap:goal-map', () =>
    unwrap(api.GET('/v1/simple/roadmap', { params: { query: {} } })),
  );
  // Goal map twins: a PRD's milestone coded as a goal's own one is drawn once, as the goal's.
  const map = useMemo(
    () => (folded ? joinTwins(folded.map, roadmap.data?.goal_milestones).map : undefined),
    [folded, roadmap.data],
  );
  const prdOf = useMemo(
    () =>
      new Map(
        (roadmap.data?.goal_milestones ?? []).flatMap((m) =>
          m.prd ? [[m.id, m.prd] as const] : [],
        ),
      ),
    [roadmap.data],
  );
  const router = useRouter();
  const refresh = () => Promise.all([q.reload(), goalList.reload(), roadmap.reload()]);
  // Each feature's code as the roadmap reads it, else as the map's own read gives it (GmFeature.code, GmUnplaced.code).
  const codes = useMemo(
    () =>
      new Map(
        [...(map?.features ?? []), ...(map?.unplaced ?? [])]
          .flatMap((f) => (f.code ? [[f.id, f.code] as [string, string]] : []))
          .concat(
            (roadmap.data?.items ?? []).flatMap((i) =>
              i.code ? [[i.id, i.code] as [string, string]] : [],
            ),
          ),
      ),
    [map, roadmap.data],
  );
  const confirm = useMemo(
    () =>
      new Map(
        (roadmap.data?.items ?? []).flatMap((i) =>
          i.confirm_feature_id ? [[i.id, i.confirm_feature_id] as [string, string]] : [],
        ),
      ),
    [roadmap.data],
  );
  const mcode = useMemo(
    () =>
      new Map(
        (roadmap.data?.goal_milestones ?? []).flatMap((m) =>
          m.roadmap_code ? [[m.id, m.roadmap_code] as [string, string]] : [],
        ),
      ),
    [roadmap.data],
  );
  const trackOf = useMemo(
    () => new Map((roadmap.data?.items ?? []).map((i) => [i.id, i.track?.id ?? null])),
    [roadmap.data],
  );
  const doneOf = useMemo(
    () => new Set((roadmap.data?.items ?? []).filter((i) => i.status === 'done').map((i) => i.id)),
    [roadmap.data],
  );
  const [menu, setMenu] = useState<string | null>(null);
  const [mover, setMover] = useState<Chip | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [moved, setMoved] = useState<string | null>(null);
  const [ghosts, setGhosts] = useState<Ghost[]>([]);
  // de-gm: a feature going to Trash leaves its cell before the API answers (back if it refuses).
  const [gone, setGone] = useState<Set<string>>(new Set());
  useEffect(() => {
    const on = (e: Event) => {
      const { id, going } = (e as CustomEvent<ItemGoingDetail>).detail;
      setGone((s) => {
        const n = new Set(s);
        if (going) n.add(id);
        else n.delete(id);
        return n;
      });
    };
    window.addEventListener(ITEM_GOING_EVENT, on);
    return () => window.removeEventListener(ITEM_GOING_EVENT, on);
  }, []);
  const [shifted, setShifted] = useState<Map<string, { goal: string; track: string | null }>>(
    new Map(),
  );
  const [panel, setPanel] = useState<Chip | null>(null);
  // #1748: a dependency the panel opened in its place (null: the clicked chip's own feature).
  const [shown, setShown] = useState<{ id: string; code: string | null; title: string } | null>(
    null,
  );
  const [attach, setAttach] = useState<string | null>(null);
  const [attachTrack, setAttachTrack] = useState<string | null>(null);
  const [edit, setEdit] = useState<Edit | null>(null);
  const [prd, setPrd] = useState<{ name: string; problem: string } | null>(null);
  const canPrd = useCanStartPrd();
  // goal-map-scoreboard: a Home goal card opens the map on its goal (by id; else by its name).
  const params = useSearchParams();
  const asked = folded?.top(params.get('goal')) ?? params.get('goal');
  const askedName = params.get('name');
  const picked =
    map?.goals.find((g) => g.id === asked)?.id ??
    map?.goals.find((g) => !!askedName && g.name.toLowerCase() === askedName.toLowerCase())?.id ??
    null;
  // A goal left off the map (no number to aim at): a line names it and why, never the top in silence.
  const off =
    map && asked && !picked
      ? (map.off_map.find((g) => g.id === asked) ??
        (askedName ? { id: asked, key: asked, name: askedName } : null))
      : null;
  const offId = off?.id ?? null;
  useEffect(() => {
    if (picked) reveal(`[data-testid="gm-goal"][data-goal="${picked}"]`, 'start');
    else if (offId) reveal(`[data-testid="gm-off-map"]`);
  }, [picked, offId]);

  const chips = useMemo((): Chip[] => {
    if (!map) return [];
    const ms = new Map(map.milestones.map((m) => [m.id, m]));
    const goals = new Set(map.goals.map((g) => g.id));
    // A chip under each goal the feature serves, naming every milestone of that goal it is on.
    const placed = map.features.flatMap((f): Chip[] => {
      const mine = f.milestones
        .flatMap((id) => ms.get(id) ?? [])
        .filter((m) => goals.has(m.goal))
        .sort(byDate);
      return [...new Set(mine.map((m) => m.goal))].map((goal) => {
        const here = mine.filter((m) => m.goal === goal);
        return {
          id: f.id,
          name: f.name,
          f,
          m: here[0],
          ms: here,
          goal,
          track: trackOf.get(f.id) ?? null,
          done: f.released,
          lift: f.lift,
        };
      });
    });
    const on = new Set(placed.map((c) => c.id));
    const loose = map.unplaced.flatMap((u): Chip[] =>
      u.goal && goals.has(u.goal) && !on.has(u.id)
        ? [
            {
              id: u.id,
              name: u.name,
              f: null,
              m: null,
              ms: [],
              goal: u.goal,
              track: trackOf.get(u.id) ?? null,
              done: doneOf.has(u.id),
              lift: 'not_measured',
            },
          ]
        : [],
    );
    return [...placed, ...loose].filter((c) => !gone.has(c.id));
  }, [map, trackOf, doneOf, gone]);
  const tracks = useMemo((): Track[] => {
    const rows: Track[] = [...(roadmap.data?.tracks ?? [])].map((t, i) => ({
      id: t.id,
      name: t.title,
      color: TRACK_COLORS[i % TRACK_COLORS.length],
    }));
    const known = new Set(rows.map((t) => t.id));
    // A track a feature names that the list lacks still gets its row; features with none get No track.
    for (const i of roadmap.data?.items ?? []) {
      if (!i.track || known.has(i.track.id) || !chips.some((c) => c.track === i.track!.id))
        continue;
      known.add(i.track.id);
      rows.push({
        id: i.track.id,
        name: i.track.title,
        color: TRACK_COLORS[rows.length % TRACK_COLORS.length],
      });
    }
    if (chips.some((c) => c.track === null))
      rows.push({ id: null, name: 'No track', color: NO_TRACK });
    return rows;
  }, [roadmap.data, chips]);
  const act = useActs(
    map ?? (q.data as GoalMap),
    (m) => q.setData(() => m),
    refresh,
    codes,
    mcode,
    tracks,
    setMoved,
    folded?.top ?? ((id) => id),
  );
  // prioritize: a chip moved within its cell takes its neighbour's rank (the Priorities order).
  const prio = useQuery('simple-goal-map-priorities', () =>
    unwrap(api.GET('/v1/simple/priorities', { params: { query: {} } })),
  );
  const order = useFeatureOrder({
    data: prio.data,
    reload: () => refresh().then(() => prio.reload()),
    setNote: (n) =>
      n &&
      toast({
        message: String(n.text),
        action: n.changes?.length
          ? {
              label: 'Undo',
              onClick: () =>
                void undo(n.changes![0])
                  .then(() => Promise.all([refresh(), prio.reload()]))
                  .catch((e: unknown) => toast({ message: errorMessage(e) })),
            }
          : undefined,
      }),
    setError: (e) => e && toast({ message: e }),
    noteId: () => Date.now(),
  });
  // prioritize: a goal's header dragged onto another goal (or Alt+Arrow) moves it in the goal order.
  const goalDrag = useGoalDrag({
    ids: map?.goals.map((g) => g.id) ?? [],
    all: [
      ...(map?.goals.map((g) => g.id) ?? []),
      ...(goalList.data ?? [])
        .map((g) => g.id)
        .filter((id) => !map?.goals.some((g) => g.id === id)),
    ],
    may: () => !!map?.can_edit && can('update_entity'),
    saved: async ({ before, after }) => {
      await refresh();
      toast({
        message: 'Goal order saved. Every page shows the new order.',
        action: {
          label: 'Undo',
          onClick: () =>
            void storeGoalOrder(before, new Map(after.map((id, i) => [id, i + 1])))
              .then(refresh)
              .catch((e: unknown) => toast({ message: errorMessage(e) })),
        },
      });
    },
    failed: (e) => toast({ message: errorMessage(e) }),
  });

  if (!map || !roadmap.data)
    return (
      <div className="simple-page" role="status">
        {q.error
          ? errorMessage(q.error)
          : roadmap.error
            ? errorMessage(roadmap.error)
            : 'Loading the goal map…'}
      </div>
    );

  const c: Ctx = {
    map,
    codes,
    confirm,
    mcode,
    tracks,
    onOpen: (f) => (setShown(null), setPanel(f)),
    opened: markOf(panel, shown, chips, codes),
    menu,
    setMenu,
    setMover,
    renaming,
    setRenaming,
    moved,
    act,
    onAttach: (m, track) => {
      setAttach(m);
      setAttachTrack(track ?? null);
    },
    prdOf,
    go: (href) => router.push(href),
    onEdit: setEdit,
    canPrd,
    canChange: map.can_edit || (roadmap.data.roadmaps ?? []).some((r) => r.can_change),
    ghosts,
    addHere: (title, goal, track) => {
      // The roadmap of a feature already serving that goal, else one this person decides on (as the Roadmap's quick add).
      const items = roadmap.data?.items ?? [];
      const here = new Set(chips.filter((x) => x.goal === goal).map((x) => x.id));
      const rm =
        roadmap.data?.roadmap?.id ??
        items.find((i) => here.has(i.id))?.roadmap.id ??
        items.find((i) => i.can_decide)?.roadmap.id;
      const key = Date.now() + Math.random();
      setGhosts((xs) => [...xs, { key, title, goal, track }]);
      // A proposal keeps its chip, marked as waiting, till someone who decides accepts it.
      void act
        .create(title, goal, track, rm)
        .then((how) =>
          setGhosts((xs) =>
            how === 'proposed'
              ? xs.map((x) => (x.key === key ? { ...x, proposed: true } : x))
              : xs.filter((x) => x.key !== key),
          ),
        );
    },
    shifted,
    goalDrag,
    order,
    // de-gm: a chip dropped on another cell takes that cell's track, then (on its next open milestone) its goal.
    dropOn: (key, goal, track) => {
      const f = chips.find((x) => ringOf(x.id, x.goal) === key);
      if (!f || (f.goal === goal && f.track === track)) return;
      const ms = map.milestones.filter((m) => m.goal === goal).sort(byDate);
      const to = ms.find((m) => m.status !== 'met') ?? ms[0];
      setShifted((m) => new Map(m).set(key, { goal: to ? goal : f.goal, track }));
      void (async () => {
        if (f.track !== track) await act.track(f, track);
        if (f.goal !== goal && to) await act.move({ ...f, track }, to.id);
      })().finally(() =>
        setShifted((m) => {
          const n = new Map(m);
          n.delete(key);
          return n;
        }),
      );
    },
  };
  const add = async (feature: string, milestone: string, expected: string, from: string | null) => {
    const name =
      map.features.find((x) => x.id === feature)?.name ??
      roadmap.data?.items.find((i) => i.id === feature)?.title ??
      '';
    if (await act.add(feature, name, milestone, expected, from)) setAttach(null);
  };

  /** The goal map's own editors: each sends one edit, and the map reads as it now is. */
  const save = async (x: EditSave) => {
    if (x.kind === 'prd') {
      const goal = map.goals.find((g) => g.id === x.milestone.goal);
      const areas = map.areas.filter((a) => x.areas.includes(a.id)).map((a) => a.name);
      const m = x.milestone;
      const g = map.guardrail;
      setEdit(null);
      setPrd({
        name: m.name,
        problem: `Reach ${m.name} (${goal?.name.toLowerCase() ?? m.measure}, ${m.threshold === null ? 'no gate yet' : `at least ${num(m.threshold, m.unit)}, held 7 days in a row`}; now ${num(m.current, m.unit)}). Areas: ${areas.join(', ')}.${g ? ` Guardrail: ${g.name.toLowerCase()} ${g.rule}.` : ''}`,
      });
      return;
    }
    try {
      if (x.kind === 'gate') {
        const m = x.milestone;
        const next = await unwrap(
          api.PATCH('/v1/simple/goal-map/milestones/{milestone_id}', {
            params: { path: { milestone_id: m.id } },
            body: { threshold: x.threshold, after: x.after || null, confirm: x.confirm },
          }),
        );
        q.setData(() => next);
        toast({
          message: `${x.confirm ? 'Gate confirmed' : 'Gate saved'}: ${mWords(m, { mcode })}, at least ${num(x.threshold, m.unit)} for 7 days`,
        });
      }
      if (x.kind === 'propose') {
        const next = await unwrap(
          api.POST('/v1/simple/goal-map/milestones', {
            body: {
              name: x.name,
              goal: x.goal,
              threshold: x.threshold,
              areas: x.areas,
              after: x.after || null,
            },
          }),
        );
        q.setData(() => next);
        toast({
          message: `Proposed: ${x.name}${map.approver ? `. Sent to ${map.approver} to approve` : ''}`,
        });
      }
      if (x.kind === 'metric') {
        const next = await unwrap(
          api.POST('/v1/simple/goal-map/goals/{goal_id}/metric', {
            params: { path: { goal_id: x.goal.id } },
            body: { metric: x.metric },
          }),
        );
        q.setData(() => next);
        const title = x.goal.choices.find((ch) => ch.id === x.metric)?.title;
        toast({
          message: next.goals.find((g) => g.id === x.goal.id)?.missing
            ? `${x.goal.name} now reads ${title}; it has no value yet`
            : `${x.goal.name} now reads ${title}`,
        });
        reveal(`[data-testid="gm-goal"][data-goal="${x.goal.id}"]`, 'start');
      }
      setEdit(null);
      void refresh();
    } catch (e) {
      toast({ message: errorMessage(e) });
    }
  };

  return (
    <div className="simple-page" data-testid="gm-page" style={{ maxWidth: 'none' }}>
      <div className="flex flex-col gap-4" onClick={() => menu && setMenu(null)}>
        <div className="flex flex-wrap items-end gap-3">
          <h1 className="simple-h1 max-[600px]:sr-only">Goal map</h1>
          <span className="ml-auto">
            <Legend tracks={tracks} guardrail={map.guardrail} />
          </span>
        </div>
        {off && (
          <p
            data-testid="gm-off-map"
            className="simple-small flex flex-wrap items-center gap-x-2 rounded-xl border border-line px-3 py-1.5"
          >
            <span>
              Not on the map yet: <b className="font-semibold text-text">{off.name}</b> has no
              number to aim at.
            </span>
            <Link
              href={`/simple/priorities?goal=${encodeURIComponent(off.key)}&name=${encodeURIComponent(off.name)}`}
              className="font-semibold text-accent-ink hover:underline"
            >
              Open the goal
            </Link>
          </p>
        )}
        {/* simple-goals: with no goal asked, every goal left off the map is named once, each a way to it. */}
        {map && !asked && map.off_map.length > 0 && (
          <p
            data-testid="gm-off-map-all"
            className="simple-small flex flex-wrap items-center gap-x-2 rounded-xl border border-line px-3 py-1.5"
          >
            <span>Not on the map yet:</span>
            {map.off_map.map((g) => (
              <Link
                key={g.id}
                data-testid="gm-off-map-goal"
                href={`/simple/priorities?goal=${encodeURIComponent(g.key)}&name=${encodeURIComponent(g.name)}`}
                className="font-semibold text-accent-ink hover:underline"
              >
                {g.name}
              </Link>
            ))}
            <InfoTip label="Not on the map yet" testId="gm-off-map-info">
              No number to aim at
            </InfoTip>
          </p>
        )}
        <TracksGrid chips={chips} lines={folded?.lines ?? new Map()} c={c} />
        {mover && <MovePicker f={mover} c={c} onClose={() => setMover(null)} />}
      </div>
      {attach && (
        <AttachDrawer
          map={map}
          milestone={attach}
          track={attachTrack}
          codes={codes}
          mcode={mcode}
          onClose={() => setAttach(null)}
          onSave={(f, m, e, from) => void add(f, m, e, from)}
        />
      )}
      {edit && (
        <Editor map={map} edit={edit} onClose={() => setEdit(null)} onSave={(x) => void save(x)} />
      )}
      {prd && (
        <NewPrdSheet
          prefill={prd}
          onClose={() => setPrd(null)}
          onStarted={() => toast({ message: `New PRD started: “${prd.name}”` })}
        />
      )}
      {panel && (
        <FeaturePanel
          id={panel.id}
          code={codes.get(panel.id)}
          name={panel.name}
          placed={placement(map, panel, mcode)}
          onShown={setShown}
          onClose={() => {
            setShown(null);
            setPanel(null);
            void refresh();
          }}
        />
      )}
    </div>
  );
}
