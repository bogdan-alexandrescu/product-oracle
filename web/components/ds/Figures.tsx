import type { ReactNode } from "react";

/** Initials in a circle. `oracle` is the Oracle's own lime avatar; `me` the signed-in user's. */
/**
 * Two letters for a person: from their name ("Ada Lovelace" -> "AL"), else from an
 * email's local part ("pat.lee@" -> "PL", "admin@" -> "AD"), never from the domain.
 */
export function initialsOf(name: string): string {
  const local = name.includes("@") ? name.slice(0, name.indexOf("@")) : name;
  const parts = local.split(/[\s._-]+/).filter(Boolean);
  const letters = parts.length >= 2 ? parts[0]![0]! + parts[1]![0]! : (parts[0] ?? "").slice(0, 2);
  return letters.toUpperCase() || "?";
}

export function Avatar({
  name,
  initials,
  size = 28,
  tone = "default",
}: {
  name: string;
  initials?: string;
  size?: 28 | 32 | 38;
  tone?: "default" | "oracle" | "me";
}) {
  const ini = initials ?? initialsOf(name);
  const cls =
    tone === "oracle"
      ? "bg-lime text-on-lime"
      : tone === "me"
        ? "bg-accent text-on-accent"
        : "border border-line bg-surface2 text-text";
  return (
    <span
      role="img"
      aria-label={name}
      title={name}
      style={{ width: size, height: size }}
      className={`inline-grid flex-none place-items-center rounded-full text-[13px] leading-none font-semibold ${cls}`}
    >
      {ini}
    </span>
  );
}

const usdFmt = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2 });

/**
 * Cost (P3d: secondary). One small mono figure; `prominent` only on cost approvals
 * and overruns. With `of`, shows "spent / of".
 */
export function CostFigure({
  usd,
  of,
  est = false,
  prominent = false,
  hero = false,
}: {
  usd: number | null | undefined;
  of?: number | null;
  /** An estimate: "$64.00 est." */
  est?: boolean;
  prominent?: boolean;
  /** Inside an Inspector head. */
  hero?: boolean;
}) {
  if (usd == null) return <span className="font-mono text-[13px] text-text2">–</span>;
  const text = `${usdFmt.format(usd)}${of != null ? ` / ${usdFmt.format(of)}` : ""}${est ? " est." : ""}`;
  if (prominent) {
    const over = of != null && usd > of;
    return (
      <span
        data-cost="prominent"
        className={`tnum inline-flex h-7 items-center rounded-lg px-2 font-mono text-[15px] font-medium whitespace-nowrap ${
          over ? "bg-crit-bg text-crit" : "bg-warn-bg text-warn"
        }`}
      >
        {text}
      </span>
    );
  }
  return (
    <span
      data-cost="small"
      className={`tnum font-mono text-[13px] leading-none font-medium whitespace-nowrap ${hero ? "text-hero-text2" : "text-text2"}`}
    >
      {text}
    </span>
  );
}

/** A big numeral with an optional "/of" and unit, B1's display figure. */
export function Numeral({
  value,
  of,
  unit,
  tone,
  size = "md",
}: {
  value: ReactNode;
  of?: ReactNode;
  unit?: ReactNode;
  tone?: "crit" | "warn";
  size?: "sm" | "md" | "lg";
}) {
  const sz = size === "lg" ? "text-[44px] leading-[46px]" : size === "sm" ? "text-[28px] leading-8" : "text-[34px] leading-9";
  return (
    <span
      className={`tnum font-display font-bold tracking-[-0.03em] ${sz} ${
        tone === "crit" ? "text-crit" : tone === "warn" ? "text-warn" : ""
      }`}
    >
      {value}
      {(of != null || unit != null) && (
        <small className="font-display text-lg font-semibold tracking-normal text-text2">
          {of != null && `/${of}`}
          {unit}
        </small>
      )}
    </span>
  );
}

export type Kpi = {
  label: string;
  value: ReactNode;
  of?: ReactNode;
  unit?: ReactNode;
  tone?: "crit" | "warn";
  /** Rendered after the label: an InfoTip, a ring. */
  extra?: ReactNode;
  testId?: string;
};

/** A strip of big numerals with one-to-three word labels (Baseline's count strip). */
export function KpiStrip({ items, label, hero = false }: { items: Kpi[]; label?: string; hero?: boolean }) {
  return (
    <dl
      aria-label={label}
      className={`grid overflow-hidden ${hero ? "" : "rounded-panel border border-line bg-surface shadow-panel"}`}
      style={{ gridTemplateColumns: `repeat(${items.length}, minmax(0, 1fr))` }}
    >
      {items.map((k) => (
        <div
          key={k.label}
          data-testid={k.testId}
          className="flex min-w-0 flex-col-reverse justify-end border-r border-line px-[18px] pt-3.5 pb-3 last:border-r-0 max-[600px]:px-3"
        >
          <dt className="flex items-center gap-1.5 truncate text-[13px] leading-4 font-semibold tracking-[0.02em] text-text2">
            {k.label}
            {k.extra}
          </dt>
          <dd>
            <Numeral value={k.value} of={k.of} unit={k.unit} tone={k.tone} />
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** Goal progress (I3 rule 4): distance to go in the goal's own unit, "5 pts to go". */
export function ToGo({ current, target, unit }: { current: number; target: number; unit?: string | null }) {
  const d = Math.round(Math.abs(target - current) * 10) / 10;
  const u = unit === "%" ? " pts" : unit && unit !== "" ? ` ${unit}` : "";
  if (d === 0) return <span className="font-semibold whitespace-nowrap text-pass">At target</span>;
  return (
    <span className="font-semibold whitespace-nowrap">
      <b className="tnum font-bold">{d}</b>
      {u} to go
    </span>
  );
}
