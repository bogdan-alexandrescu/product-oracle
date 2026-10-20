"use client";

import type { ReactNode } from "react";

export type FilterChip<V extends string> = { value: V; label: ReactNode; count?: number | null; testId?: string };

/**
 * One choice of a few as toggle chips (All 104 · To review 80 · Feedback 9). They wrap,
 * never scroll sideways; 32 px tall, 44 px on a phone.
 */
export function FilterChips<V extends string>({
  label,
  items,
  value,
  onChange,
  testId,
}: {
  label: string;
  items: FilterChip<V>[];
  value: V;
  onChange: (v: V) => void;
  testId?: string;
}) {
  return (
    <div role="group" aria-label={label} data-testid={testId} className="flex min-w-0 flex-wrap gap-1.5">
      {items.map((it) => {
        const on = it.value === value;
        return (
          <button
            key={it.value}
            type="button"
            aria-pressed={on}
            data-testid={it.testId}
            onClick={() => onChange(it.value)}
            className={`flex h-8 items-center gap-1.5 rounded-full border px-3 text-sm font-medium whitespace-nowrap max-[639px]:h-11 max-[639px]:px-3.5 ${
              on ? "border-accent bg-accent text-on-accent" : "border-line-strong bg-surface text-text hover:bg-surface2"
            }`}
          >
            {it.label}
            {it.count != null && <b className={`tnum font-semibold ${on ? "text-on-accent" : "text-text2"}`}>{it.count}</b>}
          </button>
        );
      })}
    </div>
  );
}
