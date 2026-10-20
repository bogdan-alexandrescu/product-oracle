import type { ButtonHTMLAttributes, ReactNode } from "react";

import { Page, PageHeader } from "@/components/ds/Layout";
import type { FeedbackStatus, Verdict } from "@/lib/api/client";
import { DOC_STATUS_LABEL, STATUS_LABEL, VERDICT_LABEL } from "@/lib/format";

type Tone = "neutral" | "green" | "amber" | "red" | "blue";

/** Tones map onto the design system's status chips (components/ds Chip). */
const TONES: Record<Tone, string> = {
  neutral: "bg-na-bg text-na",
  green: "bg-pass-bg text-pass",
  amber: "bg-warn-bg text-warn",
  red: "bg-crit-bg text-crit",
  blue: "bg-accent-soft text-accent-ink",
};

export function Badge({ tone = "neutral", children, title }: { tone?: Tone; children: ReactNode; title?: string }) {
  return (
    <span
      title={title}
      className={`tnum inline-flex h-[26px] items-center gap-1 rounded-full px-2.5 text-[13px] leading-none font-semibold whitespace-nowrap ${TONES[tone]}`}
    >
      {children}
    </span>
  );
}

/** O1f: which layer a section belongs to (brief, or detail in the full document only). */
export function LayerBadge({ layer }: { layer: "brief" | "detail" | null | undefined }) {
  if (!layer) return null;
  return (
    <span data-testid="layer-badge" data-layer={layer}>
      <Badge tone={layer === "brief" ? "blue" : "neutral"} title={layer === "brief" ? "In the brief" : "Detail: in the full document only"}>
        {layer === "brief" ? "Brief" : "Detail"}
      </Badge>
    </span>
  );
}

/**
 * E1: the decided/proposed state of a part of a spec version (Oracle's parts are decided
 * from the approved PRD; a section an edit added is "Proposed · added in an edit").
 */
export function SpecStateBadge({ state }: { state: { label: string; decided: boolean; added?: boolean } }) {
  const tone = state.decided ? TONES.green : TONES.amber;
  return (
    <span
      data-testid="spec-state"
      data-decided={state.decided ? "true" : "false"}
      data-added={state.added ? "true" : "false"}
      className={`inline-flex max-w-full items-center rounded px-1.5 py-0.5 text-xs font-medium ring-1 ring-inset ${tone} ${
        state.added ? "ring-dashed border border-dashed border-amber-400" : ""
      }`}
    >
      {state.label}
    </span>
  );
}

export const VERDICT_TONE: Record<Verdict, Tone> = { approved: "green", changes_requested: "amber", rejected: "red" };
export const STATUS_TONE: Record<FeedbackStatus, Tone> = {
  open: "blue",
  addressed: "green",
  declined: "neutral",
  superseded: "neutral",
};

export function VerdictBadge({ verdict }: { verdict: Verdict }) {
  return <Badge tone={VERDICT_TONE[verdict]}>{VERDICT_LABEL[verdict]}</Badge>;
}

export function StatusBadge({ status }: { status: FeedbackStatus }) {
  return <Badge tone={STATUS_TONE[status]}>{STATUS_LABEL[status]}</Badge>;
}

export function DocStatusBadge({ status }: { status: keyof typeof DOC_STATUS_LABEL }) {
  return (
    <Badge tone={status === "approved" ? "green" : status === "in_review" ? "blue" : "neutral"}>
      {DOC_STATUS_LABEL[status]}
    </Badge>
  );
}

export function LockIcon({ className = "h-3.5 w-3.5" }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className={className} aria-hidden>
      <rect x="3" y="7" width="10" height="7" rx="1.5" />
      <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
    </svg>
  );
}

type Variant = "primary" | "secondary" | "ghost";

const VARIANTS: Record<Variant, string> = {
  primary: "bg-accent text-on-accent hover:brightness-110 border border-accent",
  secondary: "bg-surface text-text hover:bg-surface2 border border-line-strong",
  ghost: "text-text2 hover:bg-surface2 hover:text-text border border-transparent",
};

export function Button({
  variant = "secondary",
  size = "md",
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: "sm" | "md" }) {
  return (
    <button
      type="button"
      {...props}
      className={`inline-flex items-center justify-center gap-1.5 font-semibold whitespace-nowrap transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
        size === "sm" ? "h-8 rounded-lg px-2.5 text-[13px]" : "h-9 rounded-button px-3.5 text-sm"
      } ${VARIANTS[variant]} ${className}`}
    />
  );
}

/** Class names of a text input, select or textarea in a settings form. */
export const INPUT = "w-full rounded-lg border border-line-strong bg-surface px-2.5 py-1.5 text-[15px] text-text";

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="rounded border border-line-strong bg-surface2 px-1 font-mono text-[13px] text-text2">
      {children}
    </kbd>
  );
}

export function ErrorNote({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="rounded-button bg-crit-bg px-3 py-2 text-sm font-medium text-crit">
      {children}
    </p>
  );
}

export function Loading({ label = "Loading…" }: { label?: string }) {
  return <p role="status" className="py-2 text-sm text-text2">{label}</p>;
}

/** Empty state of a page: its heading plus a sentence or two on what will appear here. */
export function EmptyState({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Page>
      <PageHeader title={title} />
      <div className="max-w-3xl space-y-2 text-text2">{children}</div>
    </Page>
  );
}
