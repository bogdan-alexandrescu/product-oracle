import type { ButtonHTMLAttributes, ReactNode } from "react";

import type { FeedbackStatus, Verdict } from "@/lib/api/client";
import { DOC_STATUS_LABEL, STATUS_LABEL, VERDICT_LABEL } from "@/lib/format";

type Tone = "neutral" | "green" | "amber" | "red" | "blue";

const TONES: Record<Tone, string> = {
  neutral: "bg-neutral-100 text-neutral-700 ring-neutral-200",
  green: "bg-emerald-50 text-emerald-800 ring-emerald-200",
  amber: "bg-amber-50 text-amber-800 ring-amber-200",
  red: "bg-rose-50 text-rose-800 ring-rose-200",
  blue: "bg-sky-50 text-sky-800 ring-sky-200",
};

export function Badge({ tone = "neutral", children, title }: { tone?: Tone; children: ReactNode; title?: string }) {
  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs font-medium whitespace-nowrap ring-1 ring-inset ${TONES[tone]}`}
    >
      {children}
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
  primary: "bg-neutral-900 text-white hover:bg-neutral-700 border border-neutral-900",
  secondary: "bg-white text-neutral-800 hover:bg-neutral-50 border border-neutral-300",
  ghost: "text-neutral-600 hover:bg-neutral-100 hover:text-neutral-900 border border-transparent",
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
      className={`inline-flex items-center justify-center gap-1.5 rounded-md font-medium whitespace-nowrap transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
        size === "sm" ? "px-2 py-1 text-xs" : "px-3 py-1.5 text-sm"
      } ${VARIANTS[variant]} ${className}`}
    />
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="rounded border border-neutral-300 bg-neutral-50 px-1 font-mono text-[11px] text-neutral-600">
      {children}
    </kbd>
  );
}

export function ErrorNote({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">
      {children}
    </p>
  );
}

export function Loading({ label = "Loading…" }: { label?: string }) {
  return <p className="text-sm text-neutral-500">{label}</p>;
}

/** Empty state of a page: its heading plus a sentence or two on what will appear here. */
export function EmptyState({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="mx-auto max-w-4xl px-6 py-8">
      <h1 className="mb-6 text-2xl font-semibold tracking-tight text-neutral-900">{title}</h1>
      <div className="space-y-2 text-neutral-600">{children}</div>
    </div>
  );
}
