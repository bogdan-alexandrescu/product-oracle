"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

import { api, unwrap, type Schemas } from "@/lib/api/client";
import { calendarDay } from "@/lib/dates";
import { useMe } from "@/lib/me";
import { errorMessage, useQuery } from "@/lib/use-query";

import { CodeTag, goalLabel, milestoneColour, planFeatures, wk } from "./plan-buckets";

/*
 * Goal buckets you can change (the owner's picks of mk-goalbuckets: GB1 a "Pencil, form in place",
 * GB2 a "Pick where they go", GB3 a "Drag to a goal"). The goals, their measure, target and date,
 * and each feature's goal links come from /v1/simple/goal-buckets: the goal entities and the
 * "supports" links Baseline edits. Every write answers with what Undo puts back.
 */

type Plan = Schemas["SimplePlanOut"];
type Buckets = Schemas["GoalBucketsOut"];
type Goal = Schemas["GoalBucketGoal"];
type Undo = Schemas["GoalBucketsUndo"];

const BTN = "inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-lg border border-line-strong bg-surface px-3 text-[14px] font-[650] text-text hover:bg-surface2";
const PRIMARY = "inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-lg border border-transparent bg-accent px-3 text-[14px] font-[650] text-on-accent disabled:border-line-strong disabled:bg-surface2 disabled:text-text2";
// EG1 a (eg1-a-delete): Delete goal is drawn in the warning colour, as the frames do.
const DANGER = "inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-lg border border-transparent bg-warn px-3 text-[14px] font-[650] text-on-accent disabled:border-line-strong disabled:bg-surface2 disabled:text-text2";
const ICON = "inline-flex h-8 w-8 flex-none items-center justify-center rounded-lg border border-transparent text-[16px] text-text hover:border-line-strong hover:bg-surface2";
const INPUT = "h-9 w-full min-w-0 rounded-lg border border-line-strong bg-surface px-2.5 text-[15px] text-text";
const BAD = "h-9 w-full min-w-0 rounded-lg border-2 border-warn bg-surface px-2.5 text-[15px] text-text";
const MENU = "absolute right-0 top-9 z-30 w-64 rounded-lg border border-line bg-surface p-1 text-[15px] shadow-lg";
const ITEM = "flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-left hover:bg-surface2";

export const bucketsKey = "simple-goal-buckets";

/** The goals and links, for the buckets. */
export function useGoalBuckets() {
  return useQuery(bucketsKey, () => unwrap(api.GET("/v1/simple/goal-buckets")));
}

const same = (a: string, b: string) => goalLabel(a).name.toLowerCase() === goalLabel(b).name.toLowerCase();

/**
 * The plan as the goal links place it: each feature under the first goal it serves (its goal
 * links when it has them, else the one-pager's goal), the goals in the owner's order.
 */
export function placedPlan(plan: Plan, gb: Buckets | undefined): Plan {
  if (!gb?.goals.length) return plan;
  const titleOf = new Map(gb.goals.map((g) => [g.id, g.title]));
  const goalOf = (code: string, name: string, goal: string | null | undefined): string | null => {
    const f = featureOf(gb, code, name);
    if (f) return f.goal_ids.length ? (titleOf.get(f.goal_ids[0]) ?? null) : null;
    return goal ? (gb.goals.find((g) => same(g.title, goal))?.title ?? null) : null;
  };
  const slices = plan.slices.map((s) => ({ ...s, goal: goalOf(s.feature_code, s.name.replace(/, part \d+ of \d+$/, ""), s.goal) }));
  const weeks = new Map<string, number>();
  for (const s of slices) if (s.goal && s.effort_weeks != null) weeks.set(`${s.goal}|${s.milestone}`, (weeks.get(`${s.goal}|${s.milestone}`) ?? 0) + s.effort_weeks);
  return {
    ...plan,
    slices,
    goals: gb.goals.map((g) => plan.goals.find((x) => same(x.name, g.title)) ?? { name: g.title, targets: [], measured: null, on_track: null }).map((x, i) => ({ ...x, name: gb.goals[i].title })),
    goal_weeks: gb.goals.flatMap((g) => plan.milestones.flatMap((m) => (weeks.get(`${g.title}|${m.code}`) ? [{ goal: g.title, milestone: m.code, weeks: weeks.get(`${g.title}|${m.code}`)! }] : []))),
  };
}

function featureOf(gb: Buckets | undefined, code: string, name: string): { id: string; goal_ids: string[] } | undefined {
  const f = gb?.features.find((x) => x.key.toLowerCase() === code.toLowerCase() || x.title === name);
  return f ? { id: f.id, goal_ids: f.goal_ids ?? [] } : undefined;
}

/** "Dec 31" this year, "Feb 12, 2027" past it. */
function dayOf(iso: string | null | undefined, year: string): string {
  if (!iso) return "";
  return calendarDay(iso, iso.startsWith(year) ? { month: "short", day: "numeric" } : { month: "short", day: "numeric", year: "numeric" });
}

/** A typed day ("Mar 31, 2027", "2027-03-31") as YYYY-MM-DD, else null. */
function parseDay(text: string, year: string): string | null {
  const t = text.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  if (!t) return null;
  const d = new Date(/\d{4}/.test(t) ? t : `${t}, ${year}`);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** "A, B and C". */
const andList = (xs: string[]) => (xs.length < 2 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);
const count = (n: number) => `${n} ${n === 1 ? "feature" : "features"} in the plan`;
const lower = (s: string) => (/^[A-Z][a-z]/.test(s) ? s[0].toLowerCase() + s.slice(1) : s);

export function OrderBadge({ n }: { n: number }) {
  return (
    <span data-testid="goal-order" title={`Goal ${n} in the owner's order`} className="inline-flex h-6 min-w-6 flex-none items-center justify-center self-center rounded-full bg-surface2 px-1.5 text-[13px] font-[650] tabular-nums text-text2">
      {n}
    </span>
  );
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

type Fields = { title: string; measure: string; target: string; due: string; owner?: string | null };

/** The members a goal's owner is picked from (edit-goals-prds EG1). */
function usePeople() {
  return useQuery("simple-goal-owners", () => unwrap(api.GET("/v1/people", { params: { query: { limit: 200 } } })));
}

/** GB1 a: the goal's header turned into a small form, right where it sits. */
export function GoalForm({ start, order, title, year, onSave, onCancel }: { start: Fields; order: number; title: string; year: string; onSave: (f: Fields & { day: string }) => Promise<void>; onCancel: () => void }) {
  const [f, setF] = useState<Fields>(start);
  const [busy, setBusy] = useState(false);
  const day = parseDay(f.due, year);
  const done = !!(f.title.trim() && f.measure.trim() && f.target.trim() && day);
  const set = (k: keyof Fields) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  return (
    <form
      data-testid="goal-form"
      className="grid gap-2"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!done || busy) return;
        setBusy(true);
        try {
          await onSave({ ...f, day: day! });
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
        <OrderBadge n={order} />
        <h3 className="whitespace-nowrap text-[17px] font-[650]">{title}</h3>
        <span className="text-[13px] text-text2 max-sm:basis-full sm:ml-auto">Goal {order} in the order; change it in Baseline</span>
      </div>
      <Field label="Goal" error={!f.title.trim() ? "Name the goal." : undefined}>
        <textarea autoFocus rows={f.title.length > 60 ? 2 : 1} value={f.title} onChange={set("title")} className={`${INPUT} h-auto py-1.5`} />
      </Field>
      <Field label="Measure: the number that shows it" error={!f.measure.trim() ? "Add a measure." : undefined}>
        <input value={f.measure} onChange={set("measure")} placeholder="For example: repeat orders a month" className={f.measure.trim() ? INPUT : BAD} />
      </Field>
      <div className="grid grid-cols-2 gap-2">
        <Field label="Target" error={!f.target.trim() ? "Add a target." : undefined}>
          <input value={f.target} onChange={set("target")} className={f.target.trim() ? INPUT : BAD} />
        </Field>
        <Field label="By" error={!day ? "Pick a date." : undefined}>
          <input type="text" value={f.due} onChange={set("due")} placeholder="Pick a day" className={day ? INPUT : BAD} />
        </Field>
      </div>
      <OwnerField value={f.owner ?? null} onChange={(owner) => setF((x) => ({ ...x, owner }))} />
      <div className="mt-1 flex items-center gap-2">
        <button type="submit" className={PRIMARY} disabled={!done || busy}>
          Save goal
        </button>
        <button type="button" className={BTN} onClick={onCancel}>
          Cancel
        </button>
        {!done && <span className="min-w-0 text-[13px] text-text2">A goal needs a measure, a target and a date.</span>}
      </div>
    </form>
  );
}

/** EG1 a (eg1-a-owner): the goal's owner, one of the members. */
function OwnerField({ value, onChange }: { value: string | null; onChange: (id: string | null) => void }) {
  const people = usePeople();
  const list = people.data ?? [];
  return (
    <Field label="Owner">
      <select value={value ?? ""} onChange={(e) => onChange(e.target.value || null)} className={INPUT}>
        {(!value || !list.some((x) => x.user_id === value)) && <option value="">{value ? "Someone else" : "No owner"}</option>}
        {list.map((x) => (
          <option key={x.user_id} value={x.user_id}>
            {x.name}
          </option>
        ))}
      </select>
    </Field>
  );
}

/** The note above the buckets after a change, with Undo. */
export function UndoNote({ children, onUndo }: { children: ReactNode; onUndo?: () => void }) {
  return (
    <div role="status" data-testid="bucket-note" className="z-30 mt-4 flex shadow-md sm:sticky sm:top-2 max-sm:fixed max-sm:inset-x-3 max-sm:bottom-[calc(76px+env(safe-area-inset-bottom))] items-center gap-3 rounded-lg border border-accent bg-accent-soft px-4 py-2.5 text-[15px] text-text">
      <span className="min-w-0 flex-1">{children}</span>
      {onUndo && (
        <button type="button" className="flex-none font-[650] text-accent-ink underline" onClick={onUndo}>
          Undo
        </button>
      )}
    </div>
  );
}

/** The dragged feature's card. */
export function DragGhost({ code, name, weeks, style, className = "" }: { code: string | null; name: string; weeks: string; style?: React.CSSProperties; className?: string }) {
  return (
    <div aria-hidden data-testid="drag-ghost" className={`pointer-events-none fixed z-40 flex w-[420px] max-w-[80vw] rotate-[-1.5deg] items-center gap-2 rounded-md border-2 border-accent bg-surface px-2 py-[5px] text-[16px] shadow-2xl ${className}`} style={style}>
      <span className="text-[15px]">⠿</span>
      {code && <CodeTag code={code} />}
      <span className="flex-1">{name}</span>
      <span className="text-[15px] text-text2">{weeks}</span>
    </div>
  );
}

type Feature = ReturnType<typeof planFeatures>[number];

/** A feature's rows in its bucket: grip (who may move), code, name (+n goals), named milestone chips, weeks. */
export function FeatureRows({
  plan,
  goal,
  gb,
  grips,
  lifted,
  onGrip,
  onOpen,
  task,
  tail,
}: {
  plan: Plan;
  goal: string | null;
  gb: Buckets | undefined;
  grips: boolean;
  lifted: string | null;
  onGrip: (f: Feature, e: React.PointerEvent | React.KeyboardEvent) => void;
  /** The feature's name opens its item panel (the grip only moves it). */
  onOpen?: (f: Feature) => void;
  /** Tasks in place: a feature's shown name (renamed on the roadmap), whether it is cut, its pencil and ⋯, and its form while edited. */
  task?: { name: (f: Feature) => string; cut: (f: Feature) => boolean; actions: (f: Feature) => ReactNode; form: (f: Feature) => ReactNode | null; milestone: (f: Feature) => string | null };
  /** Rows after the plan's: tasks added since, and "+ Add a task". */
  tail?: ReactNode;
}) {
  const features = planFeatures(plan, goal)
    .filter((f) => !task?.cut(f))
    .map((f) => (task ? { ...f, name: task.name(f) } : f));
  if (!features.length && !tail) return <p className="mt-2 text-[15px] text-text2">Nothing in the plan yet</p>;
  const titleOf = (id: string) => gb?.goals.find((g) => g.id === id)?.title;
  return (
    <ul className="mt-2">
      {!features.length && <li className="py-[5px] text-[15px] text-text2">Nothing in the plan yet</li>}
      {features.map((f) => {
        const form = task?.form(f);
        if (form)
          return (
            <li key={f.code} data-testid="plan-feature" data-code={f.code} className="border-b border-line">
              {form}
            </li>
          );
        const links = featureOf(gb, f.code, f.name)?.goal_ids ?? [];
        const others = links.slice(1).map(titleOf).filter((x): x is string => !!x);
        const milestones = [...new Set(f.slices.map((s) => s.milestone))];
        const movable = grips && !!featureOf(gb, f.code, f.name);
        const up = lifted === f.code;
        // Its own milestone, unless a plan chip already names it.
        const mine = task?.milestone(f) ?? null;
        const own = mine && !milestones.some((code) => plan.milestones.find((m) => m.code === code)?.name === mine) ? mine : null;
        return (
          <li
            key={f.code}
            data-testid="plan-feature"
            data-code={f.code}
            data-lifted={up ? "" : undefined}
            className={`relative flex items-center gap-2 border-b border-line py-[5px] text-[16px] leading-[22px] max-sm:flex-wrap max-sm:gap-y-1 ${up ? "[&>*]:opacity-30" : ""}`}
          >
            {movable && (
              <button
                type="button"
                data-testid="feature-grip"
                title="Drag to another goal"
                aria-label={`Move ${f.name} to another goal`}
                aria-describedby="bucket-move-help"
                className={`-mx-1 flex-none cursor-grab touch-none select-none rounded px-1 text-[15px] ${up ? "text-accent-ink" : "text-text2"}`}
                onPointerDown={(e) => onGrip(f, e)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onGrip(f, e);
                  }
                }}
              >
                ⠿
              </button>
            )}
            <CodeTag code={f.code} title={f.name} />{" "}
            <span data-testid="plan-feature-name" className="min-w-0 flex-1">
              {onOpen ? (
                <button type="button" data-testid="plan-feature-open" title={`Open ${f.name}`} className="text-left hover:underline" onClick={() => onOpen(f)}>
                  {f.name}
                </button>
              ) : (
                f.name
              )}
              {others.length > 0 && (
                <span data-testid="also-goals" title={`Also serves ${others.join(", ")}`} className="ml-1.5 inline-flex h-5 items-center whitespace-nowrap rounded-full border border-line-strong px-1.5 align-[1px] text-[12px] font-[650] text-text2">
                  +{others.length} {others.length === 1 ? "goal" : "goals"}
                </span>
              )}
            </span>
            <span className="flex flex-none gap-1 max-sm:order-last max-sm:basis-full max-sm:pl-[60px]">
              {milestones.map((code) => {
                const c = milestoneColour(plan, code);
                const name = plan.milestones.find((m) => m.code === code)?.name ?? "";
                const of = f.slices.filter((x) => x.milestone === code);
                const weeks = of.every((x) => x.pm_owned || x.effort_weeks == null) ? "PM-owned" : `${wk(of.reduce((n, x) => n + (x.effort_weeks ?? 0), 0))} wk`;
                return (
                  <span key={code} data-testid="plan-chip" title={`${code} ${name}: ${weeks}`} className="inline-flex h-5 items-center gap-1 whitespace-nowrap rounded-full px-2 text-[12px] font-[650]" style={{ background: c.tag, color: c.ink }}>
                    <span>{code}</span> <span>{name}</span>
                  </span>
                );
              })}
              {own && (
                <span data-testid="task-milestone" title={`Its own milestone: ${own}`} className="inline-flex h-5 items-center whitespace-nowrap rounded-full bg-surface2 px-2 text-[12px] font-[650] text-text2">
                  {own}
                </span>
              )}
            </span>
            <span data-testid="plan-feature-total" className="min-w-[56px] flex-none text-right text-[15px] tabular-nums text-text2">
              {f.weeks == null ? "PM-owned" : `${wk(f.weeks)} wk`}
            </span>
            {task?.actions(f)}
          </li>
        );
      })}
      {tail}
    </ul>
  );
}

/** GB2 a: Archive goal asks first, and says where the goal's features go. */
/** A goal's features as ArchiveDialog counts them: the plan's, or with no dated plan the bucket's. */
export type GoalFeatures = (goal: string) => { code: string; name: string; slices: Plan["slices"] }[];

/**
 * EG1 a: the same question for Delete goal (eg1-a-hard: it goes to Settings > Trash first), and,
 * for who may not archive or delete, an ask (`ask`: whom it goes to, eg1-a-propose).
 */
export function ArchiveDialog({ goal, plan, featuresOf, gb, onClose, onArchive, kind = "archive", ask }: { goal: Goal; plan: Plan | null; featuresOf?: GoalFeatures; gb: Buckets; onClose: () => void; onArchive: (to: string | null) => Promise<void>; kind?: "archive" | "delete"; ask?: string[] | null }) {
  const [mode, setMode] = useState<"move" | "none">("move");
  const [to, setTo] = useState("");
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const listOf: GoalFeatures = (title) => (plan ? planFeatures(plan, title) : (featuresOf?.(title) ?? []));
  const list = listOf(goal.title);
  const others = gb.goals.filter((g) => g.id !== goal.id);
  const titleOf = (id: string) => gb.goals.find((g) => g.id === id)?.title ?? "";
  const multi = list.filter((f) => (featureOf(gb, f.code, f.name)?.goal_ids ?? []).some((g) => g !== goal.id));
  const rest = list.length - multi.length;
  const ms = [...new Set(list.flatMap((f) => f.slices.map((s) => s.milestone)))].sort();
  const msLabel = (code: string) => `${code} ${plan?.milestones.find((m) => m.code === code)?.name ?? ""}`.trim();
  const feats = `${list.length} ${list.length === 1 ? "feature" : "features"}`;
  const picked = mode === "none" || !!to || rest === 0;
  const holds = to ? listOf(titleOf(to)).length + rest : 0;
  const verb = kind === "delete" ? "Delete" : "Archive";
  const heading = ask ? `Ask to ${verb.toLowerCase()}` : verb;
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>("select, button")?.focus();
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [onClose]);
  return (
    <div data-backdrop="" className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-center sm:p-4" onClick={onClose}>
      <div ref={ref} role="dialog" aria-modal="true" aria-label={`${heading} ${goal.title}`} className="flex max-h-[88vh] w-full max-w-lg flex-col overflow-y-auto rounded-t-[var(--simple-card-radius)] border border-line bg-surface p-4 shadow-lg sm:rounded-[var(--simple-card-radius)]" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-[length:var(--simple-h2)] font-semibold leading-[var(--simple-h2-leading)]">
          {heading} {goal.title}?
        </h2>
        {kind === "delete" && <p className="mt-1 text-[15px] text-text">It goes to Settings &gt; Trash for 30 days.</p>}
        <p className="mt-1 text-[15px] text-text2">
          {!plan
            ? list.length
              ? `It holds ${feats}.`
              : "It holds no features."
            : list.length
              ? `It holds ${feats} with work in ${andList(ms.map(msLabel))}. The milestones stay as planned; their work moves with the features.`
              : "It holds no features in the plan. The milestones stay as planned."}
        </p>
        {list.length > 0 && (
          <div className="mt-3 grid gap-2 text-[15px]">
            {multi.length > 0 && (
              <p>
                {multi.length} {multi.length === 1 ? "serves" : "serve"} another goal too and {multi.length === 1 ? "goes" : "go"} there:{" "}
                <span className="text-text2">{multi.map((f) => `${f.name} → ${titleOf(featureOf(gb, f.code, f.name)!.goal_ids.find((g) => g !== goal.id)!)}`).join("; ")}</span>
              </p>
            )}
            {rest > 0 && (
              <>
                <p className="font-[650]">The other {rest}:</p>
                <label className="flex flex-wrap items-center gap-2">
                  <input type="radio" name="archive-to" checked={mode === "move"} onChange={() => setMode("move")} className="h-4 w-4 accent-[var(--accent)]" /> <span className="whitespace-nowrap">Move to</span>
                  <select
                    aria-label="Goal"
                    value={to}
                    onChange={(e) => {
                      setTo(e.target.value);
                      setMode("move");
                    }}
                    className={`h-8 min-w-0 max-w-full rounded-lg border px-2 text-[14px] max-sm:basis-full ${to ? "border-2 border-accent" : "border-warn"} bg-surface`}
                  >
                    {!to && <option value="">Pick a goal</option>}
                    {others.map((g) => (
                      <option key={g.id} value={g.id}>
                        {g.order} · {g.title.length > 40 ? `${g.title.slice(0, 38)}…` : g.title}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex items-center gap-2">
                  <input type="radio" name="archive-to" checked={mode === "none"} onChange={() => setMode("none")} className="h-4 w-4 accent-[var(--accent)]" /> Leave them with no goal (they show under No goal)
                </label>
                {mode === "move" && to && (
                  <p className="rounded-lg bg-accent-soft px-3 py-2 text-accent-ink">
                    {titleOf(to)} will hold {holds} features.{ask ? "" : " Undo puts every link back."}
                  </p>
                )}
              </>
            )}
          </div>
        )}
        <div className="mt-3 flex items-center gap-2">
          <button
            type="button"
            className={kind === "delete" && !ask ? DANGER : PRIMARY}
            disabled={!picked || busy}
            onClick={async () => {
              setBusy(true);
              try {
                await onArchive(mode === "move" && to ? to : null);
              } finally {
                setBusy(false);
              }
            }}
          >
            {ask ? `Send to ${andList(ask) || "an owner"}` : `${verb} goal`}
          </button>
          <button type="button" className={BTN} onClick={onClose}>
            Cancel
          </button>
          {!picked && <span className="text-[13px] text-text2">Pick where they go.</span>}
        </div>
      </div>
    </div>
  );
}

/** "do": the person archives or deletes; "ask": they ask whoever may (Ask to archive, Ask to delete); null: neither. */
export type Act = "do" | "ask" | null;

/** The ⋯ menu on a goal (eg1-a-open): Edit goal, Archive goal, Delete goal; Ask to archive and Ask to delete for who may not. */
export function GoalMenu({ title, onEdit, onArchive, onDelete, archive, del = null }: { title: string; onEdit?: () => void; onArchive: () => void; onDelete?: () => void; archive: Act | boolean; del?: Act }) {
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
  const arch: Act = archive === true ? "do" : archive || null;
  const items: [string, () => void][] = [];
  if (onEdit) items.push(["Edit goal", onEdit]);
  if (arch) items.push([arch === "do" ? "Archive goal" : "Ask to archive", onArchive]);
  if (del && onDelete) items.push([del === "do" ? "Delete goal" : "Ask to delete", onDelete]);
  if (!items.length) return null;
  return (
    <span ref={ref} className="relative">
      <button type="button" aria-label={`More for ${title}`} aria-haspopup="menu" aria-expanded={open} className={`${ICON} ${open ? "border-line-strong bg-surface2" : ""}`} onClick={() => setOpen((o) => !o)}>
        ⋯
      </button>
      {open && (
        <div role="menu" className={MENU}>
          {items.map(([label, go]) => (
            <button
              key={label}
              type="button"
              role="menuitem"
              className={`${ITEM} ${label === "Delete goal" ? "text-warn" : ""}`}
              onClick={() => {
                setOpen(false);
                go();
              }}
            >
              {label}
            </button>
          ))}
        </div>
      )}
    </span>
  );
}

type Archived = Schemas["ArchivedGoal"];

/**
 * EG1 a (eg1-a-result, eg1-a-readonly): archived goals in an "Archived goals" fold at the end of
 * the buckets, newest first, each with its owner and the day it was archived, Restore and Delete;
 * for who may not, Ask to restore alone (eg1-a-propose).
 */
export function ArchivedGoals({ gb, year, open, onToggle, restore, del, onRestore, onDelete }: { gb: Buckets; year: string; open: boolean; onToggle: (open: boolean) => void; restore: Act; del: Act; onRestore: (g: Archived) => void; onDelete: (g: Archived) => void }) {
  const list = gb.archived ?? [];
  if (!list.length) return null;
  return (
    <li data-testid="archived-goals" className="rounded-[var(--simple-card-radius)] border border-line bg-surface sm:col-span-2">
      <details open={open} onToggle={(e) => onToggle((e.target as HTMLDetailsElement).open)}>
        <summary className="cursor-pointer px-4 py-3 text-[17px] font-[650]">
          Archived goals <span className="font-normal text-text2">· {list.length}</span>
        </summary>
        <ul className="border-t border-line px-4">
          {list.map((g) => (
            <li key={g.id} data-testid="archived-goal" data-goal-id={g.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line py-2.5 last:border-b-0">
              <span className="min-w-0 font-[650]">{g.title}</span>
              <span className="text-[14px] text-text2">{[g.owner_name, g.archived_at && `archived ${dayOf(g.archived_at.slice(0, 10), year)}`].filter(Boolean).join(" · ")}</span>
              <span className="flex-1" />
              {restore && (
                <button type="button" className={BTN} onClick={() => onRestore(g)}>
                  {restore === "do" ? "Restore" : "Ask to restore"}
                </button>
              )}
              {del === "do" && (
                <button type="button" className={`${BTN} text-warn`} onClick={() => onDelete(g)}>
                  Delete
                </button>
              )}
            </li>
          ))}
        </ul>
      </details>
    </li>
  );
}

/** EG1 a (eg1-a-delete): Delete on an archived goal asks once more; it holds no features now. */
export function DeleteArchivedDialog({ goal, onClose, onDelete }: { goal: Archived; onClose: () => void; onDelete: () => Promise<void> }) {
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
      <div ref={ref} role="dialog" aria-modal="true" aria-label={`Delete ${goal.title}`} className="w-full max-w-lg rounded-t-[var(--simple-card-radius)] border border-line bg-surface p-4 shadow-lg sm:rounded-[var(--simple-card-radius)]" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-[length:var(--simple-h2)] font-semibold leading-[var(--simple-h2-leading)]">
          Delete {goal.title}?
        </h2>
        <p className="mt-1 text-[15px] text-text">It goes to Settings &gt; Trash for 30 days.</p>
        <div className="mt-3 flex items-center gap-2">
          <button
            type="button"
            className={DANGER}
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await onDelete();
              } finally {
                setBusy(false);
              }
            }}
          >
            Delete goal
          </button>
          <button type="button" className={BTN} onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * A task change (./task-edit) names the changes Undo takes back, in the order they were made; a
 * goal's delete, its Trash entry and the Undo for its links (`restore`).
 */
export type Note = { text: ReactNode; undo?: Undo; changes?: string[]; restore?: Restore };
type Restore = { entry: string; title: string; undo?: Undo | null };

/** The writes, each answering with the note to show and what Undo puts back. */
export function useBucketWrites(reload: () => Promise<void>, setNote: (n: Note | null) => void, setError: (e: string | null) => void) {
  async function run(go: () => Promise<{ undo: Undo }>, text: ReactNode): Promise<boolean> {
    try {
      const out = await go();
      setError(null);
      setNote({ text, undo: out.undo });
      await reload();
      return true;
    } catch (e) {
      setError(errorMessage(e));
      return false;
    }
  }
  return {
    add: (f: Fields & { day: string }, order: number) =>
      run(() => unwrap(api.POST("/v1/simple/goal-buckets/goals", { body: { title: f.title, measure: f.measure, target: f.target, due: f.day, ...(f.owner !== undefined ? { owner_id: f.owner } : {}) } })), <>Added {f.title.trim()} as goal {order}.</>),
    edit: (g: Goal, f: Fields & { day: string }, year: string) =>
      run(
        () => unwrap(api.PATCH("/v1/simple/goal-buckets/goals/{goal_id}", { params: { path: { goal_id: g.id } }, body: { title: f.title, measure: f.measure, target: f.target, due: f.day, ...(f.owner !== undefined ? { owner_id: f.owner } : {}) } })),
        <>
          Saved {f.title.trim()}: {lower(f.target.trim())} by {dayOf(f.day, year)}.
        </>,
      ),
    archive: (g: Goal, to: string | null, text: ReactNode) => run(() => unwrap(api.POST("/v1/simple/goal-buckets/goals/{goal_id}/archive", { params: { path: { goal_id: g.id } }, body: { to_goal_id: to } })), text),
    // EG1 a: Restore an archived goal (with Undo), Delete a goal to Settings > Trash, and an ask for who may not.
    unarchive: (g: { id: string; title: string }) => run(() => unwrap(api.POST("/v1/simple/goal-buckets/goals/{goal_id}/unarchive", { params: { path: { goal_id: g.id } } })), <>Restored {g.title}.</>),
    remove: async (g: { id: string; title: string }, to: string | null, text: ReactNode): Promise<boolean> => {
      try {
        const out = await unwrap(api.DELETE("/v1/simple/goal-buckets/goals/{goal_id}", { params: { path: { goal_id: g.id }, query: to ? { to_goal_id: to } : {} } }));
        setError(null);
        // Undo restores it from Trash, then puts back the links it moved.
        setNote({ text, restore: out.entry && out.can_restore ? { entry: out.entry.id, title: g.title, undo: out.undo } : undefined });
        await reload();
        return true;
      } catch (e) {
        setError(errorMessage(e));
        return false;
      }
    },
    ask: async (op: "archive_goal" | "delete_goal" | "unarchive_goal", g: { id: string; title: string }, to: string | null, askTo: string[]): Promise<boolean> => {
      try {
        await unwrap(api.POST("/v1/simple/changes", { body: { op, target: { goal_id: g.id, to_goal_id: to }, before: {}, after: {} } }));
        setError(null);
        setNote({ text: <>Sent to {andList(askTo) || "an owner"}: {{ archive_goal: "archive", delete_goal: "delete", unarchive_goal: "restore" }[op]} {g.title}.</> });
        return true;
      } catch (e) {
        setError(errorMessage(e));
        return false;
      }
    },
    move: (feature: string, from: string | null, to: string, text: ReactNode) =>
      run(() => unwrap(api.POST("/v1/simple/goal-buckets/features/{feature_id}/move", { params: { path: { feature_id: feature } }, body: { from_goal_id: from, to_goal_id: to } })), text),
    restore: async (r: Restore) => {
      try {
        await unwrap(api.POST("/v1/trash/{entry_id}/restore", { params: { path: { entry_id: r.entry } } }));
        if (r.undo) await unwrap(api.POST("/v1/simple/goal-buckets/undo", { body: r.undo }));
        setError(null);
        setNote({ text: <>Undone: {r.title} and its links are back.</> });
      } catch (e) {
        setError(errorMessage(e));
      }
      await reload();
    },
    undo: async (u: Undo) => {
      try {
        await unwrap(api.POST("/v1/simple/goal-buckets/undo", { body: u }));
        setNote({ text: <>Undone: every goal and link is back as it was.</> });
        await reload();
      } catch (e) {
        setError(errorMessage(e));
      }
    },
  };
}

export { BTN, andList, dayOf, featureOf, count };

/** Who may do what (can(), never a role name). */
export function useBucketRights(gb: Buckets | undefined) {
  const { can } = useMe();
  return {
    add: !!gb && can("create_bucket_goal"),
    edit: (g: Goal | undefined) => !!g && g.can_edit && can("update_bucket_goal"),
    archive: !!gb && can("archive_bucket_goal"),
    // EG1 a: Archive and Delete for who may, an ask through the change engine for who may not.
    archiveAct: (!gb ? null : can("archive_bucket_goal") ? "do" : can("create_simple_change") ? "ask" : null) as Act,
    deleteAct: (!gb ? null : can("delete_bucket_goal") ? "do" : can("create_simple_change") ? "ask" : null) as Act,
    unarchive: !!gb && can("unarchive_bucket_goal"),
    // eg1-a-propose: Restore for who may, Ask to restore for who may not.
    unarchiveAct: (!gb ? null : can("unarchive_bucket_goal") ? "do" : can("create_simple_change") ? "ask" : null) as Act,
    move: !!gb && can("move_bucket_feature"),
    // Tasks: the change engine applies or proposes, by the roadmap's own rule.
    task: can("create_simple_change"),
  };
}
