import { Badge } from "@/components/ui";
import type { Schemas } from "@/lib/api/client";

export type RunOut = Schemas["RunOut"];
export type RunSummary = Schemas["RunSummary"];
export type RunStatus = RunSummary["status"];
export type CheckpointOut = Schemas["CheckpointOut"];
export type CheckpointKind = CheckpointOut["kind"];
export type SegmentOut = Schemas["SegmentOut"];
export type FlowCatalog = Schemas["FlowCatalog"];
export type EstimateOut = Schemas["EstimateOut"];
export type InboxOut = Schemas["InboxOut"];

export const RUN_STATUS_LABEL: Record<RunStatus, string> = {
  draft: "Draft",
  awaiting_approval: "Awaiting cost approval",
  running: "Running",
  awaiting_checkpoint: "Waiting for review",
  paused_overrun: "Paused: over budget",
  succeeded: "Succeeded",
  failed: "Failed",
  cancelled: "Cancelled",
};

const RUN_STATUS_TONE: Record<RunStatus, "neutral" | "green" | "amber" | "red" | "blue"> = {
  draft: "neutral",
  awaiting_approval: "amber",
  running: "blue",
  awaiting_checkpoint: "amber",
  paused_overrun: "red",
  succeeded: "green",
  failed: "red",
  cancelled: "neutral",
};

export function RunStatusBadge({ status }: { status: RunStatus }) {
  return (
    <Badge tone={RUN_STATUS_TONE[status]}>
      <span data-testid="run-status">{RUN_STATUS_LABEL[status]}</span>
    </Badge>
  );
}

export const CHECKPOINT_LABEL: Record<CheckpointKind, string> = {
  baseline_confirm: "Confirm the baseline",
  feature_set: "Feature set and dependencies",
  priority_order: "Priority order",
  prd_review: "PRD review",
  eng_review: "Engineering review",
};

export const SEGMENT_STATUS_TONE: Record<SegmentOut["status"], "neutral" | "green" | "amber" | "red" | "blue"> = {
  pending: "neutral",
  running: "blue",
  succeeded: "green",
  failed: "red",
  cancelled: "neutral",
};

export const FINAL_STATUSES: RunStatus[] = ["succeeded", "failed", "cancelled"];

const usdFmt = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

export function usd(value: number | null | undefined): string {
  return value == null ? "—" : usdFmt.format(value);
}

/** Spend against the estimate, with the overrun ceiling marked. */
export function SpendBar({ spent, estimate, ceiling }: { spent: number; estimate: number | null; ceiling: number | null }) {
  if (estimate == null || estimate <= 0) return null;
  const max = Math.max(ceiling ?? estimate * 1.5, spent, estimate);
  const pct = (v: number) => `${Math.min(100, (v / max) * 100)}%`;
  const over = ceiling != null && spent > ceiling;
  return (
    <div className="relative h-2 w-full rounded-full bg-neutral-100" aria-hidden>
      <div
        className={`absolute inset-y-0 left-0 rounded-full ${over ? "bg-rose-500" : spent > estimate ? "bg-amber-500" : "bg-neutral-800"}`}
        style={{ width: pct(spent) }}
      />
      <div className="absolute inset-y-[-3px] w-px bg-neutral-500" style={{ left: pct(estimate) }} title="Estimate" />
      {ceiling != null && (
        <div className="absolute inset-y-[-3px] w-px bg-rose-400" style={{ left: pct(ceiling) }} title="Pauses above" />
      )}
    </div>
  );
}
