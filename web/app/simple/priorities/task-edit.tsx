"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

import { api, type Schemas } from "@/lib/api/client";
import { errorMessage, useQuery } from "@/lib/use-query";

import { BTN, nextNoteId, type Note } from "./goal-buckets";

/*
 * Tasks in the goal buckets (the owner, Nov 4: "edit, delete, add in place new tasks"). A task is
 * a roadmap item under a goal. "+ Add a task" and a task's pencil open GB1 a's "Pencil, form in
 * place" (name, outcome, milestone); its ⋯ cuts it from the roadmap. Every write is a change of
 * the change engine (POST /v1/simple/changes: add_item, edit_title, edit_outcome, set_milestone,
 * cut), applied into the roadmap's working draft or proposed, as the rest of Simple does; an
 * applied one offers Undo.
 */

type Row = Schemas["SimplePriorityRow"];
type Item = Schemas["SimpleRoadmapItem"];
type ChangeIn = Schemas["SimpleChangeIn"];
type Change = Schemas["SimpleChangeOut"];

const PRIMARY = "inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-lg border border-transparent bg-accent px-3 text-[14px] font-[650] text-on-accent disabled:border-line-strong disabled:bg-surface2 disabled:text-text2";
const ICON = "inline-flex h-8 w-8 flex-none items-center justify-center rounded-lg border border-transparent text-[16px] text-text hover:border-line-strong hover:bg-surface2 disabled:opacity-40";
const INPUT = "h-9 w-full min-w-0 rounded-lg border border-line-strong bg-surface px-2.5 text-[15px] text-text";
const BAD = "h-9 w-full min-w-0 rounded-lg border-2 border-warn bg-surface px-2.5 text-[15px] text-text";
const MENU = "absolute right-0 top-9 z-30 w-64 rounded-lg border border-line bg-surface p-1 text-[15px] shadow-lg";
const ITEM = "flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-left hover:bg-surface2";

/** A task as the buckets show it: its roadmap item, its code and name. */
export type Task = { itemId: string; code: string; name: string };
export type TaskFields = { name: string; outcome: string; milestone: string };
export type MilestoneOption = { name: string; date: string | null };

/** The roadmap's items, for each task's outcome and milestone (the item panel reads the same). */
export function useRoadmapItems() {
  return useQuery("simple-roadmap:{}", async () => {
    const { data } = await api.GET("/v1/simple/roadmap", {});
    if (!data) throw new Error("Could not read the roadmap");
    return data;
  });
}

/** A task's row in the priorities: by its code, else its name. */
export function rowOf(rows: Row[], code: string, name: string): Row | undefined {
  const c = code.toLowerCase();
  return rows.find((r) => r.code.toLowerCase() === c || r.short_code.toLowerCase() === c) ?? rows.find((r) => r.title === name);
}

/** The milestones a task may be in: the plan's, the roadmap's, then those the roadmap's items name. */
export function milestoneOptions(plan: Schemas["SimplePlanOut"] | null | undefined, items: Item[], roadmap: Schemas["SimpleMilestone"][] = []): MilestoneOption[] {
  const out: MilestoneOption[] = (plan?.milestones ?? []).map((m) => ({ name: m.name, date: m.end_date ?? null }));
  for (const m of roadmap) if (!out.some((o) => o.name === m.name)) out.push({ name: m.name, date: m.date ?? null });
  for (const i of items) {
    const name = i.milestone?.name;
    if (name && !out.some((m) => m.name === name)) out.push({ name, date: i.milestone?.date ?? null });
  }
  return out;
}

function Field({ label, children, error }: { label: string; children: ReactNode; error?: string }) {
  return (
    <label className="block min-w-0">
      <span className="text-[13px] font-[650] text-text2">{label}</span>
      {children}
      {error && <span className="mt-0.5 block text-[13px] text-warn">{error}</span>}
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
  const set = (k: keyof TaskFields) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  const options = f.milestone && !milestones.some((m) => m.name === f.milestone) ? [...milestones, { name: f.milestone, date: null }] : milestones;
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
        if (e.key === "Escape") {
          e.stopPropagation();
          onCancel();
        }
      }}
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
        <h4 className="whitespace-nowrap text-[17px] font-[650]">{title}</h4>
        <span className="min-w-0 text-[13px] text-text2 max-sm:basis-full sm:ml-auto">Goal: {goal}</span>
      </div>
      <Field label="Name" error={!done ? "Name the task." : undefined}>
        <input autoFocus value={f.name} onChange={set("name")} placeholder="For example: Saved carts" className={done ? INPUT : BAD} />
      </Field>
      <Field label="Outcome: what changes for people">
        <textarea rows={2} value={f.outcome} onChange={set("outcome")} placeholder="For example: shoppers pick up where they left off" className={`${INPUT} h-auto py-1.5`} />
      </Field>
      <Field label="Milestone">
        <select value={f.milestone} onChange={set("milestone")} className={INPUT}>
          <option value="">No milestone</option>
          {options.map((m) => (
            <option key={m.name} value={m.name}>
              {m.name}
            </option>
          ))}
        </select>
      </Field>
      <div className="mt-1 flex items-center gap-2">
        <button type="submit" className={PRIMARY} disabled={!done || busy}>
          Save task
        </button>
        <button type="button" className={BTN} onClick={onCancel}>
          Cancel
        </button>
        {!done && <span className="min-w-0 text-[13px] text-text2">A task needs a name.</span>}
      </div>
    </form>
  );
}

/** A task's pencil and ⋯ (Edit task, Cut from the roadmap), for who may change it. */
export function TaskActions({ name, onEdit, onCut, disabled }: { name: string; onEdit: () => void; onCut: () => void; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", away);
    window.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", away);
      window.removeEventListener("keydown", esc);
    };
  }, [open]);
  return (
    <span ref={ref} data-testid="task-actions" className="relative flex flex-none items-center">
      <button type="button" aria-label={`Edit ${name}`} title="Edit task" className={`${ICON} h-7 w-7`} onClick={onEdit} disabled={disabled}>
        ✎
      </button>
      <button type="button" aria-label={`More for ${name}`} aria-haspopup="menu" aria-expanded={open} className={`${ICON} h-7 w-7 ${open ? "border-line-strong bg-surface2" : ""}`} onClick={() => setOpen((o) => !o)} disabled={disabled}>
        ⋯
      </button>
      {open && (
        <div role="menu" className={MENU}>
          <button
            type="button"
            role="menuitem"
            className={ITEM}
            onClick={() => {
              setOpen(false);
              onEdit();
            }}
          >
            Edit task
          </button>
          <button
            type="button"
            role="menuitem"
            className={`${ITEM} text-warn`}
            onClick={() => {
              setOpen(false);
              onCut();
            }}
          >
            Cut from the roadmap
          </button>
        </div>
      )}
    </span>
  );
}

/** "A, B and C". */
const andList = (xs: string[]) => (xs.length < 2 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

/** Cut from the roadmap asks first and names what depends on the task, as a cut does. */
export function CutDialog({ task, dependents, onClose, onCut }: { task: Task; dependents: string[]; onClose: () => void; onCut: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>("button")?.focus();
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [onClose]);
  return (
    <div data-backdrop="" className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-center sm:p-4" onClick={onClose}>
      <div ref={ref} role="dialog" aria-modal="true" aria-label={`Cut ${task.name}`} className="flex max-h-[88vh] w-full max-w-lg flex-col rounded-t-[var(--simple-card-radius)] border border-line bg-surface p-4 shadow-lg sm:rounded-[var(--simple-card-radius)]" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-[length:var(--simple-h2)] font-semibold leading-[var(--simple-h2-leading)]">Cut {task.name} from the roadmap?</h2>
        <p data-testid="cut-dependents" className={`mt-2 text-[15px] ${dependents.length ? "text-warn" : "text-text2"}`}>
          {dependents.length ? `⚠ ${andList(dependents)} ${dependents.length === 1 ? "depends" : "depend"} on it.` : "Nothing depends on it."}
        </p>
        <p className="mt-1 text-[15px] text-text2">It is not deleted: the roadmap keeps it as cut, and Undo brings it back.</p>
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
  const { data, error, response } = await api.POST("/v1/simple/changes", { body });
  if (response.ok && data) return data.change;
  const detail = (error as { detail?: unknown } | undefined)?.detail;
  throw new Refused(typeof detail === "string" ? detail : detail && typeof detail === "object" && "message" in detail ? String((detail as { message: unknown }).message) : response.statusText);
}

const milestoneOf = (name: string, options: MilestoneOption[]) => (name ? { name, date: options.find((m) => m.name === name)?.date ?? null, date_source: "typed" } : null);

/** What an edit's change is about, for the note naming those proposed. */
const PART: Record<string, string> = { edit_title: "the name", edit_outcome: "the outcome", set_milestone: "the milestone" };

/** The task writes: each applied one shows its note with Undo; a proposal says it waits for a decision. */
export function useTaskWrites(reload: () => Promise<void>, setNote: (n: Note | null) => void, setError: (e: string | null) => void) {
  async function run(go: () => Promise<Change[]>, done: string, proposed: string): Promise<boolean> {
    try {
      const made = await go();
      setError(null);
      const applied = made.filter((c) => c.status === "applied");
      const waiting = made.filter((c) => c.status !== "applied");
      const changes = applied.filter((c) => c.can_undo).map((c) => c.id);
      if (made.length && !applied.length) setNote({ id: nextNoteId(), text: <>{proposed}: it waits for a decision.</> });
      else if (waiting.length) {
        // Some applied, some proposed: the note names those proposed.
        const parts = [...new Set(waiting.map((c) => PART[c.op] ?? "a change"))];
        setNote({ id: nextNoteId(), text: <>{`${done} Proposed ${andList(parts)}: ${parts.length === 1 ? "it waits" : "they wait"} for a decision.`}</>, changes });
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
          await send({ op: "add_item", target: { where: { kind: "goal", value: goal.id } }, before: {}, after: { title: name, outcome: f.outcome.trim() || null, ...(milestone ? { milestone } : {}) } }),
        ],
        `Added ${name} to ${goal.title}.`,
        `Proposed adding ${name} to ${goal.title}`,
      );
    },
    edit: (task: Task, item: Item | undefined, f: TaskFields, options: MilestoneOption[]) => {
      const name = f.name.trim();
      const was = { title: item?.title ?? task.name, outcome: item?.outcome ?? "", milestone: item?.milestone?.source === "item" ? (item.milestone.name ?? "") : "" };
      const target = { item_id: task.itemId };
      const ins: ChangeIn[] = [];
      if (name !== was.title) ins.push({ op: "edit_title", target, before: { title: was.title }, after: { title: name } });
      if (f.outcome.trim() !== was.outcome.trim()) ins.push({ op: "edit_outcome", target, before: { outcome: item?.outcome ?? null }, after: { outcome: f.outcome.trim() || null } });
      if (f.milestone !== was.milestone) {
        const before = item?.milestone?.source === "item" && item.milestone.name ? { name: item.milestone.name, date: item.milestone.date ?? null } : null;
        ins.push({ op: "set_milestone", target, before: { milestone: before }, after: { milestone: milestoneOf(f.milestone, options) } });
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
        async () => [await send({ op: "set_goals", target: { item_id: task.itemId }, before: { goal_ids: was }, after: { goal_ids: [to.id, ...was.slice(1).filter((g) => g !== to.id)] } })],
        `Moved ${task.name} to ${to.title}.`,
        `Proposed moving ${task.name} to ${to.title}`,
      );
    },
    cut: (task: Task, dependents: string[]) =>
      run(
        async () => [await send({ op: "cut", target: { item_id: task.itemId }, before: { cut: false }, after: { cut: true } })],
        `Cut ${task.name} from the roadmap.${dependents.length ? ` ${andList(dependents)} ${dependents.length === 1 ? "depends" : "depend"} on it.` : ""}`,
        `Proposed cutting ${task.name}`,
      ),
    undo: async (ids: string[]) => {
      try {
        for (const id of [...ids].reverse()) {
          const { response, error } = await api.POST("/v1/simple/changes/{change_id}/undo", { params: { path: { change_id: id } } });
          if (!response.ok) throw new Error(String((error as { detail?: unknown } | undefined)?.detail ?? "Could not undo"));
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
  return rows.filter((r) => r.depends_on.some((d) => d.toLowerCase() === code.toLowerCase())).map((r) => r.title);
}

/** A code people know ("F-27"), not an item's raw key ("saved-carts"): a draft shows no chip until it has one. */
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
}: {
  code: string;
  name: string;
  milestone: string | null;
  weeks: string;
  draft?: boolean;
  /** Who may move it: its grip's handlers. */
  grip?: { onPointerDown: (e: React.PointerEvent) => void; onKeyDown: (e: React.KeyboardEvent) => void };
  lifted?: boolean;
  onOpen?: () => void;
  /** build-feature-panel: the feature its name opens in the one feature panel (its item id, else its key). */
  feature?: string;
  actions?: ReactNode;
  /** panel-menu: the feature it is part of ("part of Alert rules engine"), beside its name. */
  partOf?: ReactNode;
}) {
  return (
    <li
      data-testid="plan-feature"
      data-code={code}
      data-lifted={lifted ? "" : undefined}
      className={`relative flex items-center gap-2 border-b border-line py-[5px] text-[16px] leading-[22px] max-sm:flex-wrap max-sm:gap-y-1 ${lifted ? "[&>*]:opacity-30" : ""}`}
    >
      {grip && (
        <button
          type="button"
          data-testid="feature-grip"
          title="Drag to another goal"
          aria-label={`Move ${name} to another goal`}
          aria-describedby="bucket-move-help"
          className={`-mx-1 flex-none cursor-grab touch-none select-none rounded px-1 text-[15px] ${lifted ? "text-accent-ink" : "text-text2"}`}
          onPointerDown={grip.onPointerDown}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              grip.onKeyDown(e);
            }
          }}
        >
          ⠿
        </button>
      )}
      {(!draft || knownCode(code)) && (
        <span data-testid="prio-code" title={name} className="inline-block min-w-[3.25rem] flex-none whitespace-nowrap rounded-md border border-line-strong bg-surface px-1.5 text-center align-middle text-[13px] font-semibold leading-5 tabular-nums text-text">
          {code}
        </span>
      )}{" "}
      <span data-testid="plan-feature-name" className="min-w-0 flex-1">
        {onOpen || feature ? (
          <button type="button" data-testid="plan-feature-open" data-feature={feature} title={`Open ${name}`} className="text-left hover:underline" onClick={onOpen}>
            {name}
          </button>
        ) : (
          name
        )}
        {draft && <span className="ml-1.5 inline-flex h-5 items-center rounded-full border border-line-strong px-1.5 align-[1px] text-[12px] font-[650] text-text2">Draft</span>}
        {partOf && <span className="ml-1.5">{partOf}</span>}
      </span>
      {milestone && (
        <span className="flex flex-none gap-1 max-sm:order-last max-sm:basis-full max-sm:pl-[60px]">
          <span data-testid="task-milestone" className="inline-flex h-5 items-center whitespace-nowrap rounded-full bg-surface2 px-2 text-[12px] font-[650] text-text2">
            {milestone}
          </span>
        </span>
      )}
      <span data-testid="plan-feature-total" className="min-w-[56px] flex-none text-right text-[15px] tabular-nums text-text2">
        {weeks}
      </span>
      {actions}
    </li>
  );
}

/**
 * The tasks of the goal buckets, for both views: which roadmap item a feature is, its form in
 * place while edited, "+ Add a task" at a bucket's foot, and Cut from the roadmap's question.
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
  plan: Schemas["SimplePlanOut"] | null | undefined;
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
  const options = milestoneOptions(plan, all, items.data?.milestones);
  const itemOf = (t: Task) => all.find((i) => i.id === t.itemId);
  const live = (i: Item) => i.status !== "cut" && i.status !== "merged";
  /** The roadmap item a feature is: its ranked row's, else the live item of its key or name. */
  const taskOf = (code: string, name: string): Task | undefined => {
    const r = rowOf(rows, code, name);
    if (r?.item_id) return { itemId: r.item_id, code, name: r.title };
    const i = all.find((x) => live(x) && (x.key.toLowerCase() === code.toLowerCase() || x.title === name));
    return i ? { itemId: i.id, code, name: i.title } : undefined;
  };
  /** A plan feature whose roadmap item is cut (the plan still names it). */
  const isCut = (code: string, name: string) => !taskOf(code, name) && all.some((x) => x.status === "cut" && (x.key.toLowerCase() === code.toLowerCase() || x.title === name));
  const startOf = (t: Task): TaskFields => {
    const i = itemOf(t);
    return { name: i?.title ?? t.name, outcome: i?.outcome ?? "", milestone: i?.milestone?.source === "item" ? (i.milestone.name ?? "") : "" };
  };
  const form = (t: Task, goal: string): ReactNode | null =>
    editing === t.code ? (
      <TaskForm
        start={startOf(t)}
        milestones={options}
        title="Edit task"
        goal={goal}
        onCancel={() => setEditing(null)}
        onSave={async (f) => {
          if (await writes.edit(t, itemOf(t), f, options)) setEditing(null);
        }}
      />
    ) : null;
  const actions = (t: Task | undefined): ReactNode => (may && t ? <TaskActions name={t.name} disabled={!!editing} onEdit={() => setEditing(t.code)} onCut={() => setCutting(t)} /> : null);
  /** "+ Add a task" at the foot of a goal's bucket, or its form in place; off while the goal buckets load. */
  const add = (goal: { id: string; title: string } | undefined, loading = false): ReactNode => {
    if (!may || (!goal && !loading)) return null;
    if (!goal)
      return (
        <li data-testid="add-task" className="pt-1">
          <button type="button" className="mt-1 flex h-9 w-full items-center gap-1.5 rounded-lg border border-dashed border-line-strong px-3 text-left text-[15px] font-[650] text-text2 disabled:opacity-40" disabled>
            + Add a task
          </button>
        </li>
      );
    const key = `new:${goal.id}`;
    return (
      <li data-testid="add-task" className="pt-1">
        {editing === key ? (
          <TaskForm
            start={{ name: "", outcome: "", milestone: "" }}
            milestones={options}
            title="New task"
            goal={goal.title}
            onCancel={() => setEditing(null)}
            onSave={async (f) => {
              if (await writes.add(goal, f, options)) setEditing(null);
            }}
          />
        ) : (
          <button type="button" className="mt-1 flex h-9 w-full items-center gap-1.5 rounded-lg border border-dashed border-line-strong px-3 text-left text-[15px] font-[650] text-text2 hover:bg-surface2 disabled:opacity-40" onClick={() => setEditing(key)} disabled={!!editing}>
            + Add a task
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
    return m?.source === "item" ? (m.name ?? null) : null;
  };
  /** A task carried to another goal's bucket (a draft: the goal buckets do not list it yet). */
  const move = (t: Task, to: { id: string; title: string }) => writes.move(t, itemOf(t), to);
  return { taskOf, isCut, form, actions, add, dialog, undo: writes.undo, milestoneName, ownMilestone, move, editing };
}
