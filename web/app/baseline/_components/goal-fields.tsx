"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";

import { Button, InfoTip, InspectorSection, Notice, SegmentedControl } from "@/components/ds";
import { INPUT, Loading } from "@/components/ui";
import { api, unwrap, type EntityDetail, type EntityOut, type Schemas } from "@/lib/api/client";
import { calendarDay } from "@/lib/dates";
import { useMe } from "@/lib/me";
import { errorMessage, useQuery } from "@/lib/use-query";

/**
 * B5 Typed goal fields: how a goal's typed attrs read (the Goals table's cells, the edit
 * form's fields) and its dated measurements. The checks are the API's; the form shows each
 * problem it reports under the field it is about.
 */

type Attrs = Record<string, unknown>;
type Person = Schemas["PersonOut"];
export type GoalProblem = Schemas["GoalProblem"];

export const COMPARISONS = [
  { value: "at_least", label: "At least", symbol: "≥" },
  { value: "above", label: "More than", symbol: ">" },
  { value: "at_most", label: "At most", symbol: "≤" },
  { value: "below", label: "Less than", symbol: "<" },
] as const;

/** The Unit select: the API's units, then "Count of…" for a counted noun. */
export const UNITS = [
  { value: "%", label: "%" },
  { value: "USD", label: "$" },
  { value: "EUR", label: "€" },
  { value: "GBP", label: "£" },
  { value: "ms", label: "ms" },
  { value: "s", label: "s" },
  { value: "min", label: "min" },
  { value: "h", label: "h" },
  { value: "days", label: "days" },
] as const;
const CURRENCY: Record<string, string> = { USD: "$", EUR: "€", GBP: "£" };
export const COUNT = "count";

export const HORIZONS = [
  { value: "short", label: "Short" },
  { value: "medium", label: "Medium" },
  { value: "long", label: "Long" },
] as const;
/** The company's planning_horizons (Settings › Company); B2's defaults until set. */
export type PlanningHorizons = { short_quarters: number; medium_quarters: number; long_from_months: number; long_to_months: number };
export const DEFAULT_HORIZONS: PlanningHorizons = { short_quarters: 1, medium_quarters: 2, long_from_months: 12, long_to_months: 24 };
const QUARTERS = ["", "", "two", "three", "four"];

/** "Short: this quarter · Medium: the next two quarters · Long: 12–24 months", by the company's horizons. */
export function horizonTip(h: PlanningHorizons | null | undefined): string {
  const { short_quarters: s, medium_quarters: m, long_from_months: from, long_to_months: to } = h ?? DEFAULT_HORIZONS;
  const short = s === 1 ? "this quarter" : s === 2 ? "this quarter and the next" : `this quarter and the next ${s - 1}`;
  const medium = m === 1 ? "the next quarter" : `the next ${QUARTERS[m] ?? m} quarters`;
  return `Short: ${short} · Medium: ${medium} · Long: ${from}–${to} months`;
}
export const WEIGHT_TIP = "How much this goal counts in priority scores, relative to the others";

const isNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const compact = (n: number) => {
  for (const [s, v] of [["B", 1e9], ["M", 1e6], ["k", 1e3]] as const) if (Math.abs(n) >= v) return `${Math.round((n / v) * 10) / 10}${s}`;
  return `${n}`;
};

/** A value in its unit: "45%", "$4M", "2 min", "400 teams". */
export function figure(value: number, unit: string): string {
  if (unit === "%") return `${value}%`;
  if (CURRENCY[unit]) return `${CURRENCY[unit]}${compact(value)}`;
  return `${value} ${unit}`;
}

/** The typed target, as symbol and figure ("≥ 45%") and in words ("At least 45%"); null when not typed. */
export function typedTarget(attrs: Attrs): { short: string; words: string } | null {
  const c = COMPARISONS.find((x) => x.value === attrs.comparison);
  if (!c || !isNumber(attrs.target) || typeof attrs.unit !== "string" || !attrs.unit) return null;
  const f = figure(attrs.target, attrs.unit);
  return { short: `${c.symbol} ${f}`, words: `${c.label} ${f}` };
}

/** "Dec 31" from 2026-12-31. */
export const shortDay = (iso: string): string => calendarDay(iso);

/** "Short · Dec 31"; null when the goal has no typed horizon. */
export function horizonLabel(attrs: Attrs): string | null {
  const h = HORIZONS.find((x) => x.value === attrs.horizon);
  if (!h) return null;
  return typeof attrs.due === "string" ? `${h.label} · ${shortDay(attrs.due)}` : h.label;
}

/**
 * A target still written as words, in the table's one form (qa-plan-24): "below 8%" reads
 * "< 8%", "at least 45%" reads "≥ 45%", as a typed target does. Other text is shown as written.
 */
export function targetText(text: string): string {
  const t = text.trim();
  const words: [RegExp, string][] = [
    [/^(?:at least|no less than|min(?:imum)?\.?)\s+/i, "≥ "],
    [/^(?:at most|no more than|max(?:imum)?\.?|up to)\s+/i, "≤ "],
    [/^(?:below|under|less than|lower than|fewer than)\s+/i, "< "],
    [/^(?:above|over|more than|greater than|higher than)\s+/i, "> "],
  ];
  for (const [rx, symbol] of words) if (rx.test(t)) return t.replace(rx, symbol);
  return t;
}

/**
 * The goal's gap, named plainly (qa-plan-9): a goal with its metric and target that only lacks
 * an owner reads "No owner", not "Not measurable".
 */
export function gapLabel(check: Schemas["GoalCheck"] | null | undefined): "No owner" | "Not measurable" {
  const missing = check?.missing ?? [];
  return missing.length > 0 && missing.every((k) => k === "owner") ? "No owner" : "Not measurable";
}

/** The Not measurable chip's tooltip: "Missing: target, owner". */
export const missingTip = (check: Schemas["GoalCheck"] | null | undefined) => `Missing: ${(check?.missing ?? []).join(", ")}`;

/** Goals with a `*_text` value whose typed field is absent: what Fill from text reads. */
export function fillable(goals: EntityOut[]): number {
  return goals.filter((g) =>
    Object.keys(g.attrs ?? {}).some((k) => k.endsWith("_text") && k !== "owner_text" && g.attrs?.[k.slice(0, -5)] == null),
  ).length;
}

/** What Fill from text did, in one sentence. */
export function fillNotice(r: Schemas["FillFromTextResult"]): string {
  const left = new Set(r.left_as_text.map((x) => x.entity_id)).size;
  const n = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`;
  const parts = [
    r.applied > 0 && `${n(r.applied, "goal", "goals")} filled`,
    r.proposed > 0 && `${n(r.proposed, "proposal", "proposals")} made (${r.proposed === 1 ? "the goal is" : "the goals are"} locked)`,
    left > 0 && `${n(left, "goal", "goals")} left as text`,
  ].filter(Boolean);
  return parts.length ? `${parts.join(", ")}.` : "Nothing to fill: no goal text could be read.";
}

/** Members by id, from GET /v1/people (a removed member keeps their name but is marked). */
export function useOwners(ids: string[]) {
  const key = [...new Set(ids)].sort().join(",");
  const named = useQuery(`people-ids:${key}`, () =>
    key ? unwrap(api.GET("/v1/people", { params: { query: { ids: key.split(",") } } })) : Promise.resolve([] as Person[]),
  );
  const active = useQuery(`people-active:${key}`, () =>
    key ? unwrap(api.GET("/v1/people", { params: { query: { limit: 100 } } })) : Promise.resolve([] as Person[]),
  );
  const out = new Map<string, { name: string; email: string; removed: boolean }>();
  if (!named.data || !active.data) return out;
  const live = new Set(active.data.map((p) => p.user_id));
  for (const p of named.data) out.set(p.user_id, { name: p.name, email: p.email, removed: active.data.length < 100 && !live.has(p.user_id) });
  return out;
}

/** The Owner cell: the member's name (email in the tooltip), "Removed member", or "—". */
export function OwnerName({ id, owners }: { id: unknown; owners: Map<string, { name: string; email: string; removed: boolean }> }) {
  if (typeof id !== "string" || !id) return <span data-attr="owner" className="text-text2">—</span>;
  const o = owners.get(id);
  if (!o) return <span data-attr="owner" className="text-text2">…</span>;
  if (o.removed) {
    return (
      <span data-attr="owner" className="text-text2" title={`${o.name} (${o.email}) is no longer a member: pick a new owner`}>
        Removed member
      </span>
    );
  }
  return (
    <span data-attr="owner" title={o.email} className="truncate">
      {o.name}
    </span>
  );
}

const LABEL = "flex min-w-0 flex-col gap-1 text-[13px] font-semibold tracking-[0.02em] text-text2";

/** A problem the API reports, under the field it is about. */
function FieldError({ field, problems }: { field: string; problems: GoalProblem[] }) {
  const mine = problems.filter((p) => p.where === `attrs.${field}`);
  if (mine.length === 0) return null;
  return (
    <span role="alert" data-testid={`field-error-${field}`} className="text-[13px] font-medium tracking-normal text-crit">
      {mine.map((p) => p.message).join(" ")}
    </span>
  );
}

/** The goal owner: members of this Oracle only, searched by name or email (GET /v1/people). */
function OwnerPicker({ value, onChange }: { value: string | null; onChange: (id: string | null) => void }) {
  const { can } = useMe();
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const owners = useOwners(value ? [value] : []);
  const results = useQuery(`people-search:${q}`, () => unwrap(api.GET("/v1/people", { params: { query: { q: q.trim(), limit: 20 } } })), {
    keepPrevious: true,
  });
  const picked = value ? owners.get(value) : undefined;
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      {value && (
        <span className="flex min-w-0 items-center gap-2 text-[15px] font-normal tracking-normal text-text" data-testid="owner-picked">
          <span className="min-w-0 truncate">
            {picked ? (picked.removed ? "Removed member" : picked.name) : "…"}
            {picked && <span className="text-text2"> · {picked.email}</span>}
          </span>
          <Button variant="ghost" onClick={() => onChange(null)} aria-label="Clear owner">
            Clear
          </Button>
        </span>
      )}
      <input
        className={INPUT}
        type="search"
        aria-label="Owner"
        placeholder="Search members by name or email"
        value={q}
        onFocus={() => setOpen(true)}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
        }}
      />
      {open && (q.trim() || results.data) && (
        <div className="flex min-w-0 flex-col gap-1">
          <ul role="listbox" aria-label="Members" className="flex max-h-48 min-w-0 flex-col overflow-y-auto rounded-lg border border-line">
            {(q.trim() ? (results.data ?? []).filter((p) => matches(p, q)) : (results.data ?? [])).map((p) => (
              <li
                key={p.user_id}
                role="option"
                aria-selected={p.user_id === value}
                tabIndex={0}
                onClick={() => {
                  onChange(p.user_id);
                  setQ("");
                  setOpen(false);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onChange(p.user_id);
                    setQ("");
                    setOpen(false);
                  }
                }}
                className="flex min-w-0 cursor-pointer flex-col px-2.5 py-1.5 text-[15px] font-normal tracking-normal text-text hover:bg-surface2 focus:bg-surface2"
              >
                <span className="truncate font-medium">{p.name}</span>
                <span className="truncate text-sm text-text2">{p.email}</span>
              </li>
            ))}
          </ul>
          <p data-testid="owner-invite" className="text-[13px] font-normal tracking-normal text-text2">
            {can("create_invite") ? (
              <>
                Not a member yet?{" "}
                <Link href="/settings/members?invite=1" className="font-medium text-accent-ink hover:underline">
                  Invite them first
                </Link>
              </>
            ) : (
              "An owner invites new members on Settings › Members."
            )}
          </p>
        </div>
      )}
    </div>
  );
}

/** The API matches on email; the picker also matches the shown name. */
const matches = (p: Person, q: string) => {
  const n = q.trim().toLowerCase();
  return p.email.toLowerCase().includes(n) || p.name.toLowerCase().includes(n);
};

export type GoalDraft = {
  metric: string;
  comparison: string;
  target: string;
  unit: string;
  noun: string;
  start: string;
  horizon: string;
  due: string;
  owner: string | null;
  weight: string;
};

const str = (v: unknown) => (v == null ? "" : String(v));

export function goalDraft(attrs: Attrs): GoalDraft {
  const unit = str(attrs.unit);
  const known = !unit || UNITS.some((u) => u.value === unit);
  return {
    metric: str(attrs.metric),
    comparison: str(attrs.comparison),
    target: str(attrs.target),
    unit: known ? unit : COUNT,
    noun: known ? "" : unit,
    start: str(attrs.start),
    horizon: str(attrs.horizon),
    due: str(attrs.due),
    owner: typeof attrs.owner === "string" ? attrs.owner : null,
    weight: str(attrs.weight),
  };
}

/** The draft as attrs for PATCH: only what changed; an emptied field is removed (null). */
export function goalPatch(draft: GoalDraft, attrs: Attrs): Attrs {
  const num = (s: string) => (s.trim() === "" ? null : Number(s));
  const text = (s: string) => (s.trim() === "" ? null : s.trim());
  const next: Attrs = {
    metric: text(draft.metric),
    comparison: text(draft.comparison),
    target: num(draft.target),
    unit: draft.unit === COUNT ? text(draft.noun.toLowerCase()) : text(draft.unit),
    start: num(draft.start),
    horizon: text(draft.horizon),
    due: text(draft.due),
    owner: draft.owner,
    weight: num(draft.weight),
  };
  const out: Attrs = {};
  for (const [k, v] of Object.entries(next)) if (JSON.stringify(v ?? null) !== JSON.stringify(attrs[k] ?? null)) out[k] = v;
  return out;
}

/** The goal's typed fields in the edit form, in the spec's order, each with its problems underneath. */
export function GoalFields({
  draft,
  onChange,
  problems,
  horizons,
}: {
  draft: GoalDraft;
  onChange: (d: GoalDraft) => void;
  problems: GoalProblem[];
  /** The company's horizons, from the goal's goal_check. */
  horizons?: PlanningHorizons | null;
}) {
  const set = (patch: Partial<GoalDraft>) => onChange({ ...draft, ...patch });
  return (
    <>
      <label className={LABEL}>
        Metric
        <input
          className={INPUT}
          value={draft.metric}
          placeholder="What is counted, e.g. accounts that finish setup in 7 days"
          onChange={(e) => set({ metric: e.target.value })}
        />
        <FieldError field="metric" problems={problems} />
      </label>
      <fieldset className="flex min-w-0 flex-col gap-1">
        <legend className="mb-1 text-[13px] font-semibold tracking-[0.02em] text-text2">Target</legend>
        <div className="grid min-w-0 grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,1fr)] gap-2">
          <label className={LABEL}>
            Comparison
            <select className={INPUT} value={draft.comparison} onChange={(e) => set({ comparison: e.target.value })}>
              <option value="">—</option>
              {COMPARISONS.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>
          <label className={LABEL}>
            Value
            <input className={INPUT} inputMode="decimal" value={draft.target} onChange={(e) => set({ target: e.target.value })} />
          </label>
          <label className={LABEL}>
            Unit
            <select className={INPUT} value={draft.unit} onChange={(e) => set({ unit: e.target.value })}>
              <option value="">—</option>
              {UNITS.map((u) => (
                <option key={u.value} value={u.value}>
                  {u.label}
                </option>
              ))}
              <option value={COUNT}>Count of…</option>
            </select>
          </label>
        </div>
        {draft.unit === COUNT && (
          <label className={LABEL}>
            Counted noun
            <input className={INPUT} value={draft.noun} placeholder="e.g. teams, clinics" onChange={(e) => set({ noun: e.target.value })} />
          </label>
        )}
        <FieldError field="target" problems={problems} />
        <FieldError field="comparison" problems={problems} />
        <FieldError field="unit" problems={problems} />
      </fieldset>
      <label className={LABEL}>
        Start value
        <input className={INPUT} inputMode="decimal" value={draft.start} onChange={(e) => set({ start: e.target.value })} />
        <FieldError field="start" problems={problems} />
      </label>
      <div className="flex min-w-0 flex-wrap items-end gap-3">
        <div className={LABEL}>
          <span className="flex items-center gap-1.5">
            Horizon <InfoTip label="horizons">{horizonTip(horizons)}</InfoTip>
          </span>
          <SegmentedControl
            label="Horizon"
            size="sm"
            items={HORIZONS.map((h) => ({ value: h.value, label: h.label }))}
            value={draft.horizon || null}
            onChange={(v) => set({ horizon: v === draft.horizon ? "" : v })}
          />
          <FieldError field="horizon" problems={problems} />
        </div>
        <label className={`${LABEL} min-w-[9rem] flex-1`}>
          Due
          <input className={INPUT} type="date" value={draft.due} onChange={(e) => set({ due: e.target.value })} />
          <FieldError field="due" problems={problems} />
        </label>
      </div>
      <div className={LABEL}>
        <span>Owner</span>
        <OwnerPicker value={draft.owner} onChange={(owner) => set({ owner })} />
        <FieldError field="owner" problems={problems} />
      </div>
      <label className={LABEL}>
        <span className="flex items-center gap-1.5">
          Weight <InfoTip label="weight">{WEIGHT_TIP}</InfoTip>
        </span>
        <input
          className={INPUT}
          type="number"
          min={0.1}
          max={10}
          step={0.1}
          value={draft.weight}
          onChange={(e) => set({ weight: e.target.value })}
        />
        <FieldError field="weight" problems={problems} />
      </label>
      {problems
        .filter((p) => p.where === "attrs.current" || p.where === "attrs.current_as_of")
        .map((p) => (
          <Notice key={`${p.code}:${p.where}`} tone="error">
            {p.message}: record a value under Measurements.
          </Notice>
        ))}
    </>
  );
}

/** The 422 body's problems, when the API refused goal fields. */
export function problemsOf(error: unknown): GoalProblem[] | null {
  const errors = (error as { errors?: unknown } | null)?.errors;
  return Array.isArray(errors) ? (errors as GoalProblem[]) : null;
}

/** A small line chart of the last 12 measurements, oldest first. */
function MeasurementChart({ rows, unit }: { rows: Schemas["MeasurementOut"][]; unit: string }) {
  const pts = [...rows].slice(0, 12).reverse();
  if (pts.length === 0) return null;
  const w = 240;
  const h = 56;
  const vs = pts.map((p) => p.value);
  const lo = Math.min(...vs);
  const span = Math.max(...vs) - lo || 1;
  const xy = pts.map((p, i) => [pts.length === 1 ? w / 2 : 6 + (i * (w - 12)) / (pts.length - 1), h - 6 - ((p.value - lo) / span) * (h - 12)]);
  return (
    <svg viewBox={`0 0 ${w} ${h}`} role="img" aria-label="Measurements" className="h-auto w-full max-w-[320px]">
      <title>{pts.map((p) => `${figure(p.value, unit)} on ${shortDay(p.measured_on)}`).join(", ")}</title>
      <polyline points={xy.map(([x, y]) => `${x},${y}`).join(" ")} fill="none" stroke="var(--accent)" strokeWidth={2} />
      {xy.map(([x, y], i) => (
        <circle key={pts[i].id} cx={x} cy={y} r={2.5} fill="var(--accent)" />
      ))}
    </svg>
  );
}

/** Goal drawer › Measurements: chart, list, Record value and Delete (approvers). */
export function Measurements({ goal, canWrite, onChanged }: { goal: EntityDetail; canWrite: boolean; onChanged: () => void }) {
  const q = useQuery(`goal-measurements:${goal.id}`, () =>
    unwrap(api.GET("/v1/baseline/entities/{entity_id}/measurements", { params: { path: { entity_id: goal.id } } })),
  );
  const [recording, setRecording] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const unit = typeof goal.attrs?.unit === "string" ? goal.attrs.unit : "";
  const rows = q.data ?? [];

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await q.reload();
      onChanged();
      return true;
    } catch (e) {
      setError(errorMessage(e));
      return false;
    } finally {
      setBusy(false);
    }
  }

  return (
    <InspectorSection
      label="Measurements"
      testId="goal-measurements"
      tools={
        canWrite &&
        !recording && (
          <Button onClick={() => setRecording(true)} disabled={busy || !unit} title={unit ? undefined : "Give the goal its unit first"}>
            Record value
          </Button>
        )
      }
    >
      <div className="flex min-w-0 flex-col gap-2">
        {error && <Notice tone="error">{error}</Notice>}
        {recording && (
          <RecordForm
            busy={busy}
            onCancel={() => setRecording(false)}
            onSave={async (body) => {
              const ok = await run(() =>
                unwrap(api.POST("/v1/baseline/entities/{entity_id}/measurements", { params: { path: { entity_id: goal.id } }, body })),
              );
              if (ok) setRecording(false);
            }}
          />
        )}
        {q.loading && !q.data ? (
          <Loading />
        ) : rows.length === 0 ? (
          <p className="text-text2">{unit ? "No values recorded yet" : "Give the goal its unit, then record values here"}</p>
        ) : (
          <>
            <MeasurementChart rows={rows} unit={unit} />
            <ul className="flex flex-col gap-1" aria-label="Measured values">
              {rows.map((r) => (
                <li key={r.id} data-testid="measurement-row" className="flex min-h-8 min-w-0 flex-wrap items-center gap-2 text-sm">
                  <span className="tnum min-w-0 flex-1 truncate">
                    <b className="font-semibold">{figure(r.value, unit)}</b> · {shortDay(r.measured_on)}
                    {r.note && <span className="text-text2"> · {r.note}</span>}
                  </span>
                  {canWrite &&
                    (deleting === r.id ? (
                      <span className="flex items-center gap-1.5">
                        <Button
                          variant="solid"
                          disabled={busy}
                          onClick={() => void run(() => unwrap(api.DELETE("/v1/baseline/measurements/{measurement_id}", { params: { path: { measurement_id: r.id } } }))).then(() => setDeleting(null))}
                        >
                          Delete value
                        </Button>
                        <Button variant="ghost" disabled={busy} onClick={() => setDeleting(null)}>
                          Keep
                        </Button>
                      </span>
                    ) : (
                      <Button variant="ghost" disabled={busy} aria-label={`Delete ${figure(r.value, unit)} of ${shortDay(r.measured_on)}`} onClick={() => setDeleting(r.id)}>
                        Delete
                      </Button>
                    ))}
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </InspectorSection>
  );
}

function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function RecordForm({
  busy,
  onCancel,
  onSave,
}: {
  busy: boolean;
  onCancel: () => void;
  onSave: (body: Schemas["MeasurementCreate"]) => void;
}) {
  const [value, setValue] = useState("");
  const [on, setOn] = useState(todayIso);
  const [note, setNote] = useState("");
  const [invalid, setInvalid] = useState<string | null>(null);
  function submit(e: FormEvent) {
    e.preventDefault();
    const n = Number(value);
    if (value.trim() === "" || !Number.isFinite(n)) return setInvalid("The value is a number");
    if (!on) return setInvalid("Pick the day it was measured");
    onSave({ value: n, measured_on: on, note: note.trim() || null });
  }
  return (
    <form onSubmit={submit} aria-label="Record value" className="flex min-w-0 flex-col gap-2 rounded-lg border border-line p-2.5">
      <div className="grid min-w-0 grid-cols-2 gap-2">
        <label className={LABEL}>
          Value
          <input className={INPUT} inputMode="decimal" value={value} onChange={(e) => {
              setValue(e.target.value);
              setInvalid(null);
            }} />
        </label>
        <label className={LABEL}>
          Measured on
          <input className={INPUT} type="date" max={todayIso()} value={on} onChange={(e) => {
              setOn(e.target.value);
              setInvalid(null);
            }} />
        </label>
      </div>
      <label className={LABEL}>
        Note
        <input className={INPUT} value={note} onChange={(e) => setNote(e.target.value)} />
      </label>
      {invalid && <Notice tone="error">{invalid}</Notice>}
      <div className="flex gap-2">
        <Button type="submit" variant="solid" disabled={busy}>
          Save
        </Button>
        <Button onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
