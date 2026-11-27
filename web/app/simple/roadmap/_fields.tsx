'use client';
// one-feature-panel: every field of a feature, read and changed in place in its panel. Each
// save is one Simple change (Undo, the "changed by …" conflict rule; a commenter's is a
// suggestion for an approver). Without canChange (a viewer) the fields only read.

import { useEffect, useId, useRef, useState, type ReactNode } from 'react';

import { Button, toast } from '@/components/ds';
import { Icon } from '@/components/ds/Icon';
import { InfoTip } from '@/components/ds/InfoTip';
import { Named, NOT_IN_GT, NotInGt } from '@/components/simple/FeatureName';
import { LoadError, Loading } from '@/components/ui';
import { api, unwrap } from '@/lib/api/client';
import { calendarDay } from '@/lib/dates';
import { goalFigure } from '@/lib/format';
import { goalTree } from '@/lib/goal-tree';
import { useMe } from '@/lib/me';
import { byPrdOrderOf, usePrdOrder } from '@/lib/prd-order';
import { byTrackOrder } from '@/lib/track-order';
import { dataChanged, errorMessage, useQuery } from '@/lib/use-query';

import {
  confidenceWord,
  datesFrom,
  codedMilestone,
  goalMilestoneWords,
  milestoneWords,
  nextQuarter,
  partsWords,
  placeable,
  quarterOf,
  statusWord,
  yearSpan,
  type GoalMilestone,
  type Item,
  type Milestone,
} from './_lib';
import { noteWords, targetWords } from './_panel-words';

import type { Act } from './_card';

/** pre-demo QA P-8: on a phone (the sheet), a 44 px hit area; the desktop look is unchanged. */
const TAP =
  'max-sm:min-h-11 max-sm:min-w-11 max-sm:inline-flex max-sm:items-center max-sm:justify-center';
const LINK = `text-sm font-semibold text-accent-ink hover:underline ${TAP}`;
/** roadmap-edit-fixes round 1: a dependency's x, a 24 px target of its own (a bare 16 px icon on the line's baseline was missed). */
const REMOVE =
  'relative inline-flex h-6 w-6 flex-none items-center justify-center self-center rounded text-accent-ink hover:bg-surface2 max-sm:h-11 max-sm:w-11';
/** #1905: a value that opens its editor: the text as it reads, a pointer and a pencil on hover or focus. */
// An inline span (role button), so a value that wraps keeps its (i) tip on its last line as before.
const VALUE =
  'group cursor-pointer rounded focus-visible:outline-2 focus-visible:outline-accent max-sm:inline-flex max-sm:min-h-11 max-sm:items-center';
const INPUT = 'w-full rounded-md border border-line bg-surface px-2 py-1 text-base';

/** A feature's code chip, then its name: "F-12 Alert rules engine", as every page shows it. */
export { Named };

/** "Mar 31, 2027": a goal's date, month first. */
const dayWords = (day: string) =>
  calendarDay(day, { month: 'short', day: 'numeric', year: 'numeric' });

/** "61%", "3 days": a goal's reading in its unit. */
const readingWords = (n: number, unit?: string | null) => goalFigure(n, unit);

/** One field: its value, and (canChange) the value itself is the button that opens its editor in
 * place (#1905: no "Change" link on every row; a pencil on hover or focus). `extra`: what sits
 * beside the value and is no part of it (an (i) tip, a badge), outside the button. */
function Field({
  label,
  testId,
  value,
  extra,
  canChange,
  editor,
}: {
  label: string;
  testId: string;
  value: React.ReactNode;
  extra?: React.ReactNode;
  canChange: boolean;
  editor: (done: () => void) => React.ReactNode;
}) {
  // 'back': closed by Esc, Cancel or a save, so focus goes back to the value it opened from.
  const [state, setState] = useState<'shut' | 'open' | 'back'>('shut');
  const open = state === 'open';
  const button = useRef<HTMLSpanElement>(null);
  const valueId = useId();
  useEffect(() => {
    if (state === 'back') button.current?.focus();
  }, [state]);
  const close = () => setState('back');
  return (
    <>
      <dt className="text-text2">{label}</dt>
      <dd className="min-w-0 [overflow-wrap:anywhere]">
        {open ? (
          <div
            data-testid={`${testId}-edit`}
            onKeyDown={(e) => {
              if (e.key !== 'Escape') return;
              e.preventDefault();
              e.stopPropagation();
              close();
            }}
          >
            {editor(close)}
          </div>
        ) : (
          <span className="flex flex-wrap items-baseline gap-x-2">
            <span data-testid={testId} className="min-w-0">
              {canChange ? (
                <span
                  ref={button}
                  role="button"
                  tabIndex={0}
                  className={VALUE}
                  aria-label={`Change the ${label.toLowerCase()}`}
                  aria-describedby={valueId}
                  onClick={() => setState('open')}
                  onKeyDown={(e) => {
                    if (e.key !== 'Enter' && e.key !== ' ') return;
                    e.preventDefault();
                    setState('open');
                  }}
                >
                  <span id={valueId}>{value}</span>
                  <Icon
                    name="pencil"
                    size={16}
                    className="invisible ml-1.5 inline align-[-3px] text-text2 group-hover:visible group-focus-visible:visible"
                  />
                </span>
              ) : (
                value
              )}
              {extra && <> {extra}</>}
            </span>
          </span>
        )}
      </dd>
    </>
  );
}

function SaveCancel({ onCancel, disabled }: { onCancel: () => void; disabled?: boolean }) {
  return (
    <span className="mt-1 flex gap-3">
      <button
        type="submit"
        disabled={disabled}
        className="rounded-md bg-accent px-3 py-1 text-sm font-semibold text-white disabled:opacity-50"
      >
        Save
      </button>
      <button type="button" className={LINK} onClick={onCancel}>
        Cancel
      </button>
    </span>
  );
}

/** A select editor: the options, the current value, saved by `save`. roadmap-add: choosing a
 * value saves it at once (Esc cancels); only a value with a `note` waits for Save, so its note
 * is read first. */
function Pick({
  label,
  value,
  options,
  save,
  done,
  note,
}: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  save: (v: string) => Promise<void>;
  done: () => void;
  /** What the picked value does beyond itself, shown before Save (panel-menu: a cut feature's parts). */
  note?: (v: string) => string | undefined;
}) {
  const [v, setV] = useState(value);
  const said = note?.(v);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        done();
        if (v !== value) void save(v);
      }}
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return;
        e.preventDefault();
        e.stopPropagation();
        done();
      }}
    >
      <select
        aria-label={label}
        className={INPUT}
        value={v}
        onChange={(e) => {
          const next = e.target.value;
          setV(next);
          if (note?.(next) || next === value) return;
          done();
          void save(next);
        }}
        autoFocus
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      {said && (
        <>
          <p className="mt-1 text-sm text-text2" data-testid="pick-note">
            {said}
          </p>
          <SaveCancel onCancel={done} />
        </>
      )}
    </form>
  );
}

const STAGE: Partial<Record<Item['status'], number>> = {
  draft: 0,
  planned: 1,
  in_progress: 1,
  done: 2,
};

/** panel-stages (#1879): Draft, Planned or Done, either way; a move back asks why before it applies.
 * pm1 '⋯ menu by the close': Cut and Restore are the panel menu's, not a status picked here. */
function StatusEdit({
  value,
  save,
  done,
}: {
  value: Item['status'];
  save: (v: string, reason?: string) => Promise<void>;
  done: () => void;
}) {
  const [v, setV] = useState<string>(value);
  const [why, setWhy] = useState('');
  const back = (STAGE[v as Item['status']] ?? 9) < (STAGE[value] ?? -1);
  const stages = ['draft', 'planned', 'done'] as const;
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (back && !why.trim()) return;
        done();
        if (v !== value) void save(v, back ? why.trim() : undefined);
      }}
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return;
        e.preventDefault();
        e.stopPropagation();
        done();
      }}
    >
      <select
        aria-label="Status"
        className={INPUT}
        value={v}
        onChange={(e) => {
          const next = e.target.value;
          setV(next);
          if (next === value || (STAGE[next as Item['status']] ?? 9) < (STAGE[value] ?? -1)) return;
          done();
          void save(next);
        }}
        autoFocus
      >
        {(stages as readonly string[]).includes(value) ? null : (
          <option value={value}>{statusWord(value)}</option>
        )}
        {stages.map((s) => (
          <option key={s} value={s}>
            {statusWord(s)}
          </option>
        ))}
      </select>
      {back && (
        <>
          <input
            aria-label="Why it moves back"
            data-testid="status-reason"
            placeholder="Why?"
            maxLength={500}
            className={`${INPUT} mt-1`}
            value={why}
            onChange={(e) => setWhy(e.target.value)}
            autoFocus
          />
          <SaveCancel onCancel={done} disabled={!why.trim()} />
        </>
      )}
    </form>
  );
}

/** item-milestone: the Milestone picker's option for the milestone shown now when it was not picked there. */
const SHOWN = 'shown';

const HORIZON_WORDS: Record<Item['horizon'], string> = { now: 'Now', next: 'Next', later: 'Later' };

/** The distinct refs (track, PRD, goal) the roadmap's items have: what an item may be moved to. */
function refs<T extends { id: string }>(
  items: Map<string, Item>,
  of: (i: Item) => T | null | undefined,
): T[] {
  const out = new Map<string, T>();
  for (const i of items.values()) {
    const r = of(i);
    if (r) out.set(r.id, r);
  }
  return [...out.values()];
}

/** Why the item has its dates, for the (i) beside them. */
function datesReason(item: Item): string {
  // roadmap-dates: an undated item's estimate is Oracle's suggestion, else the quarter it was added to.
  const picked = item.picked_quarter ? quarterOf(item.picked_quarter) : null;
  const out =
    picked && (item.start.date < picked.start || item.end.date >= nextQuarter(picked.start));
  if (item.estimated && item.suggestion)
    return `Oracle suggested these dates: ${item.suggestion.basis}${out ? ` They fall outside ${picked.label}, the quarter it was added to: there is no room for it there.` : ''} Set dates to override them.`;
  // qa-leftovers: dates accepted from Oracle's suggestion into an open draft.
  if (item.estimated && item.estimate_basis === 'suggestion')
    return "These dates were accepted from Oracle's suggestion in a draft that is not published yet. Set dates to override them.";
  // qa-nov17: the estimate after what it depends on can leave the quarter.
  if (item.estimated && out)
    return `Oracle estimated these dates after what it depends on. They fall outside ${picked.label}, the quarter it was added to. Set dates to override them.`;
  // flakes-dates: moved after what it depends on, still inside the quarter it was added to.
  if (item.estimated && item.estimate_basis === 'dependencies' && picked)
    return `Oracle estimated these dates after what it depends on, inside ${picked.label}, the quarter it was added to. Set dates to override them.`;
  if (item.estimated && item.estimate_basis === 'quarter' && picked)
    return `Oracle estimated these dates as ${picked.label}, the quarter it was added to, until it suggests dates. Set dates to override them.`;
  if (item.estimated)
    return `Oracle estimated these dates from the ${item.horizon} window and what the feature depends on. Set dates to override them.`;
  if (item.source === 'typed')
    return "Someone set these dates here. They override Oracle's estimate and any date source.";
  return `${datesFrom(item)}. Set dates here to override them.`;
}

/** Home QA #6: an estimate that is only its horizon's window (no suggestion, open or accepted
 * into an open draft, and no picked quarter). */
const windowOnly = (item: Item): boolean =>
  item.estimated && !item.estimate_basis && !item.suggestion && !item.picked_quarter;

/** panel-2 #1906: who decides; several names are the company's owners, any one of whom decides. */
function DeciderNames({ names }: { names: readonly string[] }) {
  if (!names.length) return <span className="text-text2">No decider yet</span>;
  if (names.length === 1) return <>{names[0]}</>;
  return <>Any of: {names.join(', ')}</>;
}

/** Which the dates are: set here, from a date source, or Oracle's estimate. */
function datesKind(item: Item): string {
  if (item.estimated) return "Oracle's estimate";
  if (item.source === 'typed') return 'Set by a person';
  return datesFrom(item);
}

/** item-milestone: the milestone a feature reads: the goal milestone picked for it, else its
 * PRD plan's (its slices'), else its own (with its roadmap code, as the Timeline names it: QA
 * Nov 12 #5), else the one a page shows it under (the Goal map's, GM2); "" with none. */
function milestoneShown(
  item: Item,
  milestones: readonly GoalMilestone[],
  planned: readonly Milestone[],
  served?: string | null,
): string {
  const picked = item.milestone?.id
    ? milestones.find((m) => m.id === item.milestone!.id)
    : undefined;
  if (picked) return goalMilestoneWords(picked, milestones);
  if (!item.milestone?.id && item.slices.length)
    return [
      ...new Map(
        item.slices.map((x) => [x.milestone, `${x.milestone} ${x.milestone_name}`]),
      ).values(),
    ].join(', ');
  const name = item.milestone?.name;
  if (name) {
    const own =
      planned.find((m) => m.item_ids.includes(item.id) && m.name === name) ??
      planned.find((m) => m.name === name);
    return own?.roadmap_code && !name.startsWith(own.roadmap_code)
      ? codedMilestone(own.roadmap_code, name)
      : milestoneWords(name);
  }
  return served ?? '';
}

/**
 * gt-proposed: a feature a run only proposed joins the Ground Truth from its panel, as the Ground
 * Truth check's Confirm it does: confirmed for this item, with the next F-code; every page reads again.
 */
function ConfirmIntoGt({ item }: { item: Item }) {
  const { can } = useMe();
  const [busy, setBusy] = useState(false);
  if (!can('confirm_entity') || !item.confirm_feature_id) return null;
  const confirm = async () => {
    setBusy(true);
    try {
      const e = await unwrap(
        api.POST('/v1/baseline/entities/{entity_id}/confirm', {
          params: { path: { entity_id: item.confirm_feature_id! }, query: { item_id: item.id } },
        }),
      );
      toast({
        place: 'corner',
        message: `Confirmed “${item.title}”${/^[A-Z]{1,3}-\d+$/.test(e.key) ? ` as ${e.key}` : ''}.`,
      });
      dataChanged();
    } catch (err) {
      toast({ place: 'corner', message: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Button
      variant="ghost"
      data-testid="card-code-confirm"
      disabled={busy}
      className="h-6! px-2! text-xs!"
      onClick={() => void confirm()}
    >
      Confirm into the Ground Truth
    </Button>
  );
}

/** panel-stages (#1815): a code never wraps inside itself (F / - / 2 / 9). */
const CodeText = ({ code }: { code?: string | null }) => (
  <span className="whitespace-nowrap [overflow-wrap:normal]" data-testid="card-code-text">
    {code}
  </span>
);

/** gt-proposed: its own code (a title's lead) on a proposed feature is no Ground Truth one either.
 * #1905: the code is the value (the button that changes it); its tip and badges sit beside it. */
function ownCode(
  item: Item,
  canChange: boolean,
  take: () => void,
): { value: ReactNode; extra: ReactNode } | null {
  if (!item.code) return null;
  // unique-codes (Nov 23): an item's own code; the Ground Truth feature it is part of stays named.
  const part = item.feature_name ? (
    <InfoTip label="its feature" align="start" testId="card-code-feature">
      Part of the Ground Truth feature {item.feature_name}.
    </InfoTip>
  ) : null;
  if (!item.confirm_feature_id && !part) return { value: item.code, extra: null };
  return {
    value: <CodeText code={item.code} />,
    extra: (
      <span className="inline-flex flex-wrap items-center gap-1">
        {part}
        {/* panel-stages (#1815 5): this item takes its feature's code; the one that had it, the next number. */}
        {part && canChange && (
          <Button
            variant="ghost"
            data-testid="card-code-take"
            className="h-6! px-2! text-xs!"
            onClick={take}
          >
            Use {item.feature_name?.split(' ')[0]}
          </Button>
        )}
        {item.confirm_feature_id && (
          <>
            <NotInGt className="h-5! px-2! text-xs!" />
            <ConfirmIntoGt item={item} />
          </>
        )}
      </span>
    ),
  };
}

/** The Code field: its value (the button that changes it) and what sits beside it. */
function codeParts(
  item: Item,
  canChange: boolean,
  take: () => void,
): { value: ReactNode; extra: ReactNode } {
  // A code from its Ground Truth feature or its PRD is read here, never changed.
  if (item.code_from)
    return {
      value: (
        <span className="inline-flex flex-wrap items-center gap-1">
          <CodeText code={item.code} />
          <InfoTip label="this code" align="start" testId="card-code-why">
            {item.code_from === 'feature'
              ? 'It comes from its Ground Truth feature: change it there.'
              : "It comes from its PRD's section: change it in the PRD."}
          </InfoTip>
          {/* gt-proposed: a code from a feature a run only proposed is still no Ground Truth one. */}
          {item.confirm_feature_id && (
            <>
              <NotInGt className="h-5! px-2! text-xs!" />
              <ConfirmIntoGt item={item} />
            </>
          )}
        </span>
      ),
      extra: null,
    };
  return (
    ownCode(item, canChange, take) ?? {
      value: <span className="text-text2">None</span>,
      // QA Nov 12 #2: no code, so no Ground Truth feature: flagged, never hidden.
      extra: (
        <span className="inline-flex flex-wrap items-center gap-x-1" data-testid="card-code-flag">
          · <NotInGt className="h-5! px-2! text-xs!" />
          <InfoTip label={NOT_IN_GT} align="start" testId="card-code-gt-why">
            Roadmap items that are no feature of the Ground Truth, or one only proposed so far.
          </InfoTip>
          {item.confirm_feature_id && <ConfirmIntoGt item={item} />}
        </span>
      ),
    }
  );
}

export function PanelFields({
  item,
  items,
  act,
  canChange,
  onOpen,
  milestones = [],
  planned = [],
  served,
  noHorizon,
}: {
  item: Item;
  items: Map<string, Item>;
  act: Act;
  canChange: boolean;
  /** Opens another feature's own panel (a dependency, or one that needs this one). */
  onOpen?: (id: string) => void;
  /** item-milestone: the roadmap read's goal milestones (the item's roadmap's are offered). */
  milestones?: readonly GoalMilestone[];
  /** The roadmap's own milestones, for their codes (M1 Beta). */
  planned?: readonly Milestone[];
  /** GM2: the milestone the page shows the feature under when it reads none of its own. */
  served?: string | null;
  /** The board shows its own horizon control under the fields. */
  noHorizon?: boolean;
}) {
  // The track just picked, shown while its change is made.
  const [picking, setPicking] = useState<{ title: string | null } | null>(null);
  const prdOrderOf = usePrdOrder();
  const shownMilestone = milestoneShown(item, milestones, planned, served);
  const goal = item.goal;
  const people = useQuery(`people:panel:${canChange}`, () =>
    canChange
      ? unwrap(api.GET('/v1/people', { params: { query: { limit: 200 } } }))
      : Promise.resolve([]),
  );
  // #1586 review: members that could not be read say why (still loading says so), never a pick with no one in it.
  const peopleRead = people.data ? null : people.error ? (
    <LoadError what="the people" error={people.error} onRetry={() => void people.reload()} />
  ) : (
    <Loading />
  );
  const target = { item_id: item.id };
  const change = (
    what: string,
    op: string,
    before: Record<string, unknown>,
    after: Record<string, unknown>,
    more?: Record<string, string>,
    note?: string,
  ) => act(what, { op: op as never, target: { ...target, ...more }, before, after }, note);
  // panel-menu: a feature with parts says, as it is cut or moved, that they stay as they are.
  const parts = (how: Parameters<typeof partsWords>[1]) =>
    partsWords(item.parts.length, how) || undefined;
  const others = [...items.values()].filter((i) => i.id !== item.id && i.status !== 'merged');
  // empty-track: every active track is offered, so a track that holds nothing yet (a new track
  // with no PRD) can take its first item; then any other track an item names. track-order: in
  // the company's track order.
  const trackList = useQuery(`simple-tracks:panel:${canChange}`, () =>
    canChange ? unwrap(api.GET('/v1/simple/tracks')) : Promise.resolve(null),
  );
  const tracks = [
    ...new Map(
      [
        ...(trackList.data?.tracks ?? [])
          .filter((t) => t.status === 'active')
          .map((t) => ({ id: t.id, title: t.title, order: t.order })),
        ...refs(items, (i) => i.track),
      ].map((t) => [t.id, t] as const),
    ).values(),
  ].sort(byTrackOrder);
  // prd-order: the PRD picker in the company PRD order.
  const prds = refs(items, (i) => i.prd).sort(byPrdOrderOf(prdOrderOf));
  // roadmap-add: any live top-level goal may be picked, one no item serves yet too (the page's own goal
  // read, in the goals' order; Trash and archived are out of it), then the goals the items name.
  const goalList = useQuery('simple-roadmap-goal-order', () =>
    unwrap(api.GET('/v1/baseline/entities', { params: { query: { type: 'goal' } } })),
  );
  const goals: { id: string; title: string; metric?: string | null }[] = [
    ...new Map(
      [
        ...goalTree((goalList.data ?? []).filter((g) => g.status === 'confirmed'))
          .filter((n) => !n.parentId)
          .map((n) => ({ id: n.goal.id, title: n.name })),
        ...refs(items, (i) => i.goal),
      ].map((g) => [g.id, g] as const),
    ).values(),
  ];
  // roadmap-edit-fixes: the stored key the read says names it (another PRD's feature key is
  // neither its key nor its code), else the one matching its key or code.
  // roadmap-edit-fixes round 1: every stored key that names it (the read's, and its key or code
  // in any case), so a removal drops them all and none shows again as a loose chip.
  const keysOf = (dep: Item) => keysIn(item, dep);
  const shown = (id: string) => items.get(id);
  const featureButton = (i: Item) =>
    onOpen ? (
      <button
        type="button"
        className="text-left text-accent-ink hover:underline"
        onClick={() => onOpen(i.id)}
      >
        <Named item={i} />
      </button>
    ) : (
      <Named item={i} />
    );
  const deps = item.depends_on.map(shown).filter((i): i is Item => !!i);
  // A key the dependency checks did not match here (another PRD's feature key): the item the
  // roadmap read has under that key or code, else the key as typed.
  const loose = item.depends_keys
    .filter((k) => !deps.some((d) => keysOf(d).has(k)))
    .map((k) => ({
      k,
      found: others.find(
        (i) => i.key === k || (!!i.code && i.code.toLowerCase() === k.toLowerCase()),
      ),
    }));

  const code = codeParts(
    item,
    canChange,
    () => void change('Code changed', 'take_feature_code', { code: item.code }, {}),
  );
  return (
    <dl
      // QA Nov 12 #9: a label on its value's line (a phone's 44 px Change centred only the value).
      className="mt-2.5 grid grid-cols-[auto_1fr] items-baseline gap-x-3 gap-y-1.5"
      data-testid="panel-fields"
    >
      {/* every-field-editable: the feature code (F-31), so a feature with none can be given one. */}
      <Field
        label="Code"
        testId="card-code"
        canChange={canChange && !item.code_from}
        value={code.value}
        extra={code.extra}
        editor={(done) => (
          <TextEdit
            label="Code"
            value={item.code ?? ''}
            optional
            max={12}
            done={done}
            save={(v) =>
              change('Code changed', 'set_code', { code: item.code ?? null }, { code: v || null })
            }
          />
        )}
      />
      <Field
        label="Outcome"
        testId="card-outcome"
        canChange={canChange}
        value={item.outcome ?? <span className="text-text2">Not written yet</span>}
        editor={(done) => (
          <TextEdit
            label="Outcome"
            value={item.outcome ?? ''}
            multiline
            done={done}
            save={(v) =>
              change(
                'Outcome changed',
                'edit_outcome',
                { outcome: item.outcome ?? null },
                { outcome: v || null },
              )
            }
          />
        )}
      />
      <Field
        label="Notes"
        testId="card-notes"
        canChange={canChange}
        value={item.note ? noteWords(item.note) : <span className="text-text2">No notes yet</span>}
        editor={(done) => (
          <TextEdit
            label="Notes"
            value={item.note ?? ''}
            multiline
            max={500}
            done={done}
            save={(v) =>
              change('Notes changed', 'edit_note', { note: item.note ?? null }, { note: v || null })
            }
          />
        )}
      />
      <Field
        label="Dates"
        testId="card-dates"
        canChange={canChange}
        value={
          <>
            {/* simple-home-qa-nov14 #4, roadmap-dates: Oracle's one estimate, its suggested span when it has one (the item's own dates);
                Home QA #6: only its horizon's window is no dates yet ("Later · no dates yet"). */}
            {windowOnly(item) ? (
              <span data-testid="card-dates-kind">
                {HORIZON_WORDS[item.horizon]} · no dates yet
              </span>
            ) : (
              <>
                {yearSpan(item.start.date, item.end.date)} ·{' '}
                <span data-testid="card-dates-kind">{datesKind(item)}</span>
              </>
            )}
          </>
        }
        extra={
          /* QA Nov 12 #10: the circled (i) every other why on the page uses. */
          <InfoTip label="these dates" align="start" testId="card-dates-why">
            {datesReason(item)}
          </InfoTip>
        }
        editor={(done) => (
          <DatesEdit
            item={item}
            done={done}
            save={(s, e) =>
              change(
                'Dates set',
                'move_dates',
                { start_date: item.start.date, end_date: item.end.date },
                { start_date: s, end_date: e },
              )
            }
          />
        )}
      />
      <Field
        label="Status"
        testId="card-status"
        canChange={canChange}
        value={statusWord(item.status)}
        editor={(done) => (
          <StatusEdit
            value={item.status}
            done={done}
            save={(v, reason) =>
              change(
                'Status changed',
                'set_status',
                { status: item.status },
                reason ? { status: v, reason } : { status: v },
              )
            }
          />
        )}
      />
      <Field
        label="Confidence"
        testId="card-confidence"
        canChange={canChange}
        value={item.confidence ? confidenceWord(item.confidence) : 'Not rated'}
        editor={(done) => (
          <Pick
            label="Confidence"
            value={item.confidence ?? ''}
            done={done}
            options={[
              { value: '', label: 'Not rated' },
              ...['low', 'medium', 'high'].map((c) => ({
                value: c,
                label: confidenceWord(c),
              })),
            ]}
            save={(v) =>
              change(
                'Confidence changed',
                'set_confidence',
                { confidence: item.confidence ?? null },
                { confidence: v || null },
              )
            }
          />
        )}
      />
      <Field
        label="Owner"
        testId="card-owner"
        canChange={canChange}
        value={item.owner?.name ?? <span className="text-text2">No owner yet</span>}
        editor={(done) =>
          peopleRead ?? (
            <Pick
              label="Owner"
              value={item.own_owner_id ?? ''}
              done={done}
              options={[
                { value: '', label: "The track's owner" },
                ...(people.data ?? [])
                  .filter((p) => p.can_write)
                  .map((p) => ({ value: p.user_id, label: p.name })),
              ]}
              save={(v) =>
                change(
                  'Owner changed',
                  'set_owner',
                  { owner_id: item.own_owner_id ?? null },
                  { owner_id: v || null },
                )
              }
            />
          )
        }
      />
      {/* Who decides changes to this item: its own decider, else its roadmap's. */}
      <Field
        label="Decider"
        testId="card-decider"
        canChange={canChange}
        value={<DeciderNames names={item.deciders} />}
        extra={
          item.deciders.length > 1 && (
            <InfoTip label="who decides" align="start" testId="card-decider-why">
              Any one of them can decide.
            </InfoTip>
          )
        }
        editor={(done) =>
          peopleRead ?? (
            <Pick
              label="Decider"
              value={item.own_decider_id ?? ''}
              done={done}
              options={[
                { value: '', label: "The roadmap's decider" },
                ...(people.data ?? [])
                  .filter((p) => p.can_write)
                  .map((p) => ({ value: p.user_id, label: p.name })),
              ]}
              save={(v) =>
                change(
                  'Decider changed',
                  'set_decider',
                  { decider_id: item.own_decider_id ?? null },
                  { decider_id: v || null },
                )
              }
            />
          )
        }
      />
      {!noHorizon && (
        <Field
          label="Horizon"
          testId="card-horizon"
          canChange={canChange}
          value={HORIZON_WORDS[item.horizon]}
          editor={(done) => (
            <Pick
              label="Horizon"
              value={item.horizon}
              done={done}
              options={(['now', 'next', 'later'] as const).map((h) => ({
                value: h,
                label: HORIZON_WORDS[h],
              }))}
              save={(v) =>
                change(
                  'Horizon changed',
                  'change_horizon',
                  { horizon: item.horizon },
                  { horizon: v },
                )
              }
            />
          )}
        />
      )}
      <Field
        label="Track"
        testId="card-track"
        canChange={canChange}
        value={
          (picking ? picking.title : item.track?.title) ?? (
            <span className="text-text2">No track</span>
          )
        }
        editor={(done) => (
          <Pick
            label="Track"
            value={item.track?.id ?? ''}
            done={done}
            options={[
              { value: '', label: 'No track' },
              ...tracks.map((t) => ({ value: t.id, label: t.title })),
            ]}
            save={async (v) => {
              // Roadmap Nov 10: one who decides sees the picked track at once; the read after
              // the change shows what holds (the old track again when it failed).
              if (item.can_decide)
                setPicking({ title: tracks.find((t) => t.id === v)?.title ?? null });
              try {
                await change(
                  'Track changed',
                  'set_track',
                  { track_id: item.track?.id ?? null },
                  { track_id: v || null },
                );
              } finally {
                setPicking(null);
              }
            }}
          />
        )}
      />
      <Field
        label="Goal"
        testId="card-goal"
        canChange={canChange}
        value={item.goal ? item.goal.title : <span className="text-text2">No goal yet</span>}
        editor={(done) => (
          <Pick
            label="Goal"
            value={item.goal?.id ?? ''}
            done={done}
            options={[
              { value: '', label: "Its feature's goal" },
              ...goals.map((g) => ({
                value: g.id,
                label: g.metric ? `${g.title} (measured by ${g.metric})` : g.title,
              })),
            ]}
            save={(v) =>
              change(
                'Goal changed',
                'set_goal',
                { goal_id: item.goal?.id ?? null },
                { goal_id: v || null },
                undefined,
                parts('goal'),
              )
            }
          />
        )}
      />
      {goal && (
        // How the goal is measured, its target and date: one change to the goal (set_goal_measure),
        // checked against what was read, with Undo; a commenter's is a suggestion.
        <>
          {(['measure', 'target', 'due'] as const).map((f) => {
            const now = {
              measure: goal.metric ?? null,
              target: goal.target ?? null,
              due: goal.due ?? null,
            };
            const label = { measure: 'Measure', target: 'Target', due: 'Date' }[f];
            const value = now[f];
            return (
              <Field
                key={f}
                label={label}
                testId={`card-goal-${f === 'due' ? 'date' : f}`}
                canChange={canChange}
                value={
                  value ? (
                    { measure: (v: string) => v, target: targetWords, due: dayWords }[f](value)
                  ) : (
                    <span className="text-text2">
                      {f === 'measure'
                        ? 'No measure set for this goal yet'
                        : `No ${label.toLowerCase()} yet`}
                    </span>
                  )
                }
                editor={(done) => (
                  <TextEdit
                    label={label}
                    value={value ?? ''}
                    type={f === 'due' ? 'date' : undefined}
                    optional={f !== 'measure'}
                    done={done}
                    save={(v) =>
                      change(
                        `${label} changed`,
                        'set_goal_measure',
                        now,
                        { ...now, [f]: v || null },
                        { goal_id: goal.id },
                      )
                    }
                  />
                )}
              />
            );
          })}
          {goal.current != null && (
            // build-feature-panel (AN PR 1204): the goal's latest reading beside its target, read
            // here and set on the goal ("Today 61% · target 70% by Jun 30, 2027").
            <>
              <dt className="text-text2">Reading</dt>
              <dd className="min-w-0 tnum" data-testid="card-goal-reading">
                Today {readingWords(goal.current, goal.unit)}
                {goal.target ? ` · target ${targetWords(goal.target)}` : ''}
                {goal.due ? ` by ${dayWords(goal.due)}` : ''}
              </dd>
            </>
          )}
        </>
      )}
      <Field
        label="PRD"
        testId="card-prd"
        canChange={canChange}
        value={item.prd?.title ?? <span className="text-text2">No PRD</span>}
        editor={(done) => (
          <Pick
            label="PRD"
            value={item.prd?.id ?? ''}
            done={done}
            options={[
              ...(item.prd ? [] : [{ value: '', label: 'No PRD' }]),
              ...prds.map((p) => ({ value: p.id, label: p.title })),
            ]}
            save={(v) =>
              change(
                'PRD changed',
                'set_prd',
                { prd_document_id: item.prd?.id ?? null },
                { prd_document_id: v || null },
                undefined,
                parts('PRD'),
              )
            }
          />
        )}
      />
      <Field
        label="Milestone"
        testId="card-milestone"
        canChange={canChange}
        value={shownMilestone || <span className="text-text2">No milestone</span>}
        editor={(done) => (
          <Pick
            label="Milestone"
            value={item.milestone?.id ?? (shownMilestone ? SHOWN : '')}
            done={done}
            options={[
              // A milestone the feature reads that is not one picked here (its plan's, or typed in chat).
              ...(shownMilestone && !item.milestone?.id
                ? [{ value: SHOWN, label: shownMilestone }]
                : []),
              { value: '', label: 'No milestone' },
              ...placeable(milestones, item.roadmap.id, byPrdOrderOf(prdOrderOf)).map((m) => ({
                value: m.id,
                label: goalMilestoneWords(m, milestones),
              })),
            ]}
            save={async (v) => {
              if (v === SHOWN) return;
              const m = item.milestone;
              await change(
                'Milestone changed',
                'set_milestone',
                // The item's own milestone as it reads it (one from its track or plan is not its own).
                {
                  milestone:
                    m && m.source === 'item'
                      ? { id: m.id ?? null, name: m.name ?? null, date: m.date ?? null }
                      : null,
                },
                { milestone: v ? { id: v } : null },
              );
            }}
          />
        )}
      />
      <dt className="text-text2">Depends on</dt>
      <dd className="min-w-0">
        <div data-testid="card-depends">
          {deps.length + loose.length === 0 && <span className="text-text2">Nothing</span>}
          <ul className="space-y-0.5">
            {deps.map((d) => (
              <li
                key={d.id}
                className="flex flex-wrap items-baseline gap-x-2"
                data-testid="card-depends-row"
              >
                {featureButton(d)}
                {canChange && (
                  <button
                    type="button"
                    className={REMOVE}
                    // panel-ux #1755: the bare × says what it does on hover; Undo is in its note.
                    title="Remove link"
                    aria-label={`Remove ${d.title} from what it depends on`}
                    onClick={() =>
                      void change(
                        'Dependency removed',
                        'set_depends',
                        { depends_on: item.depends_keys },
                        {
                          depends_on: item.depends_keys.filter((k) => !keysOf(d).has(k)),
                        },
                      )
                    }
                  >
                    <Icon name="x" size={16} />
                  </button>
                )}
              </li>
            ))}
            {loose.map(({ k, found }) => (
              <li
                key={k}
                className="flex flex-wrap items-baseline gap-x-2"
                data-testid="card-depends-row"
              >
                {found ? featureButton(found) : <span>{k}</span>}
                {canChange && (
                  <button
                    type="button"
                    className={REMOVE}
                    // panel-ux #1755: the bare × says what it does on hover; Undo is in its note.
                    title="Remove link"
                    aria-label={`Remove ${found?.title ?? k} from what it depends on`}
                    onClick={() =>
                      void change(
                        'Dependency removed',
                        'set_depends',
                        { depends_on: item.depends_keys },
                        { depends_on: item.depends_keys.filter((x) => x !== k) },
                      )
                    }
                  >
                    <Icon name="x" size={16} />
                  </button>
                )}
              </li>
            ))}
          </ul>
          {/* roadmap-edit-fixes: Oracle's ideas of what a new item depends on: a person adds them. */}
          {canChange &&
            (item.suggested_depends ?? []).map((k) => {
              const found = others.find((i) => i.key === k);
              return (
                <p
                  key={k}
                  className="mt-0.5 flex flex-wrap items-baseline gap-x-2 text-sm text-text2"
                  data-testid="card-depends-idea"
                >
                  <span>Oracle suggests {found ? <Named item={found} /> : k}</span>
                  <button
                    type="button"
                    className={LINK}
                    aria-label={`Add ${found?.title ?? k} to what it depends on`}
                    onClick={() =>
                      void change(
                        'Dependency added',
                        'set_depends',
                        { depends_on: item.depends_keys },
                        { depends_on: [...item.depends_keys, k] },
                      )
                    }
                  >
                    Add
                  </button>
                </p>
              );
            })}
        </div>
        {canChange && (
          <AddDependency
            item={item}
            loops={needsMe(item, items)}
            options={others.filter(
              (o) => !item.depends_on.includes(o.id) && !loose.some((l) => l.found?.id === o.id),
            )}
            add={(key) =>
              change(
                'Dependency added',
                'set_depends',
                { depends_on: item.depends_keys },
                { depends_on: [...item.depends_keys, key] },
              )
            }
          />
        )}
      </dd>
      <dt className="text-text2">Needed by</dt>
      <dd className="min-w-0">
        <div data-testid="card-needed">
          {item.needed_by.length === 0 ? (
            'None'
          ) : (
            <ul className="space-y-0.5">
              {item.needed_by
                .map(shown)
                .filter((i): i is Item => !!i)
                .map((i) => (
                  <li
                    key={i.id}
                    className="flex flex-wrap items-baseline gap-x-2"
                    data-testid="card-needed-row"
                  >
                    {featureButton(i)}
                    {/* pre-demo QA S-4: the same dependency edit, from the other side (its set_depends). */}
                    {canChange && (
                      <button
                        type="button"
                        className={REMOVE}
                        // panel-ux #1755: the bare × says what it does on hover; Undo is in its note.
                        title="Remove link"
                        aria-label={`Remove ${i.title} from what needs it`}
                        onClick={() =>
                          void change(
                            'Dependency removed',
                            'set_depends',
                            { depends_on: i.depends_keys },
                            { depends_on: i.depends_keys.filter((k) => !keysIn(i, item).has(k)) },
                            { item_id: i.id },
                          )
                        }
                      >
                        <Icon name="x" size={16} />
                      </button>
                    )}
                  </li>
                ))}
            </ul>
          )}
        </div>
        {canChange && (
          <AddDependent
            loops={iNeed(item, items)}
            options={others.filter((o) => !item.needed_by.includes(o.id))}
            add={(o) =>
              change(
                'Dependency added',
                'set_depends',
                { depends_on: o.depends_keys },
                // The same roadmap: this item's key; another roadmap's feature: its code.
                {
                  depends_on: [
                    ...o.depends_keys,
                    o.roadmap.id === item.roadmap.id ? item.key : (item.code ?? item.key),
                  ],
                },
                { item_id: o.id },
              )
            }
          />
        )}
      </dd>
    </dl>
  );
}

function TextEdit({
  label,
  value,
  multiline,
  type,
  optional,
  max,
  save,
  done,
}: {
  label: string;
  value: string;
  /** build-feature-panel: the most characters the API takes; past it, Save waits and says so. */
  max?: number;
  multiline?: boolean;
  /** "date": a day picker (YYYY-MM-DD). */
  type?: 'date';
  /** May be saved empty (cleared). */
  optional?: boolean;
  save: (v: string) => Promise<void>;
  done: () => void;
}) {
  const [v, setV] = useState(value);
  const over = max != null && v.trim().length > max;
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (over) return;
        done();
        if (v.trim() !== value) void save(v.trim());
      }}
    >
      {multiline ? (
        <textarea
          aria-label={label}
          className={INPUT}
          rows={3}
          value={v}
          onChange={(e) => setV(e.target.value)}
          autoFocus
        />
      ) : (
        <input
          aria-label={label}
          type={type}
          className={INPUT}
          value={v}
          onChange={(e) => setV(e.target.value)}
          autoFocus
        />
      )}
      {over && (
        <span role="alert" data-testid="field-too-long" className="mt-1 block text-sm text-crit">
          Keep the {label.toLowerCase()} to {max} characters
        </span>
      )}
      <SaveCancel onCancel={done} disabled={over || (!multiline && !optional && !v.trim())} />
    </form>
  );
}

/** The name, edited in the panel's header. */
export function NameEdit({ item, act, done }: { item: Item; act: Act; done: () => void }) {
  return (
    <TextEdit
      label="Name"
      value={item.title}
      max={200}
      done={done}
      save={(v) =>
        act('Renamed', {
          op: 'edit_title',
          target: { item_id: item.id },
          before: { title: item.title },
          after: { title: v },
        })
      }
    />
  );
}

function DatesEdit({
  item,
  save,
  done,
}: {
  item: Item;
  save: (start: string, end: string) => Promise<void>;
  done: () => void;
}) {
  const [start, setStart] = useState(item.start.date);
  const [end, setEnd] = useState(item.end.date);
  const bad = !start || !end || end < start;
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (bad) return;
        done();
        void save(start, end);
      }}
    >
      <span className="flex flex-wrap gap-2">
        <label className="text-sm text-text2">
          Start
          <input
            type="date"
            aria-label="Start"
            className={INPUT}
            value={start}
            onChange={(e) => setStart(e.target.value)}
          />
        </label>
        <label className="text-sm text-text2">
          End
          <input
            type="date"
            aria-label="End"
            className={INPUT}
            value={end}
            onChange={(e) => setEnd(e.target.value)}
          />
        </label>
      </span>
      {bad && <span className="block text-sm text-warn">The end cannot come before the start</span>}
      <SaveCancel onCancel={done} disabled={bad} />
    </form>
  );
}

/** The stored keys of `owner`'s dependencies that name `dep` (the read's, and its key or code in any case). */
function keysIn(owner: Item, dep: Item): Set<string> {
  return new Set(
    owner.depends_keys.filter(
      (k) =>
        k === owner.depends_key_of?.[dep.id] ||
        (owner.depends_keys_of?.[dep.id] ?? []).includes(k) ||
        k.toLowerCase() === dep.key.toLowerCase() ||
        (!!dep.code && k.toLowerCase() === dep.code.toLowerCase()),
    ),
  );
}

/** pre-demo QA S-4: the features the item waits on, directly or through others (picked as one that needs it, they would make a loop). */
function iNeed(item: Item, items: Map<string, Item>): Set<string> {
  const out = new Set<string>();
  const queue = [item.id];
  while (queue.length) {
    const id = queue.shift()!;
    for (const n of items.get(id)?.depends_on ?? []) {
      if (n !== item.id && !out.has(n)) {
        out.add(n);
        queue.push(n);
      }
    }
  }
  return out;
}

/** build-feature-panel (AN PR 1204): the features that wait on the item, directly or through others. */
function needsMe(item: Item, items: Map<string, Item>): Set<string> {
  const out = new Set<string>();
  const queue = [item.id];
  while (queue.length) {
    const id = queue.shift()!;
    for (const n of items.get(id)?.needed_by ?? []) {
      if (n !== item.id && !out.has(n)) {
        out.add(n);
        queue.push(n);
      }
    }
  }
  return out;
}

/** Add a dependency: a feature of the roadmap by code and name, or one from another PRD, searched by code and name. */
function AddDependency({
  item,
  options,
  loops,
  add,
}: {
  item: Item;
  options: Item[];
  /** The features that already wait on this one (directly or through others): picked, they would make a loop. */
  loops: Set<string>;
  add: (key: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [pick, setPick] = useState('');
  const [search, setSearch] = useState('');
  // goals-dep-picker: the feature from another PRD picked from the search (its id).
  const [far, setFar] = useState('');
  if (!open)
    return (
      <button
        type="button"
        className={`${LINK} mt-0.5 block max-sm:flex max-sm:w-fit`}
        onClick={() => setOpen(true)}
      >
        Add a dependency
      </button>
    );
  // goals-dep-picker: another PRD's features, from the roadmap read the panel already has,
  // searched by code and name (as the Goal map's Add a feature); never a raw key to know.
  const term = search.trim().toLowerCase();
  const otherPrd = options.filter((o) => !item.prd || o.prd?.id !== item.prd.id);
  const found = term
    ? otherPrd.filter((o) => `${o.code ?? ''} ${o.title}`.toLowerCase().includes(term)).slice(0, 8)
    : [];
  const chosen = options.find((o) => o.id === (pick || far));
  // The same roadmap: its item key; another roadmap's feature: its code (a feature key).
  const key = chosen
    ? chosen.roadmap.id === item.roadmap.id
      ? chosen.key
      : (chosen.code ?? chosen.key)
    : '';
  const close = () => {
    setOpen(false);
    setPick('');
    setSearch('');
    setFar('');
  };
  return (
    <form
      className="mt-1"
      onSubmit={(e) => {
        e.preventDefault();
        if (!key) return;
        close();
        void add(key);
      }}
    >
      <select
        aria-label="Feature it depends on"
        className={INPUT}
        value={pick}
        onChange={(e) => {
          setPick(e.target.value);
          setFar('');
        }}
        autoFocus
      >
        <option value="">Pick a feature</option>
        {options.map((o) => (
          <option key={o.id} value={o.id} disabled={loops.has(o.id)}>
            {o.code ? `${o.code} ${o.title}` : o.title}
            {loops.has(o.id) ? ' · Needs this one: it would make a loop' : ''}
          </option>
        ))}
      </select>
      {!pick && (
        <>
          <input
            aria-label="Or a feature from another PRD"
            placeholder="Or a feature from another PRD"
            className={`${INPUT} mt-1`}
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setFar('');
            }}
          />
          {term && (
            <ul
              className="mt-1 max-h-48 space-y-0.5 overflow-y-auto"
              data-testid="card-depends-search"
            >
              {found.length === 0 && <li className="text-sm text-text2">No feature matches</li>}
              {found.map((o) => (
                <li key={o.id}>
                  <button
                    type="button"
                    aria-pressed={far === o.id}
                    disabled={loops.has(o.id)}
                    className={`w-full rounded-md border px-2 py-1 text-left text-base disabled:opacity-50 ${far === o.id ? 'border-accent bg-accent-soft' : 'border-line'}`}
                    onClick={() => setFar(o.id)}
                  >
                    <Named item={o} />
                    {loops.has(o.id) ? ' · Needs this one: it would make a loop' : ''}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      <SaveCancel onCancel={close} disabled={!key} />
    </form>
  );
}

/** pre-demo QA S-4: add a feature that needs this one (its own dependency, set from here). */
function AddDependent({
  options,
  loops,
  add,
}: {
  options: Item[];
  /** The features this one already waits on (directly or through others): picked, they would make a loop. */
  loops: Set<string>;
  add: (o: Item) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [pick, setPick] = useState('');
  if (!open)
    return (
      <button
        type="button"
        className={`${LINK} mt-0.5 block max-sm:flex max-sm:w-fit`}
        onClick={() => setOpen(true)}
      >
        Add a feature that needs it
      </button>
    );
  const chosen = options.find((o) => o.id === pick);
  return (
    <form
      className="mt-1"
      onSubmit={(e) => {
        e.preventDefault();
        if (!chosen) return;
        setOpen(false);
        setPick('');
        void add(chosen);
      }}
    >
      <select
        aria-label="Feature that needs it"
        className={INPUT}
        value={pick}
        onChange={(e) => setPick(e.target.value)}
        autoFocus
      >
        <option value="">Pick a feature</option>
        {options.map((o) => (
          <option key={o.id} value={o.id} disabled={loops.has(o.id)}>
            {o.code ? `${o.code} ${o.title}` : o.title}
            {loops.has(o.id) ? ' · This one needs it: it would make a loop' : ''}
          </option>
        ))}
      </select>
      <SaveCancel onCancel={() => setOpen(false)} disabled={!chosen} />
    </form>
  );
}
