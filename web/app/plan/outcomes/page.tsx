"use client";

import { useSearchParams } from "next/navigation";
import { Suspense, useState, useSyncExternalStore } from "react";

import { Button, Chip, type ChipKind, type Column, confirmInPage, DataTable, FilterChips, InfoTip, Inspector, InspectorRow, InspectorSection, Notice, Page, PageHeader, PageSkeleton, Panel, Sheet, Split } from "@/components/ds";
import { Loading } from "@/components/ui";
import { api, unwrap, type Schemas } from "@/lib/api/client";
import { CATEGORY_LABEL } from "@/app/intakes/[id]/_lib";
import { formatDate } from "@/lib/format";
import { useMe } from "@/lib/me";
import { errorMessage, useQuery } from "@/lib/use-query";
import { invalidateWaiting, waitingChanged } from "@/lib/waiting";

type Outcome = Schemas["OutcomeOut"];
type Learning = Schemas["LearningOut"];
type Prediction = Schemas["Prediction"];
type State =
  | "needs"
  | "predicted"
  | "measuring"
  | "due"
  | "held"
  | "partially_held"
  | "not_held"
  | "inconclusive";
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
  if (o.status === "predicted")
    return o.needs_prediction ? "needs" : "predicted";
  if (o.status === "tracking")
    return o.proposed_assessment ? "due" : "measuring";
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
  const text =
    figure(value, o.prediction.unit) ??
    last?.observed ??
    o.proposed_assessment?.observed;
  return text ? `${text}${on ? ` on ${formatDate(on)}` : ""}` : null;
}

function StateChip({ o, hero = false }: { o: Outcome; hero?: boolean }) {
  const s = stateOf(o);
  return (
    <Chip
      kind={STATE_KIND[s]}
      dot={!hero}
      hero={hero}
      data-testid="outcome-state"
      data-state={s}
    >
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
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Outcomes />
    </Suspense>
  );
}

function Outcomes() {
  // An Inbox row links here with ?outcome=<id>: that outcome opens, whatever its state.
  const linked = useSearchParams().get("outcome");
  const q = useQuery("outcomes", () =>
    unwrap(api.GET("/v1/outcomes", { params: { query: { limit: 500 } } })),
  );
  const goalsQ = useQuery("outcomes|goals", () =>
    unwrap(
      api.GET("/v1/baseline/entities", { params: { query: { type: "goal" } } }),
    ),
  );
  const recordQ = useQuery("outcomes|calibration", () =>
    unwrap(api.GET("/v1/priorities/calibration")),
  );
  const { can } = useMe();
  // #370: tracking, shipping and assessing an outcome are the outcome routes' role.
  const canApprove = can("update_outcome");
  const phone = useIsPhone();
  const [filter, setFilter] = useState<Filter | null>(null);
  const [selected, setSelected] = useState<string | null>(linked);
  const [sheet, setSheet] = useState(linked != null);
  const [tracking, setTracking] = useState(false);
  const learningsQ = useQuery("outcomes|learnings", () =>
    unwrap(api.GET("/v1/learnings", { params: { query: { limit: 500 } } })),
  );

  const rows = q.data ?? [];
  const goals = new Map((goalsQ.data ?? []).map((g) => [g.id, g.title]));
  const inFilter = (o: Outcome, f: Filter) => {
    const s = stateOf(o);
    if (f === "all") return true;
    if (f === "assessed")
      return ["held", "partially_held", "not_held", "inconclusive"].includes(s);
    return s === f;
  };
  const count = (f: Filter) => rows.filter((o) => inFilter(o, f)).length;
  // Check due is the default while any check is due.
  const current: Filter =
    filter ?? (linked == null && count("due") > 0 ? "due" : "all");
  const shown = rows.filter((o) => inFilter(o, current));
  // Loaded, and nothing at all (not a filter that matches nothing).
  const none = q.data != null && rows.length === 0;
  const active =
    shown.find((o) => o.id === selected) ??
    rows.find((o) => o.id === selected) ??
    shown[0];

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
      cell: (o) => (
        <span className="truncate text-text2">
          {goals.get(o.goal_id) ?? "Goal"}
        </span>
      ),
    },
    {
      key: "predicted",
      header: "Predicted",
      width: "190px",
      hideOnPhone: true,
      cell: (o) => (
        <span className="tnum truncate">{predicted(o.prediction)}</span>
      ),
    },
    {
      key: "actual",
      header: "Actual",
      width: "130px",
      hideOnPhone: true,
      cell: (o) => (
        <span className="tnum truncate text-text2">{actual(o) ?? "—"}</span>
      ),
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
          {o.assess_due_on
            ? formatDate(o.assess_due_on)
            : o.prediction.by
              ? formatDate(o.prediction.by)
              : "—"}
        </span>
      ),
    },
  ];

  const counted = new Map(
    (recordQ.data?.goals ?? []).map((g) => [g.goal_id, g.n]),
  );
  const inspector = active ? (
    <OutcomeInspector
      key={`${active.id}-${active.lock_version}-${active.status}-${active.assessments.length}`}
      o={active}
      goal={goals.get(active.goal_id) ?? "its goal"}
      counted={counted.get(active.goal_id) ?? null}
      canApprove={canApprove}
      onChanged={async () => {
        await q.reload();
        await recordQ.reload();
        await learningsQ.reload();
      }}
    />
  ) : null;

  return (
    <Page>
      <PageHeader
        title="Plan"
        info={
          <InfoTip label="Outcomes" align="start" side="bottom">
            Approving a roadmap records what each item is expected to do for
            its goal. When the item ships, Oracle waits for the goal to
            move, then proposes whether the prediction held. A person
            confirms it.
          </InfoTip>
        }
        status={
          q.data && (
            <>
              <Chip kind="acc">
                {rows.length} {rows.length === 1 ? "outcome" : "outcomes"}
              </Chip>
            </>
          )
        }
        action={
          // While the form is open its own submit tracks the outcome; fix4 qa-plan-15: with no
          // outcome yet, Track outcome is the empty state's only.
          canApprove && !tracking && !none && (
            <Button
              variant="primary"
              onClick={() => setTracking(true)}
              data-testid="outcome-track"
            >
              Track outcome
            </Button>
          )
        }
      />
      <div className="flex flex-col gap-3">
        {q.error && <Notice tone="error">{q.error}</Notice>}
        {canApprove && tracking && (
          <TrackOutcomeForm
            goals={goalsQ.data ?? []}
            tracked={new Set(rows.map((o) => o.roadmap_item_id))}
            onCancel={() => setTracking(false)}
            onTracked={async (o) => {
              setTracking(false);
              setFilter("all");
              setSelected(o.id);
              await q.reload();
            }}
          />
        )}
        <Split inspector={phone ? undefined : inspector}>
          <Panel
            title="Outcomes"
            tools={
              // qa-plan-48: with no outcome at all, no filters (each would read 0) and no
              // table headers: only the empty state and its action.
              !none && (
                <FilterChips
                  label="Outcomes by state"
                  testId="outcome-filters"
                  value={current}
                  onChange={(v) => setFilter(v)}
                  // A state with nothing in it is dimmed and cannot be picked.
                  items={[
                    { value: "due", label: "Check due", count: count("due"), disabled: count("due") === 0 },
                    {
                      value: "measuring",
                      label: "Measuring",
                      count: count("measuring"),
                      disabled: count("measuring") === 0,
                    },
                    {
                      value: "needs",
                      label: "Needs prediction",
                      count: count("needs"),
                      disabled: count("needs") === 0,
                    },
                    {
                      value: "assessed",
                      label: "Assessed",
                      count: count("assessed"),
                      disabled: count("assessed") === 0,
                    },
                    { value: "all", label: "All", count: rows.length },
                  ]}
                />
              )
            }
          >
            {none ? (
              <div
                data-testid="outcomes-empty"
                className="flex flex-col items-center gap-3 px-4 py-10 text-center text-[15px] text-text2"
              >
                <p className="font-display text-lg font-bold text-text">
                  No outcomes yet
                </p>
                <p>
                  Approving a roadmap records a prediction for each item that
                  serves a goal.
                  {canApprove
                    ? " You can also track an outcome for an item yourself."
                    : ""}
                </p>
                {canApprove && !tracking && (
                  <Button variant="primary" onClick={() => setTracking(true)} data-testid="outcome-track">
                    Track outcome
                  </Button>
                )}
              </div>
            ) : (
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
            )}
          </Panel>
        </Split>
        {phone && active && (
          <Sheet
            open={sheet}
            title={active.title}
            onClose={() => setSheet(false)}
            testId="outcome-sheet"
          >
            {inspector}
          </Sheet>
        )}
        <LearningsPanel
          rows={learningsQ.data}
          error={learningsQ.error}
          canApprove={canApprove}
          onChanged={learningsQ.reload}
        />
      </div>
    </Page>
  );
}

const num = (s: string) => (s.trim() === "" ? null : Number(s));

function PredictionForm({
  o,
  onSave,
  busy,
}: {
  o: Outcome;
  onSave: (p: Prediction) => void;
  busy: boolean;
}) {
  const p = o.prediction;
  const [baseline, setBaseline] = useState(p.baseline_value?.toString() ?? "");
  const [want, setWant] = useState(p.predicted_value?.toString() ?? "");
  const [line, setLine] = useState(p.threshold_value?.toString() ?? "");
  const [unit, setUnit] = useState(p.unit ?? "");
  const [by, setBy] = useState(p.by ?? "");
  const [direction, setDirection] = useState<"increase" | "decrease">(
    p.direction ?? "increase",
  );
  const field =
    "h-9 w-full rounded-lg border border-line-strong bg-surface px-2.5 text-[15px]";
  const input = (
    label: string,
    value: string,
    set: (v: string) => void,
    type = "text",
  ) => (
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
    const shown = (v: number | null) =>
      v == null ? null : `${v}${u === "%" ? "%" : u ? ` ${u}` : ""}`;
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
          onChange={(e) =>
            setDirection(e.target.value as "increase" | "decrease")
          }
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

type Verdict = Schemas["AssessmentIn"]["verdict"];
const VERDICTS: Verdict[] = [
  "held",
  "partially_held",
  "not_held",
  "inconclusive",
];

/** Edit Oracle's proposal, or change a recorded verdict: what a person records instead. */
function AssessmentForm({
  o,
  from,
  busy,
  onSave,
  onCancel,
}: {
  o: Outcome;
  from: {
    // None below Recommend (H11 Check outcomes): Oracle read the actual but proposes no verdict.
    verdict: Verdict | null;
    actual_value?: number | null;
    measured_at?: string | null;
    note?: string | null;
  };
  busy: boolean;
  onSave: (a: Schemas["AssessmentIn"]) => void;
  onCancel: () => void;
}) {
  const [verdict, setVerdict] = useState<Verdict | "">(from.verdict ?? "");
  const [value, setValue] = useState(from.actual_value?.toString() ?? "");
  const [on, setOn] = useState(from.measured_at ?? "");
  const [note, setNote] = useState(from.note ?? "");
  const field =
    "h-9 w-full rounded-lg border border-line-strong bg-surface px-2.5 text-[15px]";
  function save() {
    const v = num(value);
    if (!verdict) return;
    onSave({
      verdict,
      observed: figure(v, o.prediction.unit) ?? "no value",
      actual_value: v,
      measured_at: on || null,
      note: note.trim() || null,
      evidence_ids: [],
    });
  }
  return (
    <form
      className="mt-2 grid grid-cols-2 gap-2.5"
      data-testid="assessment-form"
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-text2">Verdict</span>
        <select
          className={field}
          value={verdict}
          onChange={(e) => setVerdict(e.target.value as Verdict)}
        >
          {!verdict && (
            <option value="" disabled>
              Pick a verdict
            </option>
          )}
          {VERDICTS.map((v) => (
            <option key={v} value={v}>
              {STATE_LABEL[v]}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-text2">Actual value</span>
        <input
          className={field}
          type="number"
          inputMode="decimal"
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-text2">Measured on</span>
        <input
          className={field}
          type="date"
          value={on}
          onChange={(e) => setOn(e.target.value)}
        />
      </label>
      <label className="col-span-2 flex flex-col gap-1 text-sm">
        <span className="text-text2">Note</span>
        <textarea
          className="min-h-16 w-full rounded-lg border border-line-strong bg-surface px-2.5 py-1.5 text-[15px]"
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
      </label>
      {/* qa-plan-34: as every dialog: Cancel on the left, the primary action on the right. */}
      <div className="col-span-2 flex flex-wrap gap-2">
        <Button type="button" variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" disabled={busy || !verdict}>
          Record assessment
        </Button>
      </div>
    </form>
  );
}

function OutcomeInspector({
  o,
  goal,
  counted,
  canApprove,
  onChanged,
}: {
  o: Outcome;
  goal: string;
  counted: number | null;
  canApprove: boolean;
  onChanged: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  // The assessment form: Edit on Oracle's proposal, Change on a recorded verdict.
  const [assessing, setAssessing] = useState(false);
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

  const record = (body: Schemas["AssessmentIn"]) =>
    act(() =>
      unwrap(
        api.POST("/v1/outcomes/{outcome_id}/assessments", { ...path, body }),
      ),
    );
  const assess = (verdict: Verdict) =>
    record({
      verdict,
      observed: prop?.observed ?? "no value",
      evidence_ids: [],
      actual_value: prop?.actual_value ?? null,
      measured_at: prop?.measured_at ?? null,
    });
  const decide = (index: number, decision: "keep" | "skip") =>
    act(() =>
      unwrap(
        api.POST("/v1/outcomes/{outcome_id}/learnings/{index}", {
          params: { path: { outcome_id: o.id, index } },
          body: { decision },
        }),
      ),
    );
  const last = o.assessments[o.assessments.length - 1];
  const drafts = last?.learnings ?? [];

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
        <InspectorRow value={<span className="text-text2">{goal}</span>}>
          Goal
        </InspectorRow>
        <InspectorRow value={<span className="text-text2">{p.metric}</span>}>
          Metric
        </InspectorRow>
        {p.threshold_value != null && (
          <InspectorRow
            value={
              <span className="tnum">{figure(p.threshold_value, p.unit)}</span>
            }
          >
            Partly held at
          </InspectorRow>
        )}
        {p.by && (
          <InspectorRow
            value={<span className="tnum">{formatDate(p.by)}</span>}
          >
            By
          </InspectorRow>
        )}
        {canApprove &&
          o.status === "predicted" &&
          !editing &&
          !o.needs_prediction && (
            <Button
              variant="secondary"
              onClick={() => setEditing(true)}
              data-testid="outcome-edit"
            >
              Edit
            </Button>
          )}
        {canApprove &&
          o.status === "predicted" &&
          (editing || o.needs_prediction) && (
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
          label={prop.verdict ? "Oracle's proposal" : "Oracle's reading"}
          tools={
            <InfoTip label="How Oracle reads the actual">
              The first goal value recorded on or after the prediction&apos;s
              date, else the latest one.
            </InfoTip>
          }
        >
          <div
            data-testid="outcome-proposal"
            className="flex flex-col gap-1.5 text-sm"
          >
            {prop.verdict && (
              <span>
                <Chip kind={STATE_KIND[prop.verdict]}>
                  {STATE_LABEL[prop.verdict]}
                </Chip>
              </span>
            )}
            <span className="text-text2">
              {now
                ? `Goal value ${now}${prop.measured_at ? `, recorded ${formatDate(prop.measured_at)}` : ""}`
                : "No readable goal value"}
              {prop.note ? ` · ${prop.note}` : ""}
            </span>
            <span className="text-text2">{CAVEAT}</span>
          </div>
          {canApprove && o.status === "tracking" && !assessing && (
            <div className="mt-2 flex flex-wrap gap-2">
              {prop.verdict && (
                <Button
                  variant="primary"
                  disabled={busy}
                  onClick={() => prop.verdict && assess(prop.verdict)}
                  data-testid="outcome-confirm"
                >
                  Confirm
                </Button>
              )}
              <Button
                variant={prop.verdict ? "secondary" : "primary"}
                disabled={busy}
                onClick={() => setAssessing(true)}
                data-testid="outcome-assess-edit"
              >
                {prop.verdict ? "Edit" : "Record verdict"}
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
          {canApprove && o.status === "tracking" && assessing && (
            <AssessmentForm
              o={o}
              from={prop}
              busy={busy}
              onSave={record}
              onCancel={() => setAssessing(false)}
            />
          )}
        </InspectorSection>
      )}
      {last && (
        <InspectorSection label="Assessments">
          <ul className="space-y-1 text-sm" data-testid="outcome-history">
            {o.assessments.map((a, i) => (
              <li key={i}>
                {STATE_LABEL[a.verdict]} · {a.observed} ·{" "}
                {a.actor === "oracle" ? "Oracle" : "a person"} ·{" "}
                {formatDate(a.assessed_at)}
                {a.note && <span className="block text-text2">{a.note}</span>}
              </li>
            ))}
          </ul>
          {last.verdict !== "inconclusive" && (
            <p className="mt-1.5 text-sm text-text2">
              Counts toward track record: {goal}
              {counted != null ? ` (${counted})` : ""}
            </p>
          )}
          {canApprove && o.status !== "tracking" && !assessing && (
            <Button
              variant="secondary"
              className="mt-2"
              disabled={busy}
              onClick={() => setAssessing(true)}
              data-testid="outcome-change"
            >
              Change
            </Button>
          )}
          {canApprove && o.status !== "tracking" && assessing && (
            <AssessmentForm
              o={o}
              from={last}
              busy={busy}
              onSave={record}
              onCancel={() => setAssessing(false)}
            />
          )}
        </InspectorSection>
      )}
      {drafts.length > 0 && (
        <InspectorSection label="Drafted learnings">
          <ul className="space-y-2 text-sm">
            {drafts.map((d, i) => (
              <li
                key={i}
                className="flex flex-col gap-1.5"
                data-testid="outcome-learning"
                data-state={d.state}
              >
                <span>{d.statement}</span>
                {d.state === "drafted" && canApprove ? (
                  <span className="flex flex-wrap gap-2">
                    <Button
                      variant="secondary"
                      disabled={busy}
                      onClick={() => decide(i, "keep")}
                    >
                      Keep
                    </Button>
                    <Button
                      variant="secondary"
                      disabled={busy}
                      onClick={() => decide(i, "skip")}
                    >
                      Skip
                    </Button>
                  </span>
                ) : d.state !== "drafted" ? (
                  <span>
                    <Chip kind={d.state === "kept" ? "pass" : "line"}>
                      {d.state === "kept" ? "Kept" : "Skipped"}
                    </Chip>
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </InspectorSection>
      )}
    </Inspector>
  );
}

const FIELD =
  "h-9 w-full rounded-lg border border-line-strong bg-surface px-2.5 text-[15px]";

/** Track outcome: an approved roadmap item, its goal, the expected effect, a metric and a check date. */
function TrackOutcomeForm({
  goals,
  tracked,
  onCancel,
  onTracked,
}: {
  goals: { id: string; title: string }[];
  tracked: Set<string | null | undefined>;
  onCancel: () => void;
  onTracked: (o: Outcome) => Promise<void>;
}) {
  const itemsQ = useQuery("outcomes|plan-items", () =>
    unwrap(api.GET("/v1/plan", { params: { query: { scope: "approved" } } })),
  );
  const items = (itemsQ.data?.items ?? []).filter((i) => !tracked.has(i.id));
  const [itemId, setItemId] = useState("");
  const [goalId, setGoalId] = useState("");
  const [effect, setEffect] = useState("");
  const [metric, setMetric] = useState("");
  const [by, setBy] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const item = items.find((i) => i.id === itemId);

  async function save() {
    if (!item) return;
    setBusy(true);
    setError(null);
    try {
      const o = await unwrap(
        api.POST("/v1/outcomes", {
          body: {
            title: item.title,
            goal_id: goalId,
            roadmap_item_id: item.id,
            module_keys: [],
            gap_categories: [],
            prediction: {
              metric: metric.trim(),
              predicted: effect.trim(),
              by: by || null,
            },
          },
        }),
      );
      await onTracked(o);
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  }

  const ready = item && goalId && effect.trim() && metric.trim();
  return (
    <Panel title="Track outcome" bodyClassName="px-4 py-3 max-[600px]:px-3">
      <form
        className="grid grid-cols-2 gap-2.5 max-[600px]:grid-cols-1"
        data-testid="track-outcome-form"
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          }
        }}
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        {itemsQ.error && (
          <div className="col-span-full">
            <Notice tone="error">{itemsQ.error}</Notice>
          </div>
        )}
        {error && (
          <div className="col-span-full">
            <Notice tone="error">{error}</Notice>
          </div>
        )}
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-text2">Item</span>
          <select
            className={FIELD}
            value={itemId}
            onChange={(e) => {
              setItemId(e.target.value);
              // The item's first goal, when it serves one.
              const next = items.find((i) => i.id === e.target.value);
              const first = next?.goal_ids.find((g) =>
                goals.some((x) => x.id === g),
              );
              if (first) setGoalId(first);
            }}
          >
            <option value="">
              {itemsQ.loading ? "Loading…" : "Choose an approved item"}
            </option>
            {items.map((i) => (
              <option key={i.id} value={i.id}>
                {i.title}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-text2">Goal</span>
          <select
            className={FIELD}
            value={goalId}
            onChange={(e) => setGoalId(e.target.value)}
          >
            <option value="">Choose a goal</option>
            {goals.map((g) => (
              <option key={g.id} value={g.id}>
                {g.title}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-text2">Expected effect</span>
          <input
            className={FIELD}
            value={effect}
            placeholder="+5 weekly active teams"
            maxLength={300}
            onChange={(e) => setEffect(e.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-text2">Metric</span>
          <input
            className={FIELD}
            value={metric}
            maxLength={300}
            onChange={(e) => setMetric(e.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-text2">Check date</span>
          <input
            className={FIELD}
            type="date"
            value={by}
            onChange={(e) => setBy(e.target.value)}
          />
        </label>
        <div className="col-span-full flex flex-wrap gap-2">
          <Button type="submit" variant="primary" disabled={busy || !ready}>
            Track outcome
          </Button>
          <Button type="button" variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </form>
    </Panel>
  );
}

// fix4 qa-plan-26: what a learning is attached to and what it asks, in plain words.
const APPLIES_TO: Record<Learning["applies_to"], string> = {
  module: "A part of Oracle",
  question_category: "A kind of interview question",
  criterion: "A quality check",
};
/** Names for a learning's target: question categories, quality criteria and modules by their titles. */
function useTargetNames() {
  const criteria = useQuery("quality-criteria", () => unwrap(api.GET("/v1/quality/criteria")));
  const modules = useQuery("module-catalog", () => unwrap(api.GET("/v1/module-catalog")));
  const options: Record<Learning["applies_to"], { key: string; name: string }[]> = {
    question_category: Object.entries(CATEGORY_LABEL).map(([key, name]) => ({ key, name })),
    criterion: (criteria.data ?? []).map((c) => ({ key: c.key, name: c.title })),
    module: (modules.data ?? []).map((m) => ({ key: m.key, name: m.title })),
  };
  // When the list failed to load, there is nothing to pick from (its kind cannot be added
  // at all): type the key by hand instead.
  const failed: Record<Learning["applies_to"], boolean> = {
    question_category: false,
    criterion: !!criteria.error,
    module: !!modules.error,
  };
  const nameOf = (l: Pick<Learning, "applies_to" | "target">) =>
    options[l.applies_to].find((o) => o.key === l.target)?.name ?? humanize(l.target);
  return { options, failed, nameOf };
}

/** A key in words, for a target no list names: "success_metric" is "Success metric". */
function humanize(key: string): string {
  const words = key.replace(/[._-]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** The target field's label for each kind of learning. */
const TARGET_WORD: Record<Learning["applies_to"], string> = {
  module: "Which part",
  question_category: "Which kind of question",
  criterion: "Which check",
};
/** What Oracle does with the learning next time. */
const DIRECTION: Record<Learning["direction"], string> = {
  recommend_more: "Suggest it more often",
  recommend_less: "Suggest it less often",
  note: "Just keep it in mind",
};

/** Learnings: what outcomes taught, kept from a draft or added by hand; an approver retires one with a reason. */
function LearningsPanel({
  rows,
  error,
  canApprove,
  onChanged,
}: {
  rows: Learning[] | undefined;
  error: string | null;
  canApprove: boolean;
  onChanged: () => Promise<void>;
}) {
  const [adding, setAdding] = useState(false);
  const names = useTargetNames();
  return (
    <Panel
      title="Learnings"
      // fix4 qa-plan-27: the count is neutral text, not an accent figure that reads as a link.
      count={rows && <span className="text-text2">{rows.length}</span>}
      testId="learnings-panel"
      bodyClassName="px-4 py-3 max-[600px]:px-3"
      tools={
        canApprove &&
        !adding && (
          <Button variant="secondary" onClick={() => setAdding(true)}>
            Add learning
          </Button>
        )
      }
    >
      {error && <Notice tone="error">{error}</Notice>}
      {canApprove && adding && (
        <LearningForm
          names={names}
          onCancel={() => setAdding(false)}
          onAdded={async () => {
            setAdding(false);
            await onChanged();
          }}
        />
      )}
      {rows === undefined ? (
        <Loading />
      ) : rows.length === 0 ? (
        <p className="text-sm text-text2" data-testid="learnings-empty">
          {canApprove
            ? "No learnings yet. When an outcome is checked, Oracle drafts one for you to keep. You can also add your own."
            : "No learnings yet. When an outcome is checked, Oracle drafts one, and an approver can keep it or add their own."}
        </p>
      ) : (
        <ul className="divide-y divide-line">
          {rows.map((l) => (
            <LearningRow
              key={`${l.id}-${l.status}`}
              l={l}
              targetName={names.nameOf(l)}
              canApprove={canApprove}
              onChanged={onChanged}
            />
          ))}
        </ul>
      )}
    </Panel>
  );
}

function LearningForm({
  names,
  onCancel,
  onAdded,
}: {
  names: ReturnType<typeof useTargetNames>;
  onCancel: () => void;
  onAdded: () => Promise<void>;
}) {
  const [statement, setStatement] = useState("");
  const [appliesTo, setAppliesTo] =
    useState<Learning["applies_to"]>("question_category");
  const [target, setTarget] = useState("");
  const [direction, setDirection] =
    useState<Learning["direction"]>("recommend_more");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await unwrap(
        api.POST("/v1/learnings", {
          body: {
            statement: statement.trim(),
            applies_to: appliesTo,
            target: target.trim(),
            direction,
            weight: 1,
          },
        }),
      );
      await onAdded();
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  }

  return (
    <form
      className="mb-3 grid grid-cols-3 gap-2.5 max-[600px]:grid-cols-1"
      data-testid="learning-form"
      onKeyDown={(e) => {
        if (e.key !== "Escape") return;
        // Escape on an open select or listbox only closes it; it is not asking to
        // cancel the form, so typed text must not be dropped because of it.
        const target = e.target as HTMLElement;
        if (e.defaultPrevented || target.tagName === "SELECT" || target.closest('[role="listbox"]')) return;
        e.preventDefault();
        void (async () => {
          if (
            await confirmInPage({
              action: "Discard learning",
              message: "Discard this learning? What you typed will be lost.",
              destructive: true,
            })
          )
            onCancel();
        })();
      }}
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      {error && (
        <div className="col-span-full">
          <Notice tone="error">{error}</Notice>
        </div>
      )}
      <label className="col-span-full flex flex-col gap-1 text-sm">
        <span className="text-text2">Learning</span>
        <textarea
          className="min-h-16 w-full rounded-lg border border-line-strong bg-surface px-2.5 py-1.5 text-[15px]"
          value={statement}
          maxLength={2000}
          onChange={(e) => setStatement(e.target.value)}
        />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-text2">What it is about</span>
        <select
          className={FIELD}
          value={appliesTo}
          onChange={(e) => {
            setAppliesTo(e.target.value as Learning["applies_to"]);
            setTarget("");
          }}
        >
          {Object.entries(APPLIES_TO).map(([v, label]) => (
            <option key={v} value={v}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-text2">{TARGET_WORD[appliesTo]}</span>
        {names.failed[appliesTo] ? (
          <>
            <input
              className={FIELD}
              value={target}
              maxLength={300}
              onChange={(e) => setTarget(e.target.value)}
              data-testid="learning-target-key"
            />
            <span className="text-sm text-text2">The list did not load; type its key.</span>
          </>
        ) : (
          <select
            className={FIELD}
            value={target}
            onChange={(e) => setTarget(e.target.value)}
          >
            <option value="">Pick one</option>
            {names.options[appliesTo].map((o) => (
              <option key={o.key} value={o.key}>
                {o.name}
              </option>
            ))}
          </select>
        )}
      </label>
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-text2">What Oracle should do</span>
        <select
          className={FIELD}
          value={direction}
          onChange={(e) =>
            setDirection(e.target.value as Learning["direction"])
          }
        >
          {Object.entries(DIRECTION).map(([v, label]) => (
            <option key={v} value={v}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <div className="col-span-full flex flex-wrap gap-2">
        <Button
          type="submit"
          variant="primary"
          disabled={busy || !statement.trim() || !target.trim()}
        >
          Add learning
        </Button>
        <Button type="button" variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function LearningRow({
  l,
  targetName,
  canApprove,
  onChanged,
}: {
  l: Learning;
  targetName: string;
  canApprove: boolean;
  onChanged: () => Promise<void>;
}) {
  const [retiring, setRetiring] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const active = l.status === "active";

  async function retire() {
    setBusy(true);
    setError(null);
    try {
      await unwrap(
        api.POST("/v1/learnings/{learning_id}/retire", {
          params: { path: { learning_id: l.id } },
          body: { reason: reason.trim() || null },
        }),
      );
      await onChanged();
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  }

  return (
    <li
      className="flex flex-col gap-1.5 py-2.5 text-sm"
      data-testid="learning-row"
      data-status={l.status}
    >
      <div className="flex flex-wrap items-start gap-2">
        <span className="min-w-0 flex-1">{l.statement}</span>
        <Chip kind={active ? "pass" : "line"} data-testid="learning-status">
          {active ? "Active" : "Retired"}
        </Chip>
      </div>
      <span className="text-text2">
        {APPLIES_TO[l.applies_to]} · {targetName} · {DIRECTION[l.direction]}
      </span>
      {!active && (
        <span className="text-text2">
          Retired{l.retired_at ? ` ${formatDate(l.retired_at)}` : ""}
          {l.retired_reason ? `: ${l.retired_reason}` : ""}
        </span>
      )}
      {error && <Notice tone="error">{error}</Notice>}
      {canApprove && active && !retiring && (
        <span>
          <Button variant="secondary" onClick={() => setRetiring(true)}>
            Retire
          </Button>
        </span>
      )}
      {canApprove && active && retiring && (
        <form
          className="flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void retire();
          }}
        >
          <label className="flex flex-col gap-1">
            <span className="text-text2">Reason</span>
            <input
              className={FIELD}
              value={reason}
              maxLength={2000}
              onChange={(e) => setReason(e.target.value)}
            />
          </label>
          <span className="flex flex-wrap gap-2">
            <Button type="submit" variant="primary" disabled={busy}>
              Retire learning
            </Button>
            <Button
              type="button"
              variant="secondary"
              onClick={() => setRetiring(false)}
            >
              Cancel
            </Button>
          </span>
        </form>
      )}
    </li>
  );
}
