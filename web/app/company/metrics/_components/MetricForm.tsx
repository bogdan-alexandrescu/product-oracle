"use client";

import { useRef, useState, type FormEvent } from "react";

import { Button, useFocusTrap } from "@/components/ds";
import { ErrorNote, INPUT } from "@/components/ui";
import { api, unwrap, type Schemas } from "@/lib/api/client";
import { displayName } from "@/lib/names";
import { errorMessage } from "@/lib/use-query";

import { SOURCE_LABEL, UNITS, valueText, weekText, type Metric } from "./lib";

export type Goal = Schemas["EntityOut"];
export type Person = Schemas["PersonOut"];

const LABEL = "flex flex-col gap-1 text-sm font-semibold text-text2";
const FIELD_ERROR = "text-[13px] font-medium text-crit";
const COUNT = "count";

type Field = "title" | "description" | "unit" | "drives" | "owner" | "query" | "threshold";

/**
 * qa-company-8: the word after a required field's label. Screen readers hear it from the
 * field's aria-required instead; the field is named by its label word alone (aria-labelledby).
 */
function Required() {
  return (
    <span aria-hidden="true" className="font-normal text-text2">
      {" "}
      (required)
    </span>
  );
}

/** qa-company-8: a field's problem, in plain words, right under the field (its aria-describedby). */
function FieldError({ field, errors }: { field: Field; errors: Partial<Record<Field, string>> }) {
  const text = errors[field];
  if (!text) return null;
  return (
    <span id={`metric-${field}-error`} data-testid={`metric-error-${field}`} className={FIELD_ERROR}>
      {text}
    </span>
  );
}

/**
 * Add metric, or Edit one (approvers and owners): title, what it counts, kind, unit, good
 * direction, the output an input drives, the goal an output reads (confirmed goals with the
 * same unit, not read by another metric), owner, source, a PostHog query with Test (the last
 * 4 weeks' values or the provider's error), and an optional threshold. Kind and source are
 * fixed once added.
 */
export function MetricForm({
  metric,
  metrics,
  goals,
  people,
  onClose,
  onSaved,
}: {
  metric: Metric | null;
  metrics: Metric[];
  goals: Goal[];
  people: Person[];
  onClose: () => void;
  onSaved: (m: Metric) => void;
}) {
  const panel = useRef<HTMLDivElement>(null);
  useFocusTrap(panel, true, onClose);
  const [title, setTitle] = useState(metric?.title ?? "");
  const [description, setDescription] = useState(metric?.description ?? "");
  const [kind, setKind] = useState<Metric["kind"]>(metric?.kind ?? "output");
  // qa4-company-39: a unit from the list, or "Count of…" and the counted noun typed in.
  const [unitPick, setUnitPick] = useState(!metric?.unit || UNITS.includes(metric.unit) ? (metric?.unit ?? "") : COUNT);
  const [noun, setNoun] = useState(metric?.unit && !UNITS.includes(metric.unit) ? metric.unit : "");
  const unit = unitPick === COUNT ? noun : unitPick;
  const [direction, setDirection] = useState<Metric["direction"]>(metric?.direction ?? "up");
  const [drives, setDrives] = useState(metric?.drives_metric_id ?? "");
  const [goal, setGoal] = useState(metric?.goal_id ?? "");
  const [owner, setOwner] = useState(metric?.owner_id ?? "");
  const [source, setSource] = useState<Metric["source"]>(metric?.source ?? "posthog");
  const [query, setQuery] = useState(metric?.query ?? "");
  const [threshold, setThreshold] = useState(metric?.threshold_pct != null ? String(metric.threshold_pct) : "");
  const [tested, setTested] = useState<Schemas["MetricTestOut"] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // After the first Add or Save, each field's problem shows under it until it is fixed.
  const [tried, setTried] = useState(false);

  const outputs = metrics.filter((m) => m.kind === "output" && m.status !== "archived" && m.id !== metric?.id);
  const taken = new Set(metrics.filter((m) => m.goal_id && m.status !== "archived" && m.id !== metric?.id).map((m) => m.goal_id));
  const goalUnit = (g: Goal) => (typeof g.attrs.unit === "string" ? g.attrs.unit : null);
  const goalChoices = goals.filter((g) => g.status === "confirmed" && !taken.has(g.id) && goalUnit(g) === unit.trim());
  // The goal the select shows, and the one Save sends: none once the picked goal is no longer a
  // choice (another unit, or no longer confirmed).
  const goalId = goalChoices.some((g) => g.id === goal) ? goal : "";

  async function test() {
    setBusy(true);
    setError(null);
    try {
      setTested(await unwrap(api.POST("/v1/metrics/test", { body: { query } })));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  /** qa-company-8: every missing or wrong field at once, before anything is sent. */
  function check(): Partial<Record<Field, string>> {
    const out: Partial<Record<Field, string>> = {};
    if (!title.trim()) out.title = "Give the metric a title.";
    const d = description.trim().length;
    if (d === 0) out.description = "Say what the metric counts.";
    else if (d < 3) out.description = "Write at least 3 characters.";
    if (!unit.trim()) out.unit = unitPick === COUNT ? "Name what is counted, such as teams." : "Give a unit, such as % or teams.";
    if (kind === "input" && !drives) out.drives = "Pick the output this input drives.";
    if (!owner) out.owner = "Pick who explains its changes.";
    if (source === "posthog" && !query.trim()) out.query = "Write the query Oracle runs each week.";
    if (threshold.trim()) {
      const n = Number(threshold);
      if (!Number.isFinite(n) || n < 1 || n > 500) out.threshold = "Write a number from 1 to 500, or leave it empty.";
    }
    return out;
  }
  const errors = tried ? check() : {};

  async function submit(e: FormEvent) {
    e.preventDefault();
    const found = check();
    setTried(true);
    if (Object.keys(found).length > 0) {
      setError(null);
      const first = Object.keys(found)[0];
      panel.current?.querySelector<HTMLElement>(`[data-field="${first}"]`)?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    const pct = threshold.trim() ? Number(threshold) : null;
    const fields = {
      title: title.trim(),
      description: description.trim(),
      unit: unit.trim(),
      direction,
      goal_id: kind === "output" && goalId ? goalId : null,
      drives_metric_id: kind === "input" && drives ? drives : null,
      owner_id: owner,
      query: source === "posthog" ? query : null,
      threshold_pct: pct,
    };
    try {
      const saved = metric
        ? await unwrap(api.PATCH("/v1/metrics/{metric_id}", { params: { path: { metric_id: metric.id } }, body: { ...fields, lock_version: metric.lock_version } }))
        : await unwrap(api.POST("/v1/metrics", { body: { ...fields, kind, source } }));
      onSaved(saved);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const name = metric ? "Edit metric" : "Add metric";
  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-hero/50 px-4 py-10 max-[600px]:px-2 max-[600px]:py-4">
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby="metric-form-title"
        tabIndex={-1}
        className="w-full max-w-2xl min-w-0 rounded-inspector border border-line bg-surface text-text shadow-tip outline-none"
      >
        <div className="flex min-h-14 items-center gap-2 border-b border-line px-5 max-[600px]:px-4">
          <h2 id="metric-form-title" className="font-display text-xl font-bold tracking-heading">
            {name}
          </h2>
        </div>
        <form className="flex flex-col gap-3 px-5 py-4 max-[600px]:px-4" onSubmit={submit} noValidate>
          <p className="text-[13px] text-text2">Fields marked (required) must be filled in.</p>
          <label className={LABEL}>
            <span>
              <span id="metric-title-label">Title</span>
              <Required />
            </span>
            <input
              data-autofocus
              data-field="title"
              aria-labelledby="metric-title-label"
              aria-required="true"
              className={INPUT}
              value={title}
              maxLength={120}
              aria-invalid={!!errors.title}
              aria-describedby={errors.title ? "metric-title-error" : undefined}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Weekly active teams"
            />
            <FieldError field="title" errors={errors} />
          </label>
          <label className={LABEL}>
            <span>
              <span id="metric-description-label">What it counts</span>
              <Required />
            </span>
            <input
              data-field="description"
              aria-labelledby="metric-description-label"
              aria-required="true"
              className={INPUT}
              value={description}
              maxLength={200}
              aria-invalid={!!errors.description}
              aria-describedby={errors.description ? "metric-description-error" : undefined}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Teams with 3 or more sessions in the week"
            />
            <FieldError field="description" errors={errors} />
          </label>
          <div className="grid grid-cols-3 gap-3 max-[600px]:grid-cols-1">
            <div className={LABEL}>
              <label htmlFor="metric-kind">Kind</label>
              <select
                id="metric-kind"
                aria-describedby="metric-kind-help"
                className={INPUT}
                value={kind}
                disabled={!!metric}
                onChange={(e) => setKind(e.target.value as Metric["kind"])}
              >
                <option value="output">Output: a result</option>
                <option value="input">Input: a lever</option>
              </select>
            </div>
            {/* qa4-company-39: a select like Kind and Good direction (the goal editor's units), then "Count of…" for a counted noun. */}
            <label className={LABEL}>
              <span>
                <span id="metric-unit-label">Unit</span>
                <Required />
              </span>
              <select
                data-field={unitPick === COUNT ? undefined : "unit"}
                aria-labelledby="metric-unit-label"
                aria-required="true"
                className={INPUT}
                value={unitPick}
                aria-invalid={!!errors.unit && unitPick !== COUNT}
                aria-describedby={errors.unit && unitPick !== COUNT ? "metric-unit-error" : undefined}
                onChange={(e) => setUnitPick(e.target.value)}
              >
                <option value="">Pick a unit</option>
                {UNITS.map((u) => (
                  <option key={u} value={u}>
                    {u}
                  </option>
                ))}
                <option value={COUNT}>Count of…</option>
              </select>
              {unitPick !== COUNT && <FieldError field="unit" errors={errors} />}
            </label>
            <label className={LABEL}>
              Good direction
              <select className={INPUT} value={direction} onChange={(e) => setDirection(e.target.value as Metric["direction"])}>
                <option value="up">Up</option>
                <option value="down">Down</option>
              </select>
            </label>
          </div>
          {unitPick === COUNT && (
            <label className={LABEL}>
              <span id="metric-noun-label">Count of what</span>
              <input
                data-field="unit"
                aria-labelledby="metric-noun-label"
                aria-required="true"
                className={INPUT}
                value={noun}
                maxLength={40}
                aria-invalid={!!errors.unit}
                aria-describedby={errors.unit ? "metric-unit-error" : undefined}
                onChange={(e) => setNoun(e.target.value)}
                placeholder="teams or accounts"
              />
              <FieldError field="unit" errors={errors} />
            </label>
          )}
          {/* qa-company-39: Output and Input in plain words. */}
          <p id="metric-kind-help" data-testid="metric-kind-help" className="-mt-1 text-[13px] text-text2">
            {kind === "output"
              ? "An output is a result the company wants, such as paying customers. It can keep a goal's value up to date."
              : "An input is a number the team can move directly, such as invites sent. It sits under the output it drives."}
          </p>
          {kind === "input" ? (
            <label className={LABEL}>
              <span>
                <span id="metric-drives-label">Drives</span>
                <Required />
              </span>
              <select
                data-field="drives"
                aria-labelledby="metric-drives-label"
                aria-required="true"
                className={INPUT}
                value={drives}
                aria-invalid={!!errors.drives}
                aria-describedby={errors.drives ? "metric-drives-error" : undefined}
                onChange={(e) => setDrives(e.target.value)}
              >
                <option value="">Pick the output it drives</option>
                {outputs.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.title}
                  </option>
                ))}
              </select>
              <FieldError field="drives" errors={errors} />
            </label>
          ) : (
            <div className={LABEL}>
              <label htmlFor="metric-goal">Goal</label>
              <select
                id="metric-goal"
                aria-describedby="metric-goal-help"
                className={INPUT}
                value={goalId}
                onChange={(e) => setGoal(e.target.value)}
              >
                {/* qa4-company-38: the help line under it says why the list is empty; the option does not repeat it. */}
                <option value="">No goal</option>
                {goalChoices.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.title}
                  </option>
                ))}
              </select>
              {/* qa-company-40: an empty list says why. */}
              <span id="metric-goal-help" data-testid="metric-goal-help" className="text-[13px] font-normal">
                {goalChoices.length
                  ? "Confirmed goals measured in the same unit. The latest weekly value becomes the goal’s current value."
                  : unit.trim()
                    ? `No confirmed goal is measured in ${unit.trim()} yet.`
                    : "Pick a unit to see goals measured in it."}
              </span>
            </div>
          )}
          <label className={LABEL}>
            <span>
              <span id="metric-owner-label">Owner</span>
              <Required />
            </span>
            <select
              data-field="owner"
              aria-labelledby="metric-owner-label"
              aria-required="true"
              className={INPUT}
              value={owner}
              aria-invalid={!!errors.owner}
              aria-describedby={errors.owner ? "metric-owner-error" : undefined}
              onChange={(e) => setOwner(e.target.value)}
            >
              <option value="">Pick who explains its changes</option>
              {people.map((p) => (
                <option key={p.user_id} value={p.user_id}>
                  {displayName(p.email, p.name)}
                </option>
              ))}
            </select>
            <FieldError field="owner" errors={errors} />
          </label>
          <label className={LABEL}>
            Source
            <select className={INPUT} value={source} disabled={!!metric} onChange={(e) => setSource(e.target.value as Metric["source"])}>
              {(Object.keys(SOURCE_LABEL) as Metric["source"][]).map((s) => (
                <option key={s} value={s}>
                  {SOURCE_LABEL[s]}
                </option>
              ))}
            </select>
          </label>
          {source === "posthog" && (
            <div className="flex flex-col gap-2">
              <div className={LABEL}>
                <label htmlFor="metric-query">
                  <span id="metric-query-label">Query</span>
                  <Required />
                </label>
                <textarea
                  id="metric-query"
                  data-field="query"
                  aria-labelledby="metric-query-label"
                  aria-required="true"
                  aria-invalid={!!errors.query}
                  aria-describedby={errors.query ? "metric-query-error metric-query-help" : "metric-query-help"}
                  // qa-company-11: a light, plain-font example, so an empty box does not look filled in.
                  className={`${INPUT} min-h-24 font-mono text-sm placeholder:font-sans placeholder:italic placeholder:text-text2/60`}
                  value={query}
                  maxLength={4000}
                  onChange={(e) => {
                    setQuery(e.target.value);
                    setTested(null);
                  }}
                  placeholder="e.g. select count(distinct team_id) from events where timestamp between {period_start} and {period_end}"
                />
                <FieldError field="query" errors={errors} />
                <span id="metric-query-help" className="text-[13px] font-normal">
                  A PostHog query that returns one number for a week. Where it should count only that week, write {"{period_start}"} and{" "}
                  {"{period_end}"}: Oracle fills in the week&apos;s first and last moment in the Company time zone. Test shows what it reads for
                  the last 4 weeks.
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button disabled={busy || !query.trim()} onClick={test} aria-describedby={!query.trim() ? "metric-test-hint" : undefined}>
                  Test
                </Button>
                {/* qa-company-11: why Test is not available yet. */}
                {!query.trim() && (
                  <span id="metric-test-hint" data-testid="metric-test-hint" className="text-[13px] text-text2">
                    Write a query to test it.
                  </span>
                )}
                {tested?.error && <span className="text-sm text-crit">{tested.error}</span>}
              </div>
              {tested && !tested.error && (
                <ul data-testid="metric-test-values" className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
                  {tested.values.map((v) => (
                    <li key={v.week_start} className="tnum">
                      Week of {weekText(v.week_start)}: <span className="font-semibold">{valueText(v.value, unit.trim() || "")}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          <div className={LABEL}>
            <label htmlFor="metric-threshold">Threshold (%)</label>
            <input
              id="metric-threshold"
              aria-describedby={errors.threshold ? "metric-threshold-error metric-threshold-help" : "metric-threshold-help"}
              className={`${INPUT} w-32`}
              data-field="threshold"
              aria-invalid={!!errors.threshold}
              inputMode="decimal"
              value={threshold}
              onChange={(e) => setThreshold(e.target.value)}
              placeholder="Optional"
            />
            <span id="metric-threshold-help" className="text-[13px] font-normal">
              A week whose change is at least this share of the week before is a variance too.
            </span>
            <FieldError field="threshold" errors={errors} />
          </div>
          {error && <ErrorNote>{error}</ErrorNote>}
          <div className="flex justify-end gap-2 border-t border-line pt-3">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" variant="solid" disabled={busy}>
              {metric ? "Save" : "Add metric"}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
