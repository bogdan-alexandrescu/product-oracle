import { Badge } from "@/components/ui";
import type { Schemas } from "@/lib/api/client";

export type RunOut = Schemas["RunOut"];
export type RunSummary = Schemas["RunSummary"];
export type RunStatus = RunSummary["status"];
export type CheckpointOut = Schemas["CheckpointOut"];
export type ConsoleAnswer = NonNullable<CheckpointOut["console"]>;
export type CheckpointChoice = Schemas["CheckpointDecision"]["decision"];
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
  roadmap_items: "Roadmap items",
  roadmap_review: "Roadmap review",
};

export const SEGMENT_STATUS_TONE: Record<SegmentOut["status"], "neutral" | "green" | "amber" | "red" | "blue"> = {
  pending: "neutral",
  running: "blue",
  succeeded: "green",
  failed: "red",
  cancelled: "neutral",
};

export const FINAL_STATUSES: RunStatus[] = ["succeeded", "failed", "cancelled"];

/** Asked before Retry on a lost submission: if the lost one landed, both run (and are paid for) until Oracle finds and cancels it. */
export const RETRY_CONFIRM =
  "This can start a paid duplicate run: if the lost submission landed, it runs too until Oracle finds it, cancels it and counts its cost. Retry?";

/** Asked before Stop cancelling: Oracle stops the cancel calls, and still counts the workflow's spend until it ends. */
export const STOP_CANCELLING_CONFIRM = "Stop cancelling? Its spend still counts until it ends.";

const usdFmt = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

export function usd(value: number | null | undefined): string {
  return value == null ? "—" : usdFmt.format(value);
}

/** A run's estimate before it starts: per segment, the total, and the owner gate over the threshold. */
export function EstimateSummary({ estimate }: { estimate: EstimateOut }) {
  return (
    <section aria-label="Estimate" className="rounded-md border border-neutral-200 bg-neutral-50 px-3 py-2.5" data-testid="estimate">
      <table className="w-full text-sm">
        <tbody>
          {estimate.segments.map((s) => (
            <tr key={s.seq}>
              <td className="py-0.5 text-neutral-700">{s.title}</td>
              <td className="py-0.5 text-right tabular-nums text-neutral-700">{usd(s.estimate_usd)}</td>
            </tr>
          ))}
          <tr className="border-t border-neutral-200 font-semibold">
            <td className="pt-1.5">Estimate</td>
            <td className="pt-1.5 text-right tabular-nums" data-testid="estimate-total">
              {usd(estimate.total_usd)}
            </td>
          </tr>
        </tbody>
      </table>
      {estimate.needs_approval && (
        <p className="mt-2 text-xs text-amber-800">
          Over {usd(estimate.approval_threshold_usd)}: an owner approves the cost before the run starts.
        </p>
      )}
      {!estimate.within_budget && (
        <p className="mt-2 text-xs text-rose-700">Over the budget: lower the depth or roles, or raise the budget.</p>
      )}
      <p className="mt-1 text-xs text-neutral-500">Spending past 1.5× the estimate pauses the run and asks an owner.</p>
    </section>
  );
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

/** Where runs execute, said on the Runs screens (ORACLE_RUNTIME defaults to swarmcloud). */
export function RunsWhere({ runtime }: { runtime?: string }) {
  if (runtime === "fake") {
    return (
      <p className="text-xs text-neutral-500" data-testid="runs-where">
        This Oracle uses the local test runtime; in normal use runs execute in SwarmCloud.
      </p>
    );
  }
  return (
    <p className="text-xs text-neutral-500" data-testid="runs-where">
      Runs execute in SwarmCloud, on SwarmCloud&apos;s own Claude accounts. Oracle&apos;s built-in jobs (review
      comments, reporting, refinement) use the accounts in Settings &gt; Claude accounts.
    </p>
  );
}
