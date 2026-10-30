"use client";

import Link from "next/link";
import { useRef, type KeyboardEvent, type ReactNode } from "react";

export type Segment<V extends string> = {
  value: V;
  label: ReactNode;
  /** A count after the label. */
  count?: number | null;
  /** Render as a link (route segments) instead of a button. */
  href?: string;
  testId?: string;
  disabled?: boolean;
  /** A short tooltip: what the choice means. */
  title?: string;
  /** The segment's accessible name when its label alone says too little ("5" → "Ask 5 questions at a time"). */
  ariaLabel?: string;
};

/**
 * One choice of a few (v1 · v2 · v3, Brief · Full). Buttons carry aria-pressed;
 * link segments carry aria-current. Arrow keys move between segments.
 */
export function SegmentedControl<V extends string>({
  label,
  items,
  value,
  onChange,
  size = "md",
  fill = false,
}: {
  /** Accessible name of the group. */
  label: string;
  items: Segment<V>[];
  value: V | null | undefined;
  onChange?: (v: V) => void;
  size?: "sm" | "md";
  /** Spread over the row's width, the segments sharing it (a narrow phone's switch). */
  fill?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    const els = [...(ref.current?.querySelectorAll<HTMLElement>("[data-seg]") ?? [])];
    const at = els.indexOf(document.activeElement as HTMLElement);
    if (at < 0) return;
    e.preventDefault();
    els[(at + (e.key === "ArrowRight" ? 1 : -1) + els.length) % els.length]?.focus();
  };
  const h = `${size === "sm" ? "h-8 text-sm" : "h-9 text-[15px]"} ${fill ? "min-w-0 flex-auto justify-center px-1.5" : size === "sm" ? "px-3" : "px-3.5"}`;
  return (
    <div
      ref={ref}
      role="group"
      aria-label={label}
      onKeyDown={onKey}
      className={`${fill ? "flex w-full" : "inline-flex max-w-full flex-none"} overflow-x-auto rounded-button border border-line-strong bg-surface`}
    >
      {items.map((it) => {
        const on = it.value === value;
        const cls = `${h} flex items-center gap-2 border-r border-line font-medium whitespace-nowrap last:border-r-0 ${
          on ? "bg-accent text-on-accent" : "text-text hover:bg-surface2 disabled:text-text2"
        } disabled:cursor-not-allowed`;
        const inner = (
          <>
            {it.label}
            {it.count != null && <b className={`tnum font-semibold ${on ? "text-on-accent" : "text-text2"}`}>{it.count}</b>}
          </>
        );
        return it.href ? (
          <Link key={it.value} href={it.href} data-seg data-testid={it.testId} aria-current={on ? "page" : undefined} className={cls}>
            {inner}
          </Link>
        ) : (
          <button
            key={it.value}
            type="button"
            data-seg
            data-testid={it.testId}
            title={it.title}
            aria-label={it.ariaLabel}
            aria-pressed={on}
            disabled={it.disabled}
            onClick={() => onChange?.(it.value)}
            className={cls}
          >
            {inner}
          </button>
        );
      })}
    </div>
  );
}
