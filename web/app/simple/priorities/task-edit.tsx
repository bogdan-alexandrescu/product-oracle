'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';

import { Button } from '@/components/ds';
import { LoadError } from '@/components/ui';
import { useFeatureDelete } from '@/components/simple/FeatureDelete';
import { NotInGt } from '@/components/simple/FeatureName';
import { api, unwrap, type Schemas } from '@/lib/api/client';
import { errorMessage, useQuery } from '@/lib/use-query';

import { BTN, nextNoteId, TaskActions, type Note } from './goal-buckets';
import { useCodedMilestone } from './milestone-codes';
import { gtCode } from './plan-buckets';

export { TaskActions };

/*
 * Tasks in the goal buckets (the owner, Nov 4: "edit, delete, add in place new tasks"). A task is
 * a roadmap item under a goal. "+ Add a feature" and a task's pencil open GB1 a's "Pencil, form in
 * place" (name, outcome, milestone); its ⋯ cuts it from the roadmap. Every write is a change of
 * the change engine (POST /v1/simple/changes: add_item, edit_title, edit_outcome, set_milestone,
 * cut), applied into the roadmap's working draft or proposed, as the rest of Simple does; an
 * applied one offers Undo.
 */

type Row = Schemas['SimplePriorityRow'];
type Item = Schemas['SimpleRoadmapItem'];
type ChangeIn = Schemas['SimpleChangeIn'];
type Change = Schemas['SimpleChangeOut'];

const PRIMARY =
  'inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-lg border border-transparent bg-accent px-3 text-sm font-[650] text-on-accent disabled:border-line-strong disabled:bg-surface2 disabled:text-text2';
const INPUT =
  'h-9 w-full min-w-0 rounded-lg border border-line-strong bg-surface px-2.5 text-base text-text';
const BAD =
  'h-9 w-full min-w-0 rounded-lg border-2 border-warn bg-surface px-2.5 text-base text-text';

/** A task as the buckets show it: its roadmap item, its code and name. */
export type Task = { itemId: string; code: string; name: string };
export type TaskFields = { name: string; outcome: string; milestone: string };
export type MilestoneOption = { name: string; date: string | null };

/** The roadmap's items, for each task's outcome and milestone (the item panel reads the same). */
export function useRoadmapItems() {
  // #1586 review: unwrap keeps the server's reason, which a failed read shows.
  return useQuery('simple-roadmap:{}', () => unwrap(api.GET('/v1/simple/roadmap', {})));
}

/** A task's row in the priorities: by its code, else its name. */
export function rowOf(rows: Row[], code: string, name: string): Row | undefined {
  const c = code.toLowerCase();
  return (
    rows.find((r) => r.code.toLowerCase() === c || r.short_code.toLowerCase() === c) ??
    rows.find((r) => r.title === name)
  );
}

/** The milestones a task may be in: the plan's, the roadmap's, then those the roadmap's items name. */
export function milestoneOptions(
  plan: Schemas['SimplePlanOut'] | null | undefined,
  items: Item[],
  roadmap: Schemas['SimpleMilestone'][] = [],
): MilestoneOption[] {
  const out: MilestoneOption[] = (plan?.milestones ?? []).map((m) => ({
    name: m.name,
    date: m.end_date ?? null,
  }));
  for (const m of roadmap)
    if (!out.some((o) => o.name === m.name)) out.push({ name: m.name, date: m.date ?? null });
  for (const i of items) {
    const name = i.milestone?.name;
    if (name && !out.some((m) => m.name === name))
      out.push({ name, date: i.milestone?.date ?? null });
  }
  return out;
}

function Field({ label, children, error }: { label: string; children: ReactNode; error?: string }) {
  return (
    <label className="block min-w-0">
      <span className="text-sm font-[650] text-text2">{label}</span>
      {children}
      {error && <span className="mt-0.5 block text-sm text-warn">{error}</span>}
    </label>
  );
}

/** GB1 a's form in place, for a task: its name, its outcome and its milestone; the goal is the bucket's. */
export function TaskForm({
  start,
  milestones,
  title,
  goal,
  onSave,
  onCancel,
}: {
  start: TaskFields;
  milestones: MilestoneOption[];
  title: string;
  goal: string;
  onSave: (f: TaskFields) => Promise<void>;
  onCancel: () => void;
}) {
  const [f, setF] = useState<TaskFields>(start);
  const [busy, setBusy] = useState(false);
  const done = !!f.name.trim();
  const set = (k: keyof TaskFields) => (e: { target: { value: string } }) =>
    setF((x) => ({ ...x, [k]: e.target.value }));
  // #1894: each milestone by the roadmap's one code, never a PRD's own number.
  const coded = useCodedMilestone();
  const options =
    f.milestone && !milestones.some((m) => m.name === f.milestone)
      ? [...milestones, { name: f.milestone, date: null }]
      : milestones;
  return (
    <form
      data-testid="task-form"
      className="grid gap-2 py-2"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!done || busy) return;
        setBusy(true);
        try {
          await onSave(f);
        } finally {
          setBusy(false);
        }
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          onCancel();
        }
      }}
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
        <h4 className="whitespace-nowrap text-lg font-[650]">{title}</h4>
        <span className="min-w-0 text-sm text-text2 max-sm:basis-full sm:ml-auto">
          Goal: {goal}
        </span>
      </div>
      <Field label="Name" error={!done ? 'Name the task.' : undefined}>
        <input
          autoFocus
          value={f.name}
          onChange={set('name')}
          placeholder="For example: Referral link"
          className={done ? INPUT : BAD}
        />
      </Field>
      <Field label="Outcome: what changes for people">
        <textarea
          rows={2}
          value={f.outcome}
          onChange={set('outcome')}
          placeholder="For example: shoppers pick up where they left off"
          className={`${INPUT} h-auto py-1.5`}
        />
      </Field>
      <Field label="Milestone">
        <select value={f.milestone} onChange={set('milestone')} className={INPUT}>
          <option value="">No milestone</option>
          {options.map((m) => (
            <option key={m.name} value={m.name}>
              {coded(m.name)}
            </option>
          ))}
        </select>
      </Field>
      <div className="mt-1 flex items-center gap-2">
        <button type="submit" className={PRIMARY} disabled={!done || busy}>
          Save
        </button>
        <button type="button" className={BTN} onClick={onCancel}>
          Cancel
        </button>
        {!done && <span className="min-w-0 text-sm text-text2">A task needs a name.</span>}
      </div>
    </form>
  );
}

/** "A, B and C". */
const andList = (xs: string[]) =>
  xs.length < 2 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;

/** Cut from the roadmap asks first and names what depends on the task, as a cut does. */
export function CutDialog({
  task,
  dependents,
  onClose,
  onCut,
}: {
  task: Task;
  dependents: string[];
  onClose: () => void;
  onCut: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('button')?.focus();
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [onClose]);
  return (
    <div
      data-backdrop=""
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-center sm:p-4"
      onClick={onClose}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={`Cut ${task.name}`}
        className="flex max-h-[88vh] w-full max-w-lg flex-col rounded-t-[var(--simple-card-radius)] border border-line bg-surface p-4 shadow-lg sm:rounded-[var(--simple-card-radius)]"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-[length:var(--simple-h2)] font-semibold leading-[var(--simple-h2-leading)]">
          Cut {task.name} from the roadmap?
        </h2>
        <p
          data-testid="cut-dependents"
          className={`mt-2 text-base ${dependents.length ? 'text-warn' : 'text-text2'}`}
        >
          {dependents.length
            ? `⚠ ${andList(dependents)} ${dependents.length === 1 ? 'depends' : 'depend'} on it.`
            : 'Nothing depends on it.'}
        </p>
        <p className="mt-1 text-base text-text2">
          It is not deleted: the roadmap keeps it as cut, and Undo brings it back.
        </p>
        <div className="mt-3 flex items-center gap-2">
          <button
            type="button"
            className={PRIMARY}
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await onCut();
              } finally {
                setBusy(false);
              }
            }}
          >
            Cut from the roadmap
          </button>
          <button type="button" className={BTN} onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

/** The API's own words for a change it refused (never "Cannot reach the API"). */
class Refused extends Error {}

const said = (e: unknown) => (e instanceof Refused ? e.message : errorMessage(e));

/** POST /v1/simple/changes; a refusal throws its words. */
async function send(body: ChangeIn): Promise<Change> {
  const { data, error, response } = await api.POST('/v1/simple/changes', { body });
  if (response.ok && data) return data.change;
  const detail = (error as { detail?: unknown } | undefined)?.detail;
  throw new Refused(
    typeof detail === 'string'
      ? detail
      : detail && typeof detail === 'object' && 'message' in detail
        ? String((detail as { message: unknown }).message)
        : response.statusText,
  );
}

const milestoneOf = (name: string, options: MilestoneOption[]) =>
  name
    ? { name, date: options.find((m) => m.name === name)?.date ?? null, date_source: 'typed' }
    : null;

/** What an edit's change is about, for the note naming those proposed. */
const PART: Record<string, string> = {
  edit_title: 'the name',
  edit_outcome: 'the outcome',
  set_milestone: 'the milestone',
};

/** The task writes: each applied one shows its note with Undo; a proposal says it waits for a decision. */
export function useTaskWrites(
  reload: () => Promise<void>,
  setNote: (n: Note | null) => void,
  setError: (e: string | null) => void,
) {
  async function run(
    go: () => Promise<Change[]>,
    done: string,
    proposed: string,
  ): Promise<boolean> {
    try {
      const made = await go();
      setError(null);
      const applied = made.filter((c) => c.status === 'applied');
      const waiting = made.filter((c) => c.status !== 'applied');
      const changes = applied.filter((c) => c.can_undo).map((c) => c.id);
      if (made.length && !applied.length)
        setNote({ id: nextNoteId(), text: <>{proposed}: it waits for a decision.</> });
      else if (waiting.length) {
        // Some applied, some proposed: the note names those proposed.
        const parts = [...new Set(waiting.map((c) => PART[c.op] ?? 'a change'))];
        setNote({
          id: nextNoteId(),
          text: (
            <>{`${done} Proposed ${andList(parts)}: ${parts.length === 1 ? 'it waits' : 'they wait'} for a decision.`}</>
          ),
          changes,
        });
      } else setNote({ id: nextNoteId(), text: <>{done}</>, changes });
      await reload();
      return true;
    } catch (e) {
      setError(said(e));
      await reload();
      return false;
    }
  }
  return {
    add: (goal: { id: string; title: string }, f: TaskFields, options: MilestoneOption[]) => {
      const name = f.name.trim();
      const milestone = milestoneOf(f.milestone, options);
      return run(
        async () => [
          await send({
            op: 'add_item',
            target: { where: { kind: 'goal', value: goal.id } },
            before: {},
            after: {
              title: name,
              outcome: f.outcome.trim() || null,
              ...(milestone ? { milestone } : {}),
            },
          }),
        ],
        `Added ${name} to ${goal.title}.`,
        `Proposed adding ${name} to ${goal.title}`,
      );
    },
    edit: (task: Task, item: Item | undefined, f: TaskFields, options: MilestoneOption[]) => {
      const name = f.name.trim();
      const was = {
        title: item?.title ?? task.name,
        outcome: item?.outcome ?? '',
        milestone: item?.milestone?.source === 'item' ? (item.milestone.name ?? '') : '',
      };
      const target = { item_id: task.itemId };
      const ins: ChangeIn[] = [];
      if (name !== was.title)
        ins.push({
          op: 'edit_title',
          target,
          before: { title: was.title },
          after: { title: name },
        });
      if (f.outcome.trim() !== was.outcome.trim())
        ins.push({
          op: 'edit_outcome',
          target,
          before: { outcome: item?.outcome ?? null },
          after: { outcome: f.outcome.trim() || null },
        });
      if (f.milestone !== was.milestone) {
        const before =
          item?.milestone?.source === 'item' && item.milestone.name
            ? { name: item.milestone.name, date: item.milestone.date ?? null }
            : null;
        ins.push({
          op: 'set_milestone',
          target,
          before: { milestone: before },
          after: { milestone: milestoneOf(f.milestone, options) },
        });
      }
      // Nothing changed: say so, and send nothing.
      if (!ins.length) {
        setError(null);
        setNote({ id: nextNoteId(), text: <>No changes.</> });
        return Promise.resolve(true);
      }
      return run(
        async () => {
          const made: Change[] = [];
          for (const body of ins) made.push(await send(body));
          return made;
        },
        `Saved ${name}.`,
        `Proposed the change to ${name}`,
      );
    },
    /** A task carried to another goal's bucket: that goal becomes the first it serves. */
    move: (task: Task, item: Item | undefined, to: { id: string; title: string }) => {
      const was = item?.goal_ids ?? [];
      return run(
        async () => [
          await send({
            op: 'set_goals',
            target: { item_id: task.itemId },
            before: { goal_ids: was },
            after: { goal_ids: [to.id, ...was.slice(1).filter((g) => g !== to.id)] },
          }),
        ],
        `Moved ${task.name} to ${to.title}.`,
        `Proposed moving ${task.name} to ${to.title}`,
      );
    },
    cut: (task: Task, dependents: string[]) =>
      run(
        async () => [
          await send({
            op: 'cut',
            target: { item_id: task.itemId },
            before: { cut: false },
            after: { cut: true },
          }),
        ],
        `Cut ${task.name} from the roadmap.${dependents.length ? ` ${andList(dependents)} ${dependents.length === 1 ? 'depends' : 'depend'} on it.` : ''}`,
        `Proposed cutting ${task.name}`,
      ),
    undo: async (ids: string[]) => {
      try {
        for (const id of [...ids].reverse()) {
          const { response, error } = await api.POST('/v1/simple/changes/{change_id}/undo', {
            params: { path: { change_id: id } },
          });
          if (!response.ok)
            throw new Error(
              String((error as { detail?: unknown } | undefined)?.detail ?? 'Could not undo'),
            );
        }
        setNote({ id: nextNoteId(), text: <>Undone: the task is back as it was.</> });
      } catch (e) {
        setError(said(e));
      }
      await reload();
    },
  };
}

/** The titles of the rows that depend on a task (by its code). */
export function dependentsOf(rows: Row[], code: string): string[] {
  return rows
    .filter((r) => r.depends_on.some((d) => d.toLowerCase() === code.toLowerCase()))
    .map((r) => r.title);
}

/** A code people know ("F-27"), not an item's raw key ("referral-link"): a draft shows no chip until it has one. */
export const knownCode = (code: string) => /^[a-z]+\d*-\d+[a-z]?$/i.test(code);

/** A task's row where the plan does not place it (an added draft; every task with no dated plan), as FeatureRows draws a feature's. */
export function TaskRow({
  code,
  name,
  milestone,
  weeks,
  draft,
  grip,
  lifted,
  onOpen,
  feature,
  actions,
  partOf,
  onRename,
  onDelete,
  onKeys,
}: {
  code: string;
  name: string;
  milestone: string | null;
  weeks: string;
  draft?: boolean;
  /** Who may move it: its grip's handlers. */
  grip?: {
    onPointerDown: (e: React.PointerEvent) => void;
    onKeyDown: (e: React.KeyboardEvent) => void;
  };
  lifted?: boolean;
  onOpen?: () => void;
  /** build-feature-panel: the feature its name opens in the one feature panel (its item id, else its key). */
  feature?: string;
  actions?: ReactNode;
  /** panel-menu: the feature it is part of ("part of Alert rules engine"), beside its name. */
  partOf?: ReactNode;
  /** de-gm: who may change it renames it in place (a double-click or F2 on its name). */
  onRename?: (name: string) => void;
  /** de-gm: Delete on its name moves it to Trash, with Undo. */
  onDelete?: () => void;
  /** prioritize: keys on the focused row (Alt+Arrow moves it one place). */
  onKeys?: (e: React.KeyboardEvent) => void;
}) {
  // qa-nov17 G8: the milestone by its code and name as the roadmap reads it ("M6 Beta").
  const coded = useCodedMilestone();
  const [renaming, setRenaming] = useState(false);
  // The new name shows at once, till the row reads it back (or a refusal brings the old one).
  const [typed, setTyped] = useState<{ was: string; to: string } | null>(null);
  const shown = typed?.was === name ? typed.to : name;
  // A double-click renames, so the panel waits a beat for a second click.
  const clickAt = useRef<number | undefined>(undefined);
  return (
    <li
      data-testid="plan-feature"
      data-code={code}
      data-lifted={lifted ? '' : undefined}
      onKeyDown={onKeys}
      className={`relative flex items-center gap-2 border-b border-line py-[5px] text-base leading-[22px] max-sm:flex-wrap max-sm:gap-y-1 ${lifted ? '[&>*]:opacity-30' : ''}`}
    >
      {grip && (
        <button
          type="button"
          data-testid="feature-grip"
          title="Drag to another goal"
          aria-label={`Move ${name} to another goal`}
          aria-describedby="bucket-move-help"
          className={`-mx-1 flex-none cursor-grab touch-none select-none rounded px-1 text-base ${lifted ? 'text-accent-ink' : 'text-text2'}`}
          onPointerDown={grip.onPointerDown}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              grip.onKeyDown(e);
            }
          }}
        >
          ⠿
        </button>
      )}
      {/* PR1: a Ground Truth code only (never a short code made from initials); none is flagged after the name. */}
      {gtCode(code) && (
        <span
          data-testid="prio-code"
          title={name}
          className="inline-block min-w-[3.25rem] flex-none whitespace-nowrap rounded-md border border-line-strong bg-surface px-1.5 text-center align-middle text-sm font-semibold leading-5 tabular-nums text-text"
        >
          {code}
        </span>
      )}{' '}
      <span
        data-testid="plan-feature-name"
        className="min-w-[10rem] flex-1 max-sm:min-w-0 max-sm:basis-0"
      >
        {renaming && onRename ? (
          <input
            autoFocus
            aria-label={`Rename ${name}`}
            data-testid="plan-feature-rename"
            defaultValue={shown}
            onKeyDown={(e) => {
              const v = e.currentTarget.value.trim();
              if (e.key === 'Escape') setRenaming(false);
              else if (e.key === 'Enter') {
                setRenaming(false);
                if (v && v !== shown) {
                  setTyped({ was: name, to: v });
                  onRename(v);
                }
              }
            }}
            onBlur={() => setRenaming(false)}
            className="w-full min-w-0 rounded-md border border-accent bg-surface px-1.5 outline-none ring-2 ring-accent/30"
          />
        ) : onOpen || feature ? (
          <button
            type="button"
            data-testid="plan-feature-open"
            data-feature={feature}
            title={`Open ${name}`}
            className="text-left hover:underline"
            onClick={() => {
              if (!onRename) return onOpen?.();
              window.clearTimeout(clickAt.current);
              clickAt.current = window.setTimeout(() => onOpen?.(), 220);
            }}
            onDoubleClick={() => {
              if (!onRename) return;
              window.clearTimeout(clickAt.current);
              setRenaming(true);
            }}
            onKeyDown={(e) => {
              if (e.key === 'F2' && onRename) {
                e.preventDefault();
                setRenaming(true);
              } else if ((e.key === 'Delete' || e.key === 'Backspace') && onDelete) {
                e.preventDefault();
                onDelete();
              }
            }}
          >
            {shown}
          </button>
        ) : (
          name
        )}
        {!gtCode(code) && <NotInGt />}
        {draft && (
          <span className="ml-1.5 inline-flex h-5 items-center rounded-full border border-line-strong px-1.5 align-[1px] text-xs font-[650] text-text2">
            Draft
          </span>
        )}
        {partOf && <span className="ml-1.5">{partOf}</span>}
      </span>
      {milestone && (
        <span className="flex flex-none gap-1 max-sm:order-last max-sm:basis-full max-sm:pl-[60px]">
          <span
            data-testid="task-milestone"
            className="inline-flex h-5 items-center whitespace-nowrap rounded-full bg-surface2 px-2 text-xs font-[650] text-text2"
          >
            {coded(milestone)}
          </span>
        </span>
      )}
      <span
        data-testid="plan-feature-total"
        className="min-w-[56px] flex-none text-right text-base tabular-nums text-text2"
      >
        {weeks}
      </span>
      {actions}
    </li>
  );
}

/**
 * The tasks of the goal buckets, for both views: which roadmap item a feature is, its form in
 * place while edited, "+ Add a feature" at a bucket's foot, and Cut from the roadmap's question.
 */
export function useBucketTasks({
  rows,
  plan,
  may,
  reload,
  setNote,
  setError,
}: {
  rows: Row[];
  plan: Schemas['SimplePlanOut'] | null | undefined;
  may: boolean;
  reload: () => Promise<void>;
  setNote: (n: Note | null) => void;
  setError: (e: string | null) => void;
}) {
  const items = useRoadmapItems();
  const [editing, setEditing] = useState<string | null>(null);
  const [cutting, setCutting] = useState<Task | null>(null);
  const writes = useTaskWrites(
    async () => {
      await Promise.all([reload(), items.reload()]);
    },
    setNote,
    setError,
  );
  const all = items.data?.items ?? [];
  // #1586 review: a roadmap that could not be read says why, never buckets whose features have no milestone or actions.
  const failed =
    items.error && !items.data ? (
      <LoadError what="the roadmap" error={items.error} onRetry={() => void items.reload()} />
    ) : null;
  const options = milestoneOptions(plan, all, items.data?.milestones);
  const itemOf = (t: Task) => all.find((i) => i.id === t.itemId);
  const live = (i: Item) => i.status !== 'cut' && i.status !== 'merged';
  /** The roadmap item a feature is: its ranked row's, else the live item of its key or name. */
  const taskOf = (code: string, name: string): Task | undefined => {
    const r = rowOf(rows, code, name);
    if (r?.item_id) return { itemId: r.item_id, code, name: r.title };
    const i = all.find(
      (x) => live(x) && (x.key.toLowerCase() === code.toLowerCase() || x.title === name),
    );
    return i ? { itemId: i.id, code, name: i.title } : undefined;
  };
  /** A plan feature whose roadmap item is cut (the plan still names it). */
  const isCut = (code: string, name: string) =>
    !taskOf(code, name) &&
    all.some(
      (x) => x.status === 'cut' && (x.key.toLowerCase() === code.toLowerCase() || x.title === name),
    );
  const startOf = (t: Task): TaskFields => {
    const i = itemOf(t);
    return {
      name: i?.title ?? t.name,
      outcome: i?.outcome ?? '',
      milestone: i?.milestone?.source === 'item' ? (i.milestone.name ?? '') : '',
    };
  };
  const form = (t: Task, goal: string): ReactNode | null =>
    editing === t.code ? (
      <TaskForm
        start={startOf(t)}
        milestones={options}
        title="Edit feature"
        goal={goal}
        onCancel={() => setEditing(null)}
        onSave={async (f) => {
          if (await writes.edit(t, itemOf(t), f, options)) setEditing(null);
        }}
      />
    ) : null;
  const actions = (t: Task | undefined): ReactNode =>
    may && t ? (
      <TaskActions
        name={t.name}
        disabled={!!editing}
        onEdit={() => setEditing(t.code)}
        onCut={() => setCutting(t)}
      />
    ) : null;
  /** "+ Add a feature" at the foot of a goal's bucket, or its form in place; off while the goal buckets load. */
  const add = (goal: { id: string; title: string } | undefined, loading = false): ReactNode => {
    if (!may || (!goal && !loading)) return null;
    if (!goal)
      return (
        <li data-testid="add-task" className="pt-1">
          <button
            type="button"
            className="mt-1 flex h-9 w-full items-center gap-1.5 rounded-lg border border-dashed border-line-strong px-3 text-left text-base font-[650] text-text2 disabled:opacity-40"
            disabled
          >
            + Add a feature
          </button>
        </li>
      );
    const key = `new:${goal.id}`;
    return (
      <li data-testid="add-task" className="pt-1">
        {editing === key ? (
          <TaskForm
            start={{ name: '', outcome: '', milestone: '' }}
            milestones={options}
            title="New feature"
            goal={goal.title}
            onCancel={() => setEditing(null)}
            onSave={async (f) => {
              if (await writes.add(goal, f, options)) setEditing(null);
            }}
          />
        ) : (
          <button
            type="button"
            className="mt-1 flex h-9 w-full items-center gap-1.5 rounded-lg border border-dashed border-line-strong px-3 text-left text-base font-[650] text-text2 hover:bg-surface2 disabled:opacity-40"
            onClick={() => setEditing(key)}
            disabled={!!editing}
          >
            + Add a feature
          </button>
        )}
      </li>
    );
  };
  const dialog = cutting ? (
    <CutDialog
      task={cutting}
      dependents={dependentsOf(rows, cutting.code)}
      onClose={() => setCutting(null)}
      onCut={async () => {
        if (await writes.cut(cutting, dependentsOf(rows, cutting.code))) setCutting(null);
      }}
    />
  ) : null;
  const milestoneName = (t: Task | undefined) => (t ? (itemOf(t)?.milestone?.name ?? null) : null);
  /** The task's own milestone (set in its form), beside the plan's milestones on its row. */
  const ownMilestone = (t: Task | undefined) => {
    const m = t ? itemOf(t)?.milestone : undefined;
    return m?.source === 'item' ? (m.name ?? null) : null;
  };
  /** A task carried to another goal's bucket (a draft: the goal buckets do not list it yet). */
  const move = (t: Task, to: { id: string; title: string }) => writes.move(t, itemOf(t), to);
  /** de-gm: a name typed in place: its outcome and milestone stay as they are. */
  const rename = (t: Task, name: string) =>
    void writes.edit(t, itemOf(t), { ...startOf(t), name }, options);
  const trash = useFeatureDelete(async () => {
    await Promise.all([reload(), items.reload()]);
  });
  /** de-gm: Delete moves it to Trash at once, with Undo in the note. */
  const remove = (t: Task) => void trash({ id: t.itemId, title: t.name, now: true });
  /** de-gm: a bucket's faint + Add: type, Enter adds a feature serving that goal; the field stays for the next. */
  const quick = (goal: { id: string; title: string } | undefined): ReactNode =>
    may && goal ? (
      <QuickAdd
        key={goal.id}
        onAdd={(name) => writes.add(goal, { name, outcome: '', milestone: '' }, options)}
      />
    ) : null;
  return {
    taskOf,
    isCut,
    form,
    actions,
    add,
    dialog,
    failed,
    undo: writes.undo,
    milestoneName,
    ownMilestone,
    move,
    editing,
    rename,
    remove,
    quick,
  };
}

function QuickAdd({ onAdd }: { onAdd: (name: string) => Promise<boolean> }) {
  const [open, setOpen] = useState(false);
  const [v, setV] = useState('');
  // Names typed and not yet back from the API, shown at once.
  const [pending, setPending] = useState<string[]>([]);
  return (
    <>
      {pending.map((n, i) => (
        <li
          key={`${n}-${i}`}
          data-testid="plan-feature-pending"
          aria-busy="true"
          className="border-b border-line py-[5px] text-base leading-[22px] opacity-60"
        >
          {n}
        </li>
      ))}
      <li
        data-testid="quick-add"
        className={
          open
            ? 'pt-1'
            : 'sr-only group-hover/bucket:not-sr-only group-focus-within/bucket:not-sr-only max-sm:not-sr-only'
        }
      >
        {open ? (
          <input
            autoFocus
            aria-label="Add a feature"
            data-testid="quick-add-input"
            value={v}
            onChange={(e) => setV(e.target.value)}
            onBlur={() => !v.trim() && setOpen(false)}
            onKeyDown={(e) => {
              const name = v.trim();
              if (e.key === 'Escape') {
                setV('');
                setOpen(false);
              } else if (e.key === 'Enter' && name) {
                setV('');
                setPending((xs) => [...xs, name]);
                void onAdd(name).finally(() =>
                  setPending((xs) => {
                    const i = xs.indexOf(name);
                    return i < 0 ? xs : [...xs.slice(0, i), ...xs.slice(i + 1)];
                  }),
                );
              }
            }}
            className="w-full min-w-0 rounded-md border border-accent bg-surface px-1.5 py-0.5 text-base outline-none ring-2 ring-accent/30"
          />
        ) : (
          <Button
            variant="ghost"
            data-testid="quick-add-open"
            className="h-7 justify-start px-1"
            onClick={() => setOpen(true)}
          >
            + Add
          </Button>
        )}
      </li>
    </>
  );
}
