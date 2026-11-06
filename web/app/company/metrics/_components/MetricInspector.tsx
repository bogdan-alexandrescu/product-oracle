"use client";

import Link from "next/link";
import { useState } from "react";

import { Button, Chip, Inspector, InspectorRow, InspectorSection, toast } from "@/components/ds";
import { ErrorNote, INPUT } from "@/components/ui";
import { assess, goalViews } from "@/app/home/_goals";
import { api, unwrap } from "@/lib/api/client";
import { useCompanyZone, zoneDateTime } from "@/lib/dates";
import { useMe } from "@/lib/me";
import { errorMessage } from "@/lib/use-query";

import {
  DEFAULT_THRESHOLD_PCT,
  DIRECTION_LABEL,
  KIND_LABEL,
  SOURCE_LABEL,
  STATUS_KIND,
  STATUS_LABEL,
  VARIANCE_KIND,
  VARIANCE_LABEL,
  VARIANCE_STATE,
  changeText,
  recentWeeks,
  valueText,
  weekText,
  type Metric,
  type MetricDetail,
} from "./lib";
import { MetricChart } from "./MetricChart";
import type { Goal } from "./MetricForm";

/** The goal's distance to go in Home's words ("7 pts to go", "Target met", "Not below"); null when Home gives none. */
function distanceText(goals: Goal[], id: string): string | null {
  const view = goalViews(goals).find((g) => g.id === id);
  return view ? assess(view).text || null : null;
}

/** The linked goal's typed target, drawn on the chart (pass F F-14); null when it has none. */
function targetOf(goals: Goal[], id: string | null | undefined): number | null {
  const view = id ? goalViews(goals).find((g) => g.id === id) : undefined;
  return view?.target?.value ?? null;
}

/**
 * One metric: its chart, definition, linked goal with its distance to go, the output it
 * drives or the inputs that drive it, its variances, and, for approvers and owners, Edit,
 * Pull now (PostHog), Record a value (by hand or API; the metric's owner too) and Archive or
 * Restore.
 */
export function MetricInspector({
  metric,
  metrics,
  goals,
  onEdit,
  onChanged,
}: {
  metric: MetricDetail;
  metrics: Metric[];
  goals: Goal[];
  onEdit: () => void;
  onChanged: () => Promise<void>;
}) {
  const { me, can } = useMe();
  const zone = useCompanyZone();
  const mine = me?.user_id === metric.owner_id;
  const weeks = recentWeeks(zone);
  const [week, setWeek] = useState(weeks[0]);
  // A week from the list below that is older than the 13 the select offers is offered too.
  const weekChoices = weeks.includes(week) ? weeks : [...weeks, week];
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const path = { params: { path: { metric_id: metric.id } } };
  const goal = goals.find((g) => g.id === metric.goal_id);
  const drives = metrics.find((m) => m.id === metric.drives_metric_id);
  const inputs = metrics.filter((m) => m.drives_metric_id === metric.id);
  const typed = metric.source !== "posthog";
  const canRecord = typed && metric.status !== "archived" && can("record_metric_value", mine);
  const notNumber = value.trim() !== "" && Number.isNaN(Number(value));
  const recent = [...metric.values].reverse().slice(0, 13);

  async function run(call: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await call();
      await onChanged();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const actions = (
    <div className="flex flex-wrap gap-2">
      {can("update_metric") && metric.status !== "archived" && (
        <Button disabled={busy} onClick={onEdit}>
          Edit
        </Button>
      )}
      {can("pull_metric") && metric.source === "posthog" && metric.status !== "archived" && (
        <Button disabled={busy} onClick={() => run(() => unwrap(api.POST("/v1/metrics/{metric_id}/pull", path)))}>
          Pull now
        </Button>
      )}
      {metric.status === "archived"
        ? can("restore_metric") && (
            <Button disabled={busy} onClick={() => run(() => unwrap(api.POST("/v1/metrics/{metric_id}/restore", path)))}>
              Restore
            </Button>
          )
        : can("archive_metric") && (
            <Button
              disabled={busy}
              onClick={() =>
                run(async () => {
                  await unwrap(api.POST("/v1/metrics/{metric_id}/archive", path));
                  // pass F F-46: Archive acts at once, so the toast offers the way back.
                  toast({
                    message: `Archived ${metric.title}`,
                    action: { label: "Undo", onClick: () => void unwrap(api.POST("/v1/metrics/{metric_id}/restore", path)).then(onChanged) },
                  });
                })
              }
            >
              Archive
            </Button>
          )}
    </div>
  );

  return (
    <Inspector
      eyebrow={`${KIND_LABEL[metric.kind]} · ${SOURCE_LABEL[metric.source]}`}
      title={metric.title}
      testId="metric-inspector"
      chips={
        <>
          <Chip kind={STATUS_KIND[metric.status]} dot hero>
            {STATUS_LABEL[metric.status]}
          </Chip>
          {metric.change?.variance && (
            <Chip kind={VARIANCE_KIND[metric.change.variance]} hero>
              {VARIANCE_LABEL[metric.change.variance]}
            </Chip>
          )}
        </>
      }
      stats={[
        { label: "Last week", figure: <span className="tnum text-[22px] font-bold">{valueText(metric.last_week?.value, metric.unit)}</span> },
        { label: "Change", figure: <span className="tnum text-[22px] font-bold">{metric.change ? changeText(metric.change.value, metric.change.pct) : "—"}</span> },
      ]}
    >
      <InspectorSection label="Weekly values">
        <MetricChart metric={metric} target={metric.kind === "output" ? targetOf(goals, metric.goal_id) : null} />
        {/* pass F F-14: each week's number, newest first, with Edit for whoever records them. */}
        {recent.length > 0 && (
          <ul data-testid="metric-weeks" className="mt-2 flex flex-col text-[15px]">
            {recent.map((v) => (
              <li key={v.week_start} className="flex min-h-8 items-center gap-2 border-t border-line first:border-t-0">
                <span className="tnum min-w-0 flex-1 text-text2">Week of {weekText(v.week_start)}</span>
                <span className="tnum font-semibold">{valueText(v.value, metric.unit)}</span>
                {canRecord && (
                  <Button
                    variant="ghost"
                    aria-label={`Change week of ${weekText(v.week_start)}`}
                    onClick={() => {
                      setWeek(v.week_start);
                      setValue(String(v.value));
                    }}
                  >
                    Change
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </InspectorSection>
      <InspectorSection label="Definition">
        <p className="text-[15px]">{metric.description}</p>
        {metric.query ? (
          <pre className="mt-1 overflow-x-auto rounded-lg bg-surface2 px-2 py-1.5 text-[13px] whitespace-pre-wrap [overflow-wrap:anywhere]">{metric.query}</pre>
        ) : (
          <p className="text-sm text-text2">{metric.source === "manual" ? "Entered by hand" : "Written through the API"}</p>
        )}
        <InspectorRow value={metric.unit}>Unit</InspectorRow>
        <InspectorRow value={DIRECTION_LABEL[metric.direction]}>Good direction</InspectorRow>
        <InspectorRow value={metric.threshold_pct != null ? `${metric.threshold_pct}%` : `Default (${DEFAULT_THRESHOLD_PCT}%)`}>Alert size</InspectorRow>
        <InspectorRow value={metric.owner_name ?? "—"}>Owner</InspectorRow>
        {metric.definitions.length > 1 && (
          <p className="text-sm text-text2">
            Definition {metric.definition_version}, changed {zoneDateTime(metric.definitions[metric.definitions.length - 1].at, zone)}
          </p>
        )}
        {metric.last_error && <ErrorNote>{metric.last_error}</ErrorNote>}
      </InspectorSection>
      {(goal || drives || inputs.length > 0) && (
        <InspectorSection label={metric.kind === "input" ? "Drives" : goal ? "Goal and inputs" : "Inputs"}>
          {goal && (
            <InspectorRow value={distanceText(goals, goal.id)}>
              <Link href={`/baseline?entity=${goal.id}`} className="hover:underline">
                {goal.title}
              </Link>
            </InspectorRow>
          )}
          {drives && <InspectorRow>{drives.title}</InspectorRow>}
          {inputs.map((m) => (
            <InspectorRow key={m.id}>{m.title}</InspectorRow>
          ))}
        </InspectorSection>
      )}
      <InspectorSection label="Unusual weeks">
        {metric.variances.length === 0 ? (
          <p className="text-sm text-text2">No unusual week yet</p>
        ) : (
          <ul className="flex flex-col gap-1 text-[15px]" data-testid="metric-variances">
            {metric.variances.map((v) => (
              <li key={v.id} className="flex flex-wrap items-center gap-2">
                <span className="tnum">Week of {weekText(v.week_start)}</span>
                <Chip kind={VARIANCE_KIND[v.direction]}>{VARIANCE_LABEL[v.direction]}</Chip>
                <span className="text-text2">{VARIANCE_STATE[v.status]}</span>
              </li>
            ))}
          </ul>
        )}
      </InspectorSection>
      {canRecord && (
        <InspectorSection label="Record a value">
          <div className="flex flex-wrap items-end gap-2">
            <label className="flex flex-col gap-1 text-sm font-semibold text-text2">
              Week
              <select className={`${INPUT} w-auto`} value={week} onChange={(e) => setWeek(e.target.value)}>
                {weekChoices.map((w) => (
                  <option key={w} value={w}>
                    Week of {weekText(w)}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-sm font-semibold text-text2">
              Value
              <input
                className={`${INPUT} w-28`}
                inputMode="decimal"
                value={value}
                aria-invalid={notNumber}
                aria-describedby={notNumber ? "metric-value-error" : undefined}
                onChange={(e) => setValue(e.target.value)}
              />
            </label>
            <Button
              disabled={busy || value.trim() === "" || notNumber}
              onClick={() =>
                run(async () => {
                  await unwrap(api.PUT("/v1/metrics/{metric_id}/values/{week_start}", { params: { path: { metric_id: metric.id, week_start: week } }, body: { value: Number(value) } }));
                  setValue("");
                  // pass F F-46: say what was saved.
                  toast({ message: `Saved week of ${weekText(week)}: ${valueText(Number(value), metric.unit)}` });
                })
              }
            >
              Record
            </Button>
          </div>
          {notNumber && (
            <p id="metric-value-error" className="mt-1 text-[13px] font-medium text-crit">
              Enter a number
            </p>
          )}
        </InspectorSection>
      )}
      <div className="flex flex-col gap-2 px-5 py-3 max-[600px]:px-4">
        {actions}
        {error && <ErrorNote>{error}</ErrorNote>}
      </div>
    </Inspector>
  );
}
