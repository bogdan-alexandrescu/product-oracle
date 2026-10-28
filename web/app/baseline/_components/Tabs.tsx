"use client";

import { useRef, type KeyboardEvent } from "react";

import { ScrollStrip, type ChipKind } from "@/components/ds";

export type TabItem<V extends string> = { id: V; label: string; count?: number; kind?: ChipKind };

const COUNT: Partial<Record<ChipKind, string>> = {
  crit: "bg-crit-bg text-crit",
  warn: "bg-warn-bg text-warn",
  acc: "bg-accent-soft text-accent-ink",
};

/**
 * The kit's SegmentedControl look with tab semantics (role tablist/tab, aria-selected,
 * arrow keys move and select), since each segment swaps the panel below. A count shows
 * as a small status pill, B1's "Flagged 1 · Conflicts 2 · Proposals 3".
 */
export function Tabs<V extends string>({
  label,
  items,
  value,
  onChange,
}: {
  label: string;
  items: TabItem<V>[];
  value: V;
  onChange: (v: V) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const onKey = (e: KeyboardEvent) => {
    const at = items.findIndex((t) => t.id === value);
    let next = -1;
    if (e.key === "ArrowRight") next = (at + 1) % items.length;
    else if (e.key === "ArrowLeft") next = (at - 1 + items.length) % items.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = items.length - 1;
    else return;
    e.preventDefault();
    onChange(items[next]!.id);
    ref.current?.querySelectorAll<HTMLElement>('[role="tab"]')[next]?.focus();
  };
  // One line that scrolls sideways when the tabs do not fit (a phone), as the Plan's strip
  // does: never an uneven wrapped grid (qa-plan-50).
  return (
    <div className="flex max-w-full min-w-0 flex-none self-start overflow-hidden rounded-button border border-line-strong bg-surface max-[600px]:self-stretch">
      <ScrollStrip ref={ref} role="tablist" aria-label={label} onKeyDown={onKey} className="min-w-0 flex-1" stripClassName="items-stretch" data-testid="baseline-tabs">
        {items.map((t) => {
          const on = t.id === value;
          const pill = t.count != null && t.count > 0 && !on ? (COUNT[t.kind ?? "acc"] ?? COUNT.acc) : on ? "bg-surface text-accent-ink" : "bg-surface2 text-text2";
          return (
            <button
              key={t.id}
              type="button"
              role="tab"
              id={`tab-${t.id}`}
              aria-selected={on}
              aria-controls={`panel-${t.id}`}
              tabIndex={on ? 0 : -1}
              onClick={() => onChange(t.id)}
              className={`flex h-9 flex-none items-center justify-center gap-2 border-r border-line px-3.5 text-[15px] font-medium whitespace-nowrap last:border-r-0 max-[600px]:gap-1.5 max-[600px]:px-3 max-[600px]:text-sm ${
                on ? "bg-accent text-on-accent" : "text-text hover:bg-surface2"
              }`}
            >
              {t.label}
              {t.count != null && (
                <b
                  data-testid={`tab-count-${t.id}`}
                  className={`tnum inline-grid h-[22px] min-w-[22px] place-items-center rounded-full px-1.5 text-[13px] leading-none font-semibold ${pill}`}
                >
                  {t.count}
                </b>
              )}
            </button>
          );
        })}
      </ScrollStrip>
    </div>
  );
}
