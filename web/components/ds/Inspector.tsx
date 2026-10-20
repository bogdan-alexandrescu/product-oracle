import type { ReactNode } from "react";

import { Numeral } from "./Figures";

export type InspectorStat = {
  label: string;
  value?: ReactNode;
  of?: ReactNode;
  tone?: "crit" | "warn";
  /** Replaces the numeral, e.g. a Ring. */
  figure?: ReactNode;
  /** Rendered after the label, on its line: an InfoTip. */
  extra?: ReactNode;
  testId?: string;
};

/**
 * B1's Atlas inspector: a dark head (eyebrow, title, chips, Open), a strip of big
 * numerals, then sections. Right of the table on desktop, below it on a phone.
 */
export function Inspector({
  eyebrow,
  title,
  chips,
  action,
  head,
  stats,
  statColumns,
  children,
  label,
  testId,
}: {
  /** "Feature · selected" */
  eyebrow: ReactNode;
  title?: ReactNode;
  chips?: ReactNode;
  /** "Open": a hero-variant Button or LinkButton. */
  action?: ReactNode;
  /** Extra content in the dark head (a ring and numerals). */
  head?: ReactNode;
  stats?: InspectorStat[];
  /** Stats per row; more stats than this wrap onto a second row (default: all on one). */
  statColumns?: number;
  children?: ReactNode;
  /** Accessible name of the region; defaults to the title when it is a string. */
  label?: string;
  testId?: string;
}) {
  const cols = Math.max(1, Math.min(statColumns ?? stats?.length ?? 1, stats?.length ?? 1));
  return (
    <aside
      aria-label={label ?? (typeof title === "string" ? title : "Inspector")}
      data-testid={testId}
      className="min-w-0 overflow-hidden rounded-inspector border border-line bg-surface shadow-panel max-[600px]:rounded-[14px]"
    >
      <div className="bg-hero px-5 pt-4 pb-[18px] text-hero-text max-[600px]:px-4">
        <div className="flex items-center justify-between gap-3">
          <span className="text-[13px] leading-4 font-semibold tracking-[0.02em] text-hero-text2">{eyebrow}</span>
          {action}
        </div>
        {title && (
          <h2 className="mt-1.5 mb-2.5 font-display text-[22px] leading-[27px] font-bold tracking-heading break-words">{title}</h2>
        )}
        {chips && <div className="flex flex-wrap gap-2">{chips}</div>}
        {head}
      </div>
      {stats && stats.length > 0 && (
        <dl className="grid border-b border-line" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
          {stats.map((s, i) => (
            <div
              key={s.label}
              data-testid={s.testId}
              className={`flex min-w-0 flex-col-reverse justify-end pt-3.5 pr-2 pb-3 pl-5 max-[600px]:pl-4 ${
                (i + 1) % cols !== 0 && i !== stats.length - 1 ? "border-r border-line" : ""
              } ${i >= cols ? "border-t border-line" : ""}`}
            >
              <dt className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[13px] leading-4 font-semibold tracking-[0.02em] text-text2">
                <span className="truncate">{s.label}</span>
                {s.extra}
              </dt>
              <dd>{s.figure ?? <Numeral value={s.value} of={s.of} tone={s.tone} />}</dd>
            </div>
          ))}
        </dl>
      )}
      {children}
    </aside>
  );
}

/** A section of the inspector: a label (with optional tools), then content. */
export function InspectorSection({
  label,
  tools,
  children,
  testId,
}: {
  label?: ReactNode;
  tools?: ReactNode;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <section data-testid={testId} className="border-b border-line px-5 py-3.5 last:border-b-0 max-[600px]:px-4 max-[600px]:py-3">
      {label && (
        <div className="mb-2.5 flex items-center gap-2 text-[13px] leading-4 font-semibold tracking-[0.02em] text-text2">
          {label}
          {tools && <span className="ml-auto flex items-center gap-2">{tools}</span>}
        </div>
      )}
      {children}
    </section>
  );
}

/** One line in an inspector list: label left, value right. */
export function InspectorRow({ children, value }: { children: ReactNode; value?: ReactNode }) {
  return (
    <div className="flex min-h-8 items-center gap-2.5">
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {value != null && <span className="tnum flex-none font-semibold">{value}</span>}
    </div>
  );
}
