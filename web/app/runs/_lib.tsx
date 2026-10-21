import { Chip, CostFigure, Icon, InfoTip, type ChipKind } from "@/components/ds";
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

export const RUN_STATUS_KIND: Record<RunStatus, ChipKind> = {
  draft: "na",
  awaiting_approval: "warn",
  running: "acc",
  awaiting_checkpoint: "acc",
  paused_overrun: "crit",
  succeeded: "pass",
  failed: "crit",
  cancelled: "na",
};

/** A run's state as shown, from its status and `delivering`. */
type RunState = Pick<RunSummary, "status"> & { delivering?: RunSummary["delivering"] };

/**
 * Owner decision 2026-10-20: waiting on its checkpoint while the decision recorded there is
 * delivered to SwarmCloud, a run reads "Delivering decision", amber with a clock, as other
 * in-progress states (its status stays awaiting_checkpoint).
 */
export const isDelivering = (run: RunState) => run.status === "awaiting_checkpoint" && !!run.delivering;
export const runStatusLabel = (run: RunState) => (isDelivering(run) ? "Delivering decision" : RUN_STATUS_LABEL[run.status]);
export const runStatusKind = (run: RunState): ChipKind => (isDelivering(run) ? "warn" : RUN_STATUS_KIND[run.status]);

/** The run's state chip; the label carries data-testid="run-status". */
export function RunStatusBadge({ run }: { run: RunState }) {
  return (
    <Chip kind={runStatusKind(run)}>
      {isDelivering(run) && <Icon name="clock" size={16} />}
      <span data-testid="run-status">{runStatusLabel(run)}</span>
    </Chip>
  );
}

/** P3d: one small figure per run; prominent only on cost approvals and overruns. */
export function RunCost({ run }: { run: RunSummary }) {
  if (run.status === "awaiting_approval") return <CostFigure usd={run.estimate_usd} est prominent />;
  if (run.status === "paused_overrun") return <CostFigure usd={run.spent_usd} of={run.estimate_usd} prominent />;
  if (run.status === "draft") return <CostFigure usd={run.estimate_usd} est />;
  return <CostFigure usd={run.spent_usd} of={run.estimate_usd} />;
}

/** Runs that wait on a person: a checkpoint, a cost approval or an overrun. */
export const WAITING_STATUSES: RunStatus[] = ["awaiting_checkpoint", "awaiting_approval", "paused_overrun"];

export const CHECKPOINT_LABEL: Record<CheckpointKind, string> = {
  baseline_confirm: "Confirm the baseline",
  feature_set: "Feature set and dependencies",
  priority_order: "Priority order",
  prd_review: "PRD review",
  eng_review: "Engineering review",
  roadmap_items: "Roadmap items",
  roadmap_review: "Roadmap review",
};

export const SEGMENT_STATUS_KIND: Record<SegmentOut["status"], ChipKind> = {
  pending: "na",
  running: "acc",
  succeeded: "pass",
  failed: "crit",
  cancelled: "na",
};

export const SEGMENT_STATUS_LABEL: Record<SegmentOut["status"], string> = {
  pending: "Pending",
  running: "Running",
  succeeded: "Succeeded",
  failed: "Failed",
  cancelled: "Cancelled",
};

export const FINAL_STATUSES: RunStatus[] = ["succeeded", "failed", "cancelled"];

/** Asked before Retry on a lost submission: if the lost one landed, both run (and are paid for) until Oracle finds and cancels it. */
export const RETRY_CONFIRM =
  "This can start a paid duplicate run: if the lost submission landed, it runs too until Oracle finds it, cancels it and counts its cost. Retry?";

/** Asked before Stop cancelling: the run ends, and Oracle still counts the workflow's spend until SwarmCloud stops it. */
export const STOP_CANCELLING_CONFIRM = "Stop cancelling? The run ends; its spend still counts until SwarmCloud stops it.";

/** Asked before Cancel again on a stopped workflow over the run's ceiling: Oracle's cancel calls resume; nothing restarts. */
export const CANCEL_AGAIN_CONFIRM = "Cancel again? Oracle cancels this workflow again; nothing restarts.";

const usdFmt = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

export function usd(value: number | null | undefined): string {
  return value == null ? "—" : usdFmt.format(value);
}

/** A run's short id, as B1 shows it ("0412"). */
export const shortId = (id: string) => id.replace(/-/g, "").slice(0, 4);

/**
 * A decision recorded in Oracle that SwarmCloud has not taken yet (owner, 2026-10-20): final,
 * and sent again on every tick until it is delivered. "Approved by <name>, delivering to the
 * run… (N tries, last: <error>)".
 */
export function deliveryText(cp: Pick<CheckpointOut, "status" | "delivery">): string {
  const d = cp.delivery;
  if (!d) return "";
  const verb = cp.status === "approved" ? "Approved" : "Changes requested";
  const by = d.decided_by_name ? ` by ${d.decided_by_name}` : "";
  const tries = d.tries ?? 0;
  const tried = tries > 0 ? ` (${tries} ${tries === 1 ? "try" : "tries"}${d.last_error ? `, last: ${d.last_error}` : ""})` : "";
  return `${verb}${by}, delivering to the run…${tried}`;
}

/** "12m", "3h", "2d": how long an item has waited. */
export function age(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "–";
  const m = Math.max(0, Math.round((now - new Date(iso).getTime()) / 60000));
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

/** A run's estimate before it starts: per segment, the total, and the owner gate over the threshold. */
export function EstimateSummary({ estimate }: { estimate: EstimateOut }) {
  return (
    <section aria-label="Estimate" className="rounded-panel border border-line bg-surface2 px-3.5 py-2.5" data-testid="estimate">
      <table className="w-full text-[15px]">
        <tbody>
          {estimate.segments.map((s) => (
            <tr key={s.seq}>
              <td className="py-0.5 text-text">{s.title}</td>
              <td className="tnum py-0.5 text-right font-mono text-sm text-text2">{usd(s.estimate_usd)}</td>
            </tr>
          ))}
          <tr className="border-t border-line font-semibold">
            <td className="pt-1.5">
              <span className="inline-flex items-center gap-1.5">
                Estimate
                <InfoTip label="the spending limit" align="start">
                  Spending past 1.5× the estimate pauses the run and asks an owner.
                </InfoTip>
              </span>
            </td>
            <td className="tnum pt-1.5 text-right font-mono" data-testid="estimate-total">
              {usd(estimate.total_usd)}
            </td>
          </tr>
        </tbody>
      </table>
      {(estimate.needs_approval || !estimate.within_budget) && (
        <div className="mt-2 flex flex-wrap gap-2">
          {estimate.needs_approval && (
            <Chip kind="warn">
              Owner approves
              <InfoTip label="cost approval" align="start">
                Over {usd(estimate.approval_threshold_usd)}: an owner approves the cost before the run starts.
              </InfoTip>
            </Chip>
          )}
          {!estimate.within_budget && (
            <Chip kind="crit">
              Over budget
              <InfoTip label="the budget" align="start">
                Over the budget: lower the depth or roles, or raise the budget.
              </InfoTip>
            </Chip>
          )}
        </div>
      )}
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
    <div className="relative h-2 w-full rounded-full bg-surface2" aria-hidden>
      <div
        className={`absolute inset-y-0 left-0 rounded-full ${over ? "bg-crit" : spent > estimate ? "bg-warn" : "bg-accent"}`}
        style={{ width: pct(spent) }}
      />
      <div className="absolute inset-y-[-3px] w-px bg-text2" style={{ left: pct(estimate) }} title="Estimate" />
      {ceiling != null && <div className="absolute inset-y-[-3px] w-px bg-crit" style={{ left: pct(ceiling) }} title="Pauses above" />}
    </div>
  );
}

/** Where runs execute (ORACLE_RUNTIME defaults to swarmcloud): the text for an InfoTip. */
export function RunsWhere({ runtime }: { runtime?: string }) {
  if (runtime === "fake") {
    return (
      <span className="block" data-testid="runs-where">
        This Oracle uses the local test runtime; in normal use runs execute in SwarmCloud.
      </span>
    );
  }
  return (
    <span className="block" data-testid="runs-where">
      Runs execute in SwarmCloud, on SwarmCloud&apos;s own Claude accounts. Oracle&apos;s built-in jobs (review comments,
      reporting, refinement) use the accounts in Settings &gt; Claude accounts.
    </span>
  );
}
