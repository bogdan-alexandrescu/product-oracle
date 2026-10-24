"use client";

import Link from "next/link";
import { useState } from "react";

import { Button, Chip, Inspector, InspectorRow, InspectorSection } from "@/components/ds";
import { ErrorNote, INPUT } from "@/components/ui";
import { api, unwrap } from "@/lib/api/client";
import { useCompanyZone, zoneDateTime } from "@/lib/dates";
import { useMe } from "@/lib/me";
import { errorMessage } from "@/lib/use-query";

import {
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

/** "7 pts to go" / "Target met": how far the goal's current value is from its target. */
function distanceText(goal: Goal): string | null {
  const { current, target, unit, comparison } = goal.attrs as { current?: unknown; target?: unknown; unit?: string; comparison?: string };
  if (typeof current !== "number" || typeof target !== "number") return null;
  const below = comparison === "below" || comparison === "at_most";
  const gap = Math.round((below ? current - target : target - current) * 100) / 100;
  if (gap <= 0) return "Target met";
  return unit === "%" ? `${gap} pts to go` : `${gap} ${unit ?? ""} to go`.trim();
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
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const path = { params: { path: { metric_id: metric.id } } };
  const goal = goals.find((g) => g.id === metric.goal_id);
  const drives = metrics.find((m) => m.id === metric.drives_metric_id);
  const inputs = metrics.filter((m) => m.drives_metric_id === metric.id);
  const typed = metric.source !== "posthog";
  const canRecord = typed && metric.status !== "archived" && can("record_metric_value", mine);

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
            <Button disabled={busy} onClick={() => run(() => unwrap(api.POST("/v1/metrics/{metric_id}/archive", path)))}>
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
        <MetricChart metric={metric} />
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
        <InspectorRow value={metric.threshold_pct != null ? `${metric.threshold_pct}%` : "Default"}>Threshold</InspectorRow>
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
            <InspectorRow value={distanceText(goal)}>
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
      <InspectorSection label="Variances">
        {metric.variances.length === 0 ? (
          <p className="text-sm text-text2">No variance yet</p>
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
                {weeks.map((w) => (
                  <option key={w} value={w}>
                    Week of {weekText(w)}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-sm font-semibold text-text2">
              Value
              <input className={`${INPUT} w-28`} inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} />
            </label>
            <Button
              disabled={busy || value.trim() === "" || Number.isNaN(Number(value))}
              onClick={() =>
                run(async () => {
                  await unwrap(api.PUT("/v1/metrics/{metric_id}/values/{week_start}", { params: { path: { metric_id: metric.id, week_start: week } }, body: { value: Number(value) } }));
                  setValue("");
                })
              }
            >
              Record
            </Button>
          </div>
        </InspectorSection>
      )}
      <div className="flex flex-col gap-2 px-5 py-3 max-[600px]:px-4">
        {actions}
        {error && <ErrorNote>{error}</ErrorNote>}
      </div>
    </Inspector>
  );
}
