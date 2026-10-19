/** Ring, Sparkline, Meter and Bars: the B1 charts. Pure SVG, server-component friendly. */

export type RingTone = "auto" | "accent" | "warn" | "pass" | "crit";

const TONE_VAR: Record<Exclude<RingTone, "auto">, string> = {
  accent: "var(--accent)",
  warn: "var(--warn)",
  pass: "var(--pass)",
  crit: "var(--crit)",
};

/**
 * Confidence ring, 0-100 (I3 rule 4: rings show confidence, never goal progress).
 * `auto` turns warn under 50. `hero` draws it for the inspector's dark head.
 */
export function Ring({
  value,
  size = 40,
  stroke = 5,
  tone = "auto",
  hero = false,
  label,
}: {
  value: number | null | undefined;
  size?: number;
  stroke?: number;
  tone?: RingTone;
  hero?: boolean;
  /** Accessible name; defaults to "Confidence N". */
  label?: string;
}) {
  const v = value == null || Number.isNaN(value) ? null : Math.max(0, Math.min(100, Math.round(value)));
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const t = tone === "auto" ? (v != null && v < 50 ? "warn" : "accent") : tone;
  const col = hero ? "var(--hero-accent)" : TONE_VAR[t];
  const fs = size >= 56 ? 18 : size >= 40 ? 14 : 13;
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      role="img"
      aria-label={label ?? (v == null ? "No confidence" : `Confidence ${v}`)}
      data-value={v ?? ""}
      className="flex-none"
    >
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke={hero ? "var(--hero-line)" : "var(--surface2)"}
        strokeWidth={stroke}
      />
      {v != null && v > 0 && (
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={col}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${((c * v) / 100).toFixed(1)} ${c.toFixed(1)}`}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      )}
      <text
        x="50%"
        y="50%"
        dy=".35em"
        textAnchor="middle"
        fontFamily="var(--font-sans)"
        fontWeight={600}
        fontSize={fs}
        fill={hero ? "var(--hero-text)" : "var(--text)"}
      >
        {v ?? "–"}
      </text>
    </svg>
  );
}

/** A trend line with the target as a dashed line and the latest point marked. */
export function Sparkline({
  values,
  target,
  width = 104,
  height = 36,
  label,
}: {
  values: number[];
  target?: number | null;
  width?: number;
  height?: number;
  label?: string;
}) {
  if (values.length === 0) return null;
  const all = target != null ? [...values, target] : values;
  const min = Math.min(...all);
  const max = Math.max(...all);
  const pad = 4;
  const sx = values.length > 1 ? (width - 2 * pad - 6) / (values.length - 1) : 0;
  const y = (v: number) => pad + (height - 2 * pad) * (1 - (v - min) / (max - min || 1));
  const pts = values.map((v, i) => [pad + i * sx, y(v)] as const);
  const line = pts.map(([a, b]) => `${a.toFixed(1)},${b.toFixed(1)}`).join(" ");
  const area = `M${pts[0][0].toFixed(1)},${height} L${line.replaceAll(" ", " L")} L${pts.at(-1)![0].toFixed(1)},${height} Z`;
  const last = pts.at(-1)!;
  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={label ?? `Trend ${values.join(", ")}${target != null ? `; target ${target}` : ""}`}
      className="flex-none"
    >
      <path d={area} fill="var(--spark-fill)" />
      {target != null && (
        <line
          x1={0}
          x2={width}
          y1={y(target)}
          y2={y(target)}
          stroke="var(--text2)"
          strokeWidth={1.5}
          strokeDasharray="4 4"
          data-target={target}
        />
      )}
      <polyline points={line} fill="none" stroke="var(--accent)" strokeWidth={2.5} strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={last[0]} cy={last[1]} r={4} fill="var(--accent)" stroke="var(--surface)" strokeWidth={2} />
    </svg>
  );
}

/** A bar with its value: "6/9", "12". */
export function Meter({
  value,
  max,
  label,
  showMax = true,
  width,
}: {
  value: number;
  max: number;
  /** Accessible name of the bar. */
  label: string;
  showMax?: boolean;
  width?: number;
}) {
  const p = max > 0 ? Math.max(0, Math.min(1, value / max)) : 0;
  return (
    <span className="flex min-w-0 items-center gap-2.5" style={width ? { width } : undefined}>
      <span
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={max}
        aria-valuenow={value}
        className="h-2 min-w-10 flex-1 overflow-hidden rounded bg-surface2 shadow-[inset_0_0_0_1px_var(--line)]"
      >
        <i className="block h-full rounded bg-accent" style={{ width: `${p * 100}%` }} />
      </span>
      <b className="tnum font-semibold whitespace-nowrap">
        {value}
        {showMax && `/${max}`}
      </b>
    </span>
  );
}

/** Weekly bars; the latest bar in accent. */
export function Bars({ values, width = 230, height = 56, label }: { values: number[]; width?: number; height?: number; label: string }) {
  if (values.length === 0) return null;
  const gap = 4;
  const max = Math.max(...values, 1);
  const bw = (width - gap * (values.length - 1)) / values.length;
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={label} className="flex-none">
      {values.map((v, i) => {
        const bh = Math.max(3, (v / max) * (height - 2));
        return (
          <rect
            key={i}
            x={i * (bw + gap)}
            y={height - bh}
            width={bw}
            height={bh}
            rx={3}
            fill={i === values.length - 1 ? "var(--accent)" : "var(--accent-mid)"}
          />
        );
      })}
    </svg>
  );
}
