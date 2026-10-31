import { typicalChange, valueText, weekText, type MetricDetail } from "./lib";

const W = 320;
const H = 132;
const PAD = 8;

/**
 * A metric's weekly values (up to 52 weeks): the last 6 weeks shaded, a dashed line where its
 * definition changed, and the normal range band (the week before ± 2 × the typical change).
 */
export function MetricChart({ metric }: { metric: MetricDetail }) {
  const values = metric.values.slice(-52);
  if (values.length === 0) return <p className="text-sm text-text2">No weekly values yet</p>;
  // qa4-company-41: one value is no line; say it in words until there is a second week.
  if (values.length === 1)
    return (
      <p className="text-[15px]" data-testid="metric-chart-one">
        Week of {weekText(values[0].week_start)}: <span className="tnum font-semibold">{valueText(values[0].value, metric.unit)}</span>
        <span className="block text-[13px] text-text2">The chart starts once there are two weeks.</span>
      </p>
    );
  const nums = values.map((v) => v.value);
  const typical = typicalChange(nums);
  const prev = nums.length > 1 ? nums[nums.length - 2] : null;
  const band = typical != null && typical > 0 && prev != null ? { low: prev - 2 * typical, high: prev + 2 * typical } : null;
  const all = band ? [...nums, band.low, band.high] : nums;
  const min = Math.min(...all);
  const max = Math.max(...all);
  const x = (i: number) => PAD + (values.length > 1 ? (i * (W - 2 * PAD)) / (values.length - 1) : (W - 2 * PAD) / 2);
  const y = (v: number) => PAD + (H - 2 * PAD) * (1 - (v - min) / (max - min || 1));
  const line = values.map((v, i) => `${x(i).toFixed(1)},${y(v.value).toFixed(1)}`).join(" ");
  // Only when there are weeks before the last 6: shading every week marks nothing.
  const shaded = values.length > 6;
  const shadeFrom = x(values.length - 6) - 3;
  const changes = values.flatMap((v, i) => (i > 0 && v.definition_version !== values[i - 1].definition_version ? [i] : []));
  const first = values[0];
  const last = values[values.length - 1];
  return (
    <figure className="flex flex-col gap-1" data-testid="metric-chart">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-auto w-full"
        role="img"
        aria-label={`${values.length} weekly values from the week of ${weekText(first.week_start)} to the week of ${weekText(last.week_start)}, last ${valueText(last.value, metric.unit)}`}
      >
        {shaded && <rect x={shadeFrom} y={0} width={W - shadeFrom} height={H} fill="var(--surface2)" />}
        {band && (
          <rect x={0} y={y(band.high)} width={W} height={Math.max(1, y(band.low) - y(band.high))} fill="var(--accent)" opacity={0.12}>
            <title>{`Normal range ${valueText(Math.round(band.low * 100) / 100, metric.unit)} to ${valueText(Math.round(band.high * 100) / 100, metric.unit)}`}</title>
          </rect>
        )}
        {changes.map((i) => (
          <line key={i} x1={x(i)} x2={x(i)} y1={0} y2={H} stroke="var(--warn)" strokeDasharray="3 3">
            <title>{`The metric's definition changed in the week of ${weekText(values[i].week_start)}`}</title>
          </line>
        ))}
        <polyline points={line} fill="none" stroke="var(--accent)" strokeWidth={2} strokeLinejoin="round" />
        <circle cx={x(values.length - 1)} cy={y(last.value)} r={3} fill="var(--accent)" />
      </svg>
      <figcaption className="text-[13px] text-text2">
        Week of {weekText(first.week_start)} to week of {weekText(last.week_start)}.{shaded && " Shaded: the last 6 weeks."}
        {band && " The band is the normal range."}
        {changes.length > 0 && " Dashed: the definition changed."}
      </figcaption>
    </figure>
  );
}
