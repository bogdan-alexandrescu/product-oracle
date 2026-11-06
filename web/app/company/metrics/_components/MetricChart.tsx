"use client";

import { useState } from "react";

import { InfoTip } from "@/components/ds";

import { typicalChange, valueText, weekText, type MetricDetail } from "./lib";

const W = 320;
const H = 148;
const PAD = 8;
/** Room on the left for the y axis's values, and under the plot for the x axis's dates. */
const LEFT = 44;
const BOTTOM = 18;

const round = (v: number) => Math.round(v * 100) / 100;

/**
 * A metric's weekly values (up to 52 weeks): dates on the x axis (first, middle and last
 * week), the lowest and highest value on the y axis, the linked goal's target as a line, the
 * last 6 weeks shaded, a dashed line where its definition changed, and the normal range band
 * (the week before ± 2 × the typical change). Each week reads its value on hover or focus.
 */
export function MetricChart({ metric, target = null }: { metric: MetricDetail; target?: number | null }) {
  const [active, setActive] = useState<number | null>(null);
  const values = metric.values.slice(-52);
  if (values.length === 0) return <p className="text-sm text-text2">No weekly values yet</p>;
  // qa4-company-41: one value is no line; say it in words until there is a second week.
  if (values.length === 1)
    return (
      <p className="flex items-center gap-1.5 text-[15px]" data-testid="metric-chart-one">
        <span>
          Week of {weekText(values[0].week_start)}: <span className="tnum font-semibold">{valueText(values[0].value, metric.unit)}</span>
        </span>
        <InfoTip label="the chart" align="start">
          The chart starts once there are two weeks.
        </InfoTip>
      </p>
    );
  const nums = values.map((v) => v.value);
  const typical = typicalChange(nums);
  const prev = nums.length > 1 ? nums[nums.length - 2] : null;
  const band = typical != null && typical > 0 && prev != null ? { low: prev - 2 * typical, high: prev + 2 * typical } : null;
  const all = [...nums, ...(band ? [band.low, band.high] : []), ...(target != null ? [target] : [])];
  const min = Math.min(...all);
  const max = Math.max(...all);
  const right = W - PAD;
  const bottom = H - BOTTOM;
  const x = (i: number) => LEFT + (values.length > 1 ? (i * (right - LEFT)) / (values.length - 1) : (right - LEFT) / 2);
  const y = (v: number) => PAD + (bottom - PAD) * (1 - (v - min) / (max - min || 1));
  const line = values.map((v, i) => `${x(i).toFixed(1)},${y(v.value).toFixed(1)}`).join(" ");
  // Only when there are weeks before the last 6: shading every week marks nothing.
  const shaded = values.length > 6;
  const shadeFrom = x(values.length - 6) - 3;
  const changes = values.flatMap((v, i) => (i > 0 && v.definition_version !== values[i - 1].definition_version ? [i] : []));
  const first = values[0];
  const last = values[values.length - 1];
  const mid = Math.floor((values.length - 1) / 2);
  const ticks = [...new Set([0, mid, values.length - 1])];
  const step = values.length > 1 ? (right - LEFT) / (values.length - 1) : right - LEFT;
  const shown = active != null ? values[active] : null;
  const anchor = (i: number) => (i === 0 ? "start" : i === values.length - 1 ? "end" : "middle");
  return (
    <figure className="flex flex-col gap-1" data-testid="metric-chart">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-auto w-full overflow-visible"
        role="group"
        aria-label={`${values.length} weekly values from the week of ${weekText(first.week_start)} to the week of ${weekText(last.week_start)}, last ${valueText(last.value, metric.unit)}`}
        onMouseLeave={() => setActive(null)}
      >
        {shaded && <rect x={shadeFrom} y={0} width={right - shadeFrom} height={bottom} fill="var(--surface2)" />}
        {band && (
          <rect x={LEFT} y={y(band.high)} width={right - LEFT} height={Math.max(1, y(band.low) - y(band.high))} fill="var(--accent)" opacity={0.12}>
            <title>{`Normal range ${valueText(round(band.low), metric.unit)} to ${valueText(round(band.high), metric.unit)}`}</title>
          </rect>
        )}
        <line x1={LEFT} x2={right} y1={bottom} y2={bottom} stroke="var(--line)" />
        <text data-testid="chart-y" x={LEFT - 4} y={PAD + 4} textAnchor="end" fontSize={10} fill="var(--text2)">
          {valueText(round(max), metric.unit)}
        </text>
        <text data-testid="chart-y" x={LEFT - 4} y={bottom} textAnchor="end" fontSize={10} fill="var(--text2)">
          {valueText(round(min), metric.unit)}
        </text>
        {ticks.map((i) => (
          <text key={i} data-testid="chart-x" x={x(i)} y={H - 4} textAnchor={anchor(i)} fontSize={10} fill="var(--text2)">
            {weekText(values[i].week_start)}
          </text>
        ))}
        {target != null && (
          <g data-testid="chart-target">
            <title>{`Target ${valueText(target, metric.unit)}`}</title>
            <line x1={LEFT} x2={right} y1={y(target)} y2={y(target)} stroke="var(--pass)" strokeWidth={1.5} strokeDasharray="5 3" />
            <text x={right} y={y(target) + (y(target) < PAD + 12 ? 11 : -3)} textAnchor="end" fontSize={10} fill="var(--pass)">
              {`Target ${valueText(target, metric.unit)}`}
            </text>
          </g>
        )}
        {changes.map((i) => (
          <line key={i} x1={x(i)} x2={x(i)} y1={0} y2={bottom} stroke="var(--warn)" strokeDasharray="3 3">
            <title>{`The metric's definition changed in the week of ${weekText(values[i].week_start)}`}</title>
          </line>
        ))}
        <polyline points={line} fill="none" stroke="var(--accent)" strokeWidth={2} strokeLinejoin="round" />
        <circle cx={x(values.length - 1)} cy={y(last.value)} r={3} fill="var(--accent)" />
        {values.map((v, i) => (
          <rect
            key={v.week_start}
            role="button"
            tabIndex={0}
            aria-label={`Week of ${weekText(v.week_start)}: ${valueText(v.value, metric.unit)}`}
            x={x(i) - step / 2}
            y={0}
            width={step}
            height={bottom}
            fill="transparent"
            className="outline-none"
            onMouseEnter={() => setActive(i)}
            onFocus={() => setActive(i)}
            onBlur={() => setActive(null)}
          />
        ))}
        {shown && active != null && (
          <g pointerEvents="none">
            <line x1={x(active)} x2={x(active)} y1={0} y2={bottom} stroke="var(--line)" />
            <circle cx={x(active)} cy={y(shown.value)} r={3.5} fill="var(--surface)" stroke="var(--accent)" strokeWidth={2} />
            <text
              data-testid="chart-point-label"
              x={Math.min(Math.max(x(active), LEFT + 40), right - 40)}
              y={Math.max(y(shown.value) - 8, 10)}
              textAnchor="middle"
              fontSize={11}
              fontWeight={600}
              fill="var(--text)"
              paintOrder="stroke"
              stroke="var(--surface)"
              strokeWidth={3}
            >
              {`${weekText(shown.week_start)}: ${valueText(shown.value, metric.unit)}`}
            </text>
          </g>
        )}
      </svg>
      <figcaption className="flex items-center gap-1.5 text-[13px] text-text2">
        <span>
          {weekText(first.week_start)} to {weekText(last.week_start)}
        </span>
        <InfoTip label="the chart" align="start">
          One point per week.{target != null && ` The dashed green line is the goal's target, ${valueText(target, metric.unit)}.`}
          {shaded && " Shaded: the last 6 weeks."}
          {band && " The band is the normal range."}
          {changes.length > 0 && " Dashed: the definition changed."} Point at a week or tab to it to read its value.
        </InfoTip>
      </figcaption>
    </figure>
  );
}
