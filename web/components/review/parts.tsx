"use client";

import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

import { Button, Chip, Icon, type ChipKind } from "@/components/ds";
import type { FeedbackStatus, LlmJob, Verdict } from "@/lib/api/client";
import { JOB_STATUS_LABEL, STATUS_LABEL, VERDICT_LABEL } from "@/lib/format";

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

export function JobStatusChip({ status }: { status: LlmJob["status"] }) {
  return (
    <Chip kind={JOB_KIND[status]} dot>
      {JOB_STATUS_LABEL[status]}
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
}: {
  label: string;
  tabs: { id: T; label: ReactNode; count?: number | null }[];
  value: T;
  onChange: (id: T) => void;
  size?: "sm" | "md";
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
  return (
    <div
      ref={ref}
      role="tablist"
      aria-label={label}
      onKeyDown={onKey}
      className="flex max-w-full gap-1 scroll-fade overflow-x-auto border-b border-line"
    >
      {tabs.map((t) => {
        const on = t.id === value;
        return (
          <button
            key={t.id}
            role="tab"
            type="button"
            aria-selected={on}
            tabIndex={on ? 0 : -1}
            onClick={() => onChange(t.id)}
            className={`-mb-px flex flex-none items-center gap-1.5 border-b-2 whitespace-nowrap ${
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

/** A secondary button that opens a small panel of actions; Escape or a click outside closes it. */
export function Menu({
  label,
  icon,
  children,
  align = "end",
}: {
  label: string;
  icon?: Parameters<typeof Button>[0]["icon"];
  children: ReactNode;
  align?: "start" | "end";
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: globalThis.KeyboardEvent) => e.key === "Escape" && setOpen(false);
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
      <Button icon={icon} aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {label}
      </Button>
      {open && (
        <div
          className={`absolute top-[calc(100%+6px)] z-40 w-max max-w-[calc(100vw-24px)] rounded-panel border border-line bg-surface p-3 shadow-tip ${
            align === "end" ? "right-0" : "left-0"
          }`}
        >
          {children}
        </div>
      )}
    </div>
  );
}
