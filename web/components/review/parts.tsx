"use client";

import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

import { Button, Chip, Icon, StatusMark, type ChipKind, type MarkState } from "@/components/ds";
import type { FeedbackStatus, LlmJob, Verdict } from "@/lib/api/client";
import { formatDateTime, JOB_STATUS_LABEL, STATUS_LABEL, VERDICT_LABEL } from "@/lib/format";

/*
 * Small parts of the version / review view built on the ds kit. Candidates for the kit:
 * TabBar (underline tabs with role=tab), Menu (a disclosure button with a popover), Kbd,
 * and the form-field classes.
 */

/** Form fields on tokens (13 px label, 15 px input). */
export const FIELD_LABEL = "flex flex-col gap-1 text-[13px] font-semibold tracking-[0.02em] text-text2";
export const TEXTAREA =
  "w-full rounded-lg border border-line-strong bg-surface px-2.5 py-1.5 text-[15px] font-normal tracking-normal text-text placeholder:text-text2";
export const SELECT =
  "h-8 rounded-lg border border-line-strong bg-surface px-2 text-sm font-medium tracking-normal text-text";

export const VERDICT_KIND: Record<Verdict, ChipKind> = { approved: "pass", changes_requested: "warn", rejected: "crit" };

/** The mark a section's row shows: its verdict, or a lock once the version's review is
 * closed. An approval that lapsed (approver demoted or removed, token or grant revoked)
 * never counts: it shows as lapsed, as the section view's review bar says. */
export function sectionMark(verdict: Verdict | null | undefined, closed = false, lapsed = false): MarkState {
  if (closed) return "locked";
  if (verdict === "approved" && lapsed) return "lapsed";
  return verdict ?? "none";
}

/** A section's review state as a mark (shape and colour); never a ✓ unless approved. */
export function SectionMark({
  verdict,
  closed = false,
  lapsed = false,
  size = 16,
}: {
  verdict: Verdict | null | undefined;
  closed?: boolean;
  lapsed?: boolean;
  size?: 16 | 20;
}) {
  return <StatusMark state={sectionMark(verdict, closed, lapsed)} size={size} />;
}

export function VerdictChip({ verdict }: { verdict: Verdict }) {
  return <Chip kind={VERDICT_KIND[verdict]}>{VERDICT_LABEL[verdict]}</Chip>;
}

const FEEDBACK_KIND: Record<FeedbackStatus, ChipKind> = { open: "acc", addressed: "pass", declined: "na", superseded: "na" };

export function FeedbackStatusChip({ status }: { status: FeedbackStatus }) {
  return <Chip kind={FEEDBACK_KIND[status]}>{STATUS_LABEL[status]}</Chip>;
}

const JOB_KIND: Record<LlmJob["status"], ChipKind> = {
  queued: "na",
  running: "acc",
  succeeded: "pass",
  failed: "crit",
  cancelled: "na",
};

/** `at`: when a failed job failed, so its refusal reads as then, not now (#556). */
export function JobStatusChip({ status, at }: { status: LlmJob["status"]; at?: string | null }) {
  const failedAt = status === "failed" && at ? at : null;
  return (
    <Chip kind={JOB_KIND[status]} dot data-testid={failedAt ? "job-failed" : undefined}>
      {JOB_STATUS_LABEL[status]}
      {failedAt && ` ${formatDateTime(failedAt)}`}
    </Chip>
  );
}

/** Brief or Detail (O1f); the testid and data-layer are what the specs read. */
export function LayerChip({ layer }: { layer: "brief" | "detail" | null | undefined }) {
  if (!layer) return null;
  return (
    <span data-testid="layer-badge" data-layer={layer} className="inline-flex flex-none">
      <Chip kind={layer === "brief" ? "acc" : "line"} title={layer === "brief" ? "In the brief" : "Detail: in the full document only"}>
        {layer === "brief" ? "Brief" : "Detail"}
      </Chip>
    </span>
  );
}

export function LockedChip() {
  return (
    <Chip kind="pass" title="Approved sections are reported as locked to the agent track">
      <Icon name="lock" size={16} />
      Locked
    </Chip>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-grid h-6 min-w-6 place-items-center rounded-md border border-line-strong bg-surface2 px-1 font-mono text-[13px] leading-none text-text">
      {children}
    </kbd>
  );
}

/** A quoted anchor: the text a comment or feedback item is on. */
export function Quote({ children }: { children: ReactNode }) {
  return (
    <span className="mt-1 line-clamp-2 block border-l-[3px] border-warn pl-2 text-sm leading-5 text-text2">{children}</span>
  );
}

/** A one-line error under a control. */
export function InlineError({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="mt-1.5 text-sm font-medium text-crit">
      {children}
    </p>
  );
}

/** Underline tabs (role=tab); arrow keys move between them. */
export function TabBar<T extends string>({
  label,
  tabs,
  value,
  onChange,
  size = "md",
  idFor,
}: {
  label: string;
  tabs: { id: T; label: ReactNode; count?: number | null }[];
  value: T;
  onChange: (id: T) => void;
  size?: "sm" | "md";
  /** Element ids for the tabs (`${id}-panel` is the tab panel's), so the panel is labelled by its tab. */
  idFor?: (id: T) => string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    const els = [...(ref.current?.querySelectorAll<HTMLElement>("[role=tab]") ?? [])];
    const at = els.indexOf(document.activeElement as HTMLElement);
    if (at < 0) return;
    e.preventDefault();
    els[(at + (e.key === "ArrowRight" ? 1 : -1) + els.length) % els.length]?.focus();
  };
  // The tabs wrap rather than scroll sideways (I3 PRD navigation: no sideways strips).
  return (
    <div ref={ref} role="tablist" aria-label={label} onKeyDown={onKey} className="flex max-w-full flex-wrap gap-x-1 border-b border-line">
      {tabs.map((t) => {
        const on = t.id === value;
        return (
          <button
            key={t.id}
            role="tab"
            type="button"
            id={idFor?.(t.id)}
            aria-selected={on}
            aria-controls={on && idFor ? `${idFor(t.id)}-panel` : undefined}
            tabIndex={on ? 0 : -1}
            onClick={() => onChange(t.id)}
            className={`-mb-px flex flex-none items-center gap-1.5 border-b-2 whitespace-nowrap max-[639px]:h-11 ${
              size === "sm" ? "h-9 px-2 text-sm" : "h-10 px-2 text-[15px]"
            } ${on ? "border-accent font-semibold text-text" : "border-transparent font-medium text-text2 hover:text-text"}`}
          >
            {t.label}
            {t.count != null && (
              <span className={`tnum text-[13px] font-bold ${on ? "text-accent-ink" : "text-text2"}`}>{t.count}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/**
 * A secondary button that opens a small panel of actions; Escape or a click outside closes
 * it. `iconOnly` shows just the icon (the label becomes its accessible name); children may
 * be a function that gets `close`, for items that act and then close the panel. `avoid` (a
 * CSS selector) names what the open panel must not cover: it moves left of it when it would.
 */
export function Menu({
  label,
  icon,
  children,
  align = "end",
  iconOnly = false,
  avoid,
}: {
  label: string;
  icon?: Parameters<typeof Button>[0]["icon"];
  children: ReactNode | ((close: () => void) => ReactNode);
  align?: "start" | "end";
  iconOnly?: boolean;
  avoid?: string;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const [shift, setShift] = useState(0);
  // qa-docs-75: a panel opening over what it must not cover (the review panel's totals) moves
  // left of it, as long as it stays on screen.
  useLayoutEffect(() => {
    if (!open || !avoid || !pop.current) return;
    const p = pop.current.getBoundingClientRect();
    const other = [...document.querySelectorAll<HTMLElement>(avoid)].find((el) => el.checkVisibility());
    if (!other) return;
    const o = other.getBoundingClientRect();
    const covers = p.left < o.right && p.right > o.left && p.top < o.bottom && p.bottom > o.top;
    const dx = o.left - 8 - p.right;
    if (covers && p.left + dx >= 8) setShift(dx);
  }, [open, avoid]);
  useEffect(() => {
    if (!open) return;
    // Escape closes the menu only: preventDefault tells the Ask Oracle panel (listening on
    // window) that this Escape is taken, so the panel the menu sits in stays open.
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      setOpen(false);
    };
    const onDown = (e: PointerEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown);
    };
  }, [open]);
  return (
    <div ref={root} className="relative">
      <Button
        icon={icon}
        aria-expanded={open}
        aria-label={iconOnly ? label : undefined}
        title={iconOnly ? label : undefined}
        className={iconOnly ? "w-8 px-0" : ""}
        onClick={() => {
          setShift(0);
          setOpen((o) => !o);
        }}
      >
        {!iconOnly && label}
      </Button>
      {open && (
        <div
          ref={pop}
          style={shift ? { transform: `translateX(${shift}px)` } : undefined}
          className={`absolute top-[calc(100%+6px)] z-40 w-max max-w-[calc(100vw-24px)] rounded-panel border border-line bg-surface p-3 shadow-tip ${
            align === "end" ? "right-0" : "left-0"
          }`}
        >
          {typeof children === "function" ? children(() => setOpen(false)) : children}
        </div>
      )}
    </div>
  );
}
