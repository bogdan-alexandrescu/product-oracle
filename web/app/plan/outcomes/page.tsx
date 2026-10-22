"use client";

import { useState, useSyncExternalStore } from "react";

import {
  Button,
  Chip,
  DataTable,
  FilterChips,
  InfoTip,
  Inspector,
  InspectorRow,
  InspectorSection,
  Notice,
  Page,
  PageHeader,
  Panel,
  Sheet,
  Split,
  type ChipKind,
  type Column,
} from "@/components/ds";
import { api, unwrap, type Schemas } from "@/lib/api/client";
import { formatDate } from "@/lib/format";
import { hasRole, useMe } from "@/lib/me";
import { errorMessage, useQuery } from "@/lib/use-query";
import { invalidateWaiting, waitingChanged } from "@/lib/waiting";

type Outcome = Schemas["OutcomeOut"];
type Prediction = Schemas["Prediction"];
type State = "needs" | "predicted" | "measuring" | "due" | "held" | "partially_held" | "not_held" | "inconclusive";
type Filter = "due" | "measuring" | "needs" | "assessed" | "all";

const STATE_LABEL: Record<State, string> = {
  needs: "Needs prediction",
  predicted: "Predicted",
  measuring: "Measuring",
  due: "Check due",
  held: "Held",
  partially_held: "Partly held",
  not_held: "Not held",
  inconclusive: "Inconclusive",
};
const STATE_KIND: Record<State, ChipKind> = {
  needs: "warn",
  predicted: "na",
  measuring: "acc",
  due: "warn",
  held: "pass",
  partially_held: "acc",
  not_held: "crit",
  inconclusive: "line",
};
const SIGNAL: Record<Schemas["ShipSignal"]["kind"], string> = {
  tracker: "issues done",
  milestone: "milestones done",
  launch: "launched",
  manual: "marked shipped",
};
const CAVEAT =
  "This compares the goal's value with the prediction. Goals move for many reasons; it does not prove the item caused it.";
const PHONE = "(max-width: 600px)";

function subscribePhone(onChange: () => void) {
  const mq = window.matchMedia(PHONE);
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}

function useIsPhone(): boolean {
  return useSyncExternalStore(
    subscribePhone,
    () => window.matchMedia(PHONE).matches,
    () => false,
  );
}

function stateOf(o: Outcome): State {
  if (o.status === "predicted") return o.needs_prediction ? "needs" : "predicted";
  if (o.status === "tracking") return o.proposed_assessment ? "due" : "measuring";
  return o.status;
}

const figure = (v: number | null | undefined, unit?: string | null) =>
  v == null ? null : `${v}${unit === "%" ? "%" : unit ? ` ${unit}` : ""}`;

/** "38% → 42% by Dec 31", from the typed figures when there are any. */
function predicted(p: Prediction): string {
  const from = figure(p.baseline_value, p.unit) ?? p.baseline;
  const to = figure(p.predicted_value, p.unit) ?? p.predicted;
  return `${from ? `${from} → ` : ""}${to}${p.by ? ` by ${formatDate(p.by)}` : ""}`;
}

/** "41% on Jan 4": Oracle's reading or the last assessment's. */
function actual(o: Outcome): string | null {
  const last = o.assessments[o.assessments.length - 1];
  const value = last?.actual_value ?? o.proposed_assessment?.actual_value;
  const on = last?.measured_at ?? o.proposed_assessment?.measured_at;
  const text = figure(value, o.prediction.unit) ?? last?.observed ?? o.proposed_assessment?.observed;
  return text ? `${text}${on ? ` on ${formatDate(on)}` : ""}` : null;
}

function StateChip({ o, hero = false }: { o: Outcome; hero?: boolean }) {
  const s = stateOf(o);
  return (
    <Chip kind={STATE_KIND[s]} dot={!hero} hero={hero} data-testid="outcome-state" data-state={s}>
      {STATE_LABEL[s]}
    </Chip>
  );
}

/**
 * Plan › Outcomes (H3 Predicted versus actual): every shipped roadmap item checked against
 * what it was expected to do. Oracle captures the prediction when a roadmap is approved,
 * notices the item shipped, and proposes the actual from the goal's own values; a person
 * confirms it.
 */
export default function OutcomesPage() {
  const q = useQuery("outcomes", () => unwrap(api.GET("/v1/outcomes", { params: { query: { limit: 500 } } })));
  const goalsQ = useQuery("outcomes|goals", () =>
    unwrap(api.GET("/v1/baseline/entities", { params: { query: { type: "goal" } } })),
  );
  const { role } = useMe();
  const canApprove = hasRole(role, "approver");
  const phone = useIsPhone();
  const [filter, setFilter] = useState<Filter | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [sheet, setSheet] = useState(false);

  const rows = q.data ?? [];
  const goals = new Map((goalsQ.data ?? []).map((g) => [g.id, g.title]));
  const inFilter = (o: Outcome, f: Filter) => {
    const s = stateOf(o);
    if (f === "all") return true;
    if (f === "assessed") return ["held", "partially_held", "not_held", "inconclusive"].includes(s);
    return s === f;
  };
  const count = (f: Filter) => rows.filter((o) => inFilter(o, f)).length;
  // Check due is the default while any check is due.
  const current: Filter = filter ?? (count("due") > 0 ? "due" : "all");
  const shown = rows.filter((o) => inFilter(o, current));
  const active = shown.find((o) => o.id === selected) ?? rows.find((o) => o.id === selected) ?? shown[0];

  const columns: Column<Outcome>[] = [
    {
      key: "item",
      header: "Item",
      phone: "title",
      cell: (o) => (
        <span className="truncate font-semibold" title={o.title}>
          {o.title}
        </span>
      ),
    },
    {
      key: "goal",
      header: "Goal",
      width: "170px",
      hideOnPhone: true,
      cell: (o) => <span className="truncate text-text2">{goals.get(o.goal_id) ?? "Goal"}</span>,
    },
    {
      key: "predicted",
      header: "Predicted",
      width: "190px",
      hideOnPhone: true,
      cell: (o) => <span className="tnum truncate">{predicted(o.prediction)}</span>,
    },
    {
      key: "actual",
      header: "Actual",
      width: "130px",
      hideOnPhone: true,
      cell: (o) => <span className="tnum truncate text-text2">{actual(o) ?? "—"}</span>,
    },
    {
      key: "state",
      header: "State",
      width: "140px",
      phone: "meta",
      cell: (o) => <StateChip o={o} />,
    },
    {
      key: "due",
      header: "Due",
      width: "100px",
      phone: "meta",
      cell: (o) => (
        <span className="tnum text-text2" data-testid="outcome-due">
          {o.assess_due_on ? formatDate(o.assess_due_on) : o.prediction.by ? formatDate(o.prediction.by) : "—"}
        </span>
      ),
    },
  ];

  const inspector = active ? (
    <OutcomeInspector
      key={`${active.id}-${active.lock_version}-${active.status}`}
      o={active}
      goal={goals.get(active.goal_id) ?? "its goal"}
      canApprove={canApprove}
      onChanged={q.reload}
    />
  ) : null;

  return (
    <Page>
      <PageHeader
        title="Plan"
        status={
          q.data && (
            <>
              <Chip kind="acc">
                {rows.length} {rows.length === 1 ? "outcome" : "outcomes"}
              </Chip>
              <InfoTip label="Outcomes" align="start" side="bottom">
                Approving a roadmap records what each item is expected to do for its goal. When the item ships, Oracle
                waits for the goal to move, then proposes whether the prediction held. A person confirms it.
              </InfoTip>
            </>
          )
        }
      />
      <div className="flex flex-col gap-3">
        {q.error && <Notice tone="error">{q.error}</Notice>}
        <Split inspector={phone ? undefined : inspector}>
          <Panel
            title="Outcomes"
            tools={
              <FilterChips
                label="Outcomes by state"
                testId="outcome-filters"
                value={current}
                onChange={(v) => setFilter(v)}
                items={[
                  { value: "due", label: "Check due", count: count("due") },
                  {
                    value: "measuring",
                    label: "Measuring",
                    count: count("measuring"),
                  },
                  {
                    value: "needs",
                    label: "Needs prediction",
                    count: count("needs"),
                  },
                  {
                    value: "assessed",
                    label: "Assessed",
                    count: count("assessed"),
                  },
                  { value: "all", label: "All", count: rows.length },
                ]}
              />
            }
          >
            <DataTable<Outcome>
              label="Outcomes"
              testId="outcomes-table"
              columns={columns}
              rows={q.loading && !q.data ? undefined : shown}
              rowKey={(o) => o.id}
              selected={active?.id ?? null}
              onSelect={(k) => {
                setSelected(k);
                if (phone) setSheet(true);
              }}
              loading={q.loading && !q.data}
              empty="No outcomes here. Approving a roadmap records a prediction for each item that serves a goal."
              rowProps={(o) => ({
                "data-testid": "outcome-row",
                "data-state": stateOf(o),
              })}
            />
          </Panel>
        </Split>
        {phone && active && (
          <Sheet open={sheet} title={active.title} onClose={() => setSheet(false)} testId="outcome-sheet">
            {inspector}
          </Sheet>
        )}
      </div>
    </Page>
  );
}

const num = (s: string) => (s.trim() === "" ? null : Number(s));

function PredictionForm({ o, onSave, busy }: { o: Outcome; onSave: (p: Prediction) => void; busy: boolean }) {
  const p = o.prediction;
  const [baseline, setBaseline] = useState(p.baseline_value?.toString() ?? "");
  const [want, setWant] = useState(p.predicted_value?.toString() ?? "");
  const [line, setLine] = useState(p.threshold_value?.toString() ?? "");
  const [unit, setUnit] = useState(p.unit ?? "");
  const [by, setBy] = useState(p.by ?? "");
  const [direction, setDirection] = useState<"increase" | "decrease">(p.direction ?? "increase");
  const field = "h-9 w-full rounded-lg border border-line-strong bg-surface px-2.5 text-[15px]";
  const input = (label: string, value: string, set: (v: string) => void, type = "text") => (
    <label className="flex flex-col gap-1 text-sm">
      <span className="text-text2">{label}</span>
      <input
        className={field}
        type={type}
        inputMode={type === "text" ? undefined : "decimal"}
        value={value}
        onChange={(e) => set(e.target.value)}
      />
    </label>
  );
  function save() {
    const b = num(baseline),
      w = num(want),
      t = num(line);
    const u = unit.trim() || null;
    const shown = (v: number | null) => (v == null ? null : `${v}${u === "%" ? "%" : u ? ` ${u}` : ""}`);
    onSave({
      ...p,
      baseline_value: b,
      predicted_value: w,
      threshold_value: t,
      unit: u,
      direction,
      by: by || null,
      baseline: shown(b) ?? p.baseline ?? null,
      predicted: shown(w) ?? p.predicted,
      threshold: shown(t),
    });
  }
  return (
    <form
      className="grid grid-cols-2 gap-2.5"
      data-testid="prediction-form"
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      {input("Baseline", baseline, setBaseline, "number")}
      {input("Predicted", want, setWant, "number")}
      {input("Partly held at", line, setLine, "number")}
      {input("Unit", unit, setUnit)}
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-text2">Direction</span>
        <select
          className={field}
          value={direction}
          onChange={(e) => setDirection(e.target.value as "increase" | "decrease")}
        >
          <option value="increase">Up</option>
          <option value="decrease">Down</option>
        </select>
      </label>
      {input("By", by, setBy, "date")}
      <div className="col-span-2">
        <Button type="submit" variant="primary" disabled={busy}>
          Save prediction
        </Button>
      </div>
    </form>
  );
}

function OutcomeInspector({
  o,
  goal,
  canApprove,
  onChanged,
}: {
  o: Outcome;
  goal: string;
  canApprove: boolean;
  onChanged: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const path = { params: { path: { outcome_id: o.id } } };
  const p = o.prediction;
  const prop = o.proposed_assessment;

  async function act(call: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await call();
      // Add predictions and Outcome check due rows may have changed: the Inbox and the badge re-read.
      invalidateWaiting();
      await onChanged();
      waitingChanged();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const assess = (verdict: Schemas["AssessmentIn"]["verdict"]) =>
    act(() =>
      unwrap(
        api.POST("/v1/outcomes/{outcome_id}/assessments", {
          ...path,
          body: {
            verdict,
            observed: prop?.observed ?? "no value",
            evidence_ids: [],
            actual_value: prop?.actual_value ?? null,
            measured_at: prop?.measured_at ?? null,
          },
        }),
      ),
    );

  const now = prop ? figure(prop.actual_value, p.unit) : null;
  const signal = o.ship_signal;
  return (
    <Inspector
      eyebrow="Outcome · selected"
      title={o.title}
      label={`Outcome ${o.title}`}
      testId="outcome-inspector"
      chips={<StateChip o={o} hero />}
    >
      {error && (
        <InspectorSection>
          <Notice tone="error">{error}</Notice>
        </InspectorSection>
      )}
      <InspectorSection label="Prediction">
        <p className="tnum text-sm">
          Predicted {figure(p.baseline_value, p.unit) ?? p.baseline ?? "?"} →{" "}
          {figure(p.predicted_value, p.unit) ?? p.predicted}
          {now ? ` · Now ${now}` : ""}
        </p>
        <InspectorRow value={<span className="text-text2">{goal}</span>}>Goal</InspectorRow>
        <InspectorRow value={<span className="text-text2">{p.metric}</span>}>Metric</InspectorRow>
        {p.threshold_value != null && (
          <InspectorRow value={<span className="tnum">{figure(p.threshold_value, p.unit)}</span>}>
            Partly held at
          </InspectorRow>
        )}
        {p.by && <InspectorRow value={<span className="tnum">{formatDate(p.by)}</span>}>By</InspectorRow>}
        {canApprove && o.status === "predicted" && !editing && !o.needs_prediction && (
          <Button variant="secondary" onClick={() => setEditing(true)} data-testid="outcome-edit">
            Edit
          </Button>
        )}
        {canApprove && o.status === "predicted" && (editing || o.needs_prediction) && (
          <PredictionForm
            o={o}
            busy={busy}
            onSave={(prediction) =>
              act(() =>
                unwrap(
                  api.PATCH("/v1/outcomes/{outcome_id}", {
                    ...path,
                    body: { prediction, lock_version: o.lock_version },
                  }),
                ),
              )
            }
          />
        )}
      </InspectorSection>
      {signal && (
        <InspectorSection label="Shipped">
          <p className="text-sm" data-testid="outcome-shipped">
            {signal.kind === "tracker" && signal.refs.length
              ? `${signal.refs.length} of ${signal.refs.length} ${SIGNAL.tracker}`
              : SIGNAL[signal.kind]}{" "}
            · {formatDate(signal.at)}
          </p>
        </InspectorSection>
      )}
      {prop && (
        <InspectorSection
          label="Oracle's proposal"
          tools={
            <InfoTip label="How Oracle reads the actual">
              The first goal value recorded on or after the prediction&apos;s date, else the latest one.
            </InfoTip>
          }
        >
          <div data-testid="outcome-proposal" className="flex flex-col gap-1.5 text-sm">
            <span>
              <Chip kind={STATE_KIND[prop.verdict]}>{STATE_LABEL[prop.verdict]}</Chip>
            </span>
            <span className="text-text2">
              {now
                ? `Goal value ${now}${prop.measured_at ? `, recorded ${formatDate(prop.measured_at)}` : ""}`
                : "No readable goal value"}
              {prop.note ? ` · ${prop.note}` : ""}
            </span>
            <span className="text-text2">{CAVEAT}</span>
          </div>
          {canApprove && o.status === "tracking" && (
            <div className="mt-2 flex flex-wrap gap-2">
              <Button
                variant="primary"
                disabled={busy}
                onClick={() => assess(prop.verdict)}
                data-testid="outcome-confirm"
              >
                Confirm
              </Button>
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() => assess("inconclusive")}
                data-testid="outcome-inconclusive"
              >
                Inconclusive
              </Button>
            </div>
          )}
        </InspectorSection>
      )}
      {o.assessments.length > 0 && (
        <InspectorSection label="Assessments">
          <ul className="space-y-1 text-sm">
            {o.assessments.map((a, i) => (
              <li key={i}>
                {STATE_LABEL[a.verdict]} · {a.observed} · {a.actor === "oracle" ? "Oracle" : "a person"} ·{" "}
                {formatDate(a.assessed_at)}
              </li>
            ))}
          </ul>
          <p className="mt-1.5 text-sm text-text2">Counts toward track record: {goal}</p>
        </InspectorSection>
      )}
    </Inspector>
  );
}
