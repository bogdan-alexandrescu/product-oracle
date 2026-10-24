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
  const [unit, setUnit] = useState(metric?.unit ?? "");
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

  async function submit(e: FormEvent) {
    e.preventDefault();
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
          <label className={LABEL}>
            Title
            <input data-autofocus className={INPUT} value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} placeholder="Weekly active teams" />
          </label>
          <label className={LABEL}>
            What it counts
            <input className={INPUT} value={description} maxLength={200} onChange={(e) => setDescription(e.target.value)} placeholder="Teams with 3 or more sessions in the week" />
          </label>
          <div className="grid grid-cols-3 gap-3 max-[600px]:grid-cols-1">
            <label className={LABEL}>
              Kind
              <select className={INPUT} value={kind} disabled={!!metric} onChange={(e) => setKind(e.target.value as Metric["kind"])}>
                <option value="output">Output</option>
                <option value="input">Input</option>
              </select>
            </label>
            <label className={LABEL}>
              Unit
              <input className={INPUT} list="metric-units" value={unit} maxLength={40} onChange={(e) => setUnit(e.target.value)} placeholder="% or teams" />
              <datalist id="metric-units">
                {UNITS.map((u) => (
                  <option key={u} value={u} />
                ))}
              </datalist>
            </label>
            <label className={LABEL}>
              Good direction
              <select className={INPUT} value={direction} onChange={(e) => setDirection(e.target.value as Metric["direction"])}>
                <option value="up">Up</option>
                <option value="down">Down</option>
              </select>
            </label>
          </div>
          {kind === "input" ? (
            <label className={LABEL}>
              Drives
              <select className={INPUT} value={drives} onChange={(e) => setDrives(e.target.value)}>
                <option value="">Pick the output it drives</option>
                {outputs.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.title}
                  </option>
                ))}
              </select>
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
                <option value="">No goal</option>
                {goalChoices.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.title}
                  </option>
                ))}
              </select>
              <span id="metric-goal-help" className="text-[13px] font-normal">
                Confirmed goals measured in the same unit. Each weekly value becomes the goal&apos;s current value.
              </span>
            </div>
          )}
          <label className={LABEL}>
            Owner
            <select className={INPUT} value={owner} onChange={(e) => setOwner(e.target.value)}>
              <option value="">Pick who explains its changes</option>
              {people.map((p) => (
                <option key={p.user_id} value={p.user_id}>
                  {displayName(p.email, p.name)}
                </option>
              ))}
            </select>
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
                <label htmlFor="metric-query">Query</label>
                <textarea
                  id="metric-query"
                  aria-describedby="metric-query-help"
                  className={`${INPUT} min-h-24 font-mono text-sm`}
                  value={query}
                  maxLength={4000}
                  onChange={(e) => {
                    setQuery(e.target.value);
                    setTested(null);
                  }}
                  placeholder="select count(distinct team_id) from events where timestamp between {period_start} and {period_end}"
                />
                <span id="metric-query-help" className="text-[13px] font-normal">
                  HogQL returning one number. {"{period_start}"} and {"{period_end}"} become the week&apos;s bounds in the Company time zone.
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button disabled={busy || !query.trim()} onClick={test}>
                  Test
                </Button>
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
              aria-describedby="metric-threshold-help"
              className={`${INPUT} w-32`}
              inputMode="decimal"
              value={threshold}
              onChange={(e) => setThreshold(e.target.value)}
              placeholder="Optional"
            />
            <span id="metric-threshold-help" className="text-[13px] font-normal">
              A week whose change is at least this share of the week before is a variance too.
            </span>
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
