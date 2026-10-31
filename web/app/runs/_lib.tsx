import { Chip, Icon, InfoTip, type ChipKind } from "@/components/ds";
import { api, unwrap, type Schemas } from "@/lib/api/client";
import { formatMoney, formatMoneyOf } from "@/lib/format";
import { docLabel, runLabel } from "@/lib/labels";
import { useQuery } from "@/lib/use-query";

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

/**
 * Runs whose cost needs a decision: the cost approval and the overrun pause. P3d Cost prominence:
 * only these show cost on the runs list; elsewhere a run's cost is one small line in its details.
 */
export const COST_DECISION_STATUSES: RunStatus[] = ["awaiting_approval", "paused_overrun"];

/**
 * A run's cost in one format (qa-work-25): "$4.90 of $14.50 estimated" (spent of the estimate),
 * "$53.00 estimated" before it starts, "$4.90 spent" with no estimate.
 */
export function costText(run: Pick<RunSummary, "status" | "spent_usd" | "estimate_usd">): string {
  const est = run.estimate_usd;
  if (run.status === "awaiting_approval" || run.status === "draft") return est == null ? "No estimate yet" : `${formatMoney(est)} estimated`;
  return est == null ? `${formatMoney(run.spent_usd)} spent` : `${formatMoneyOf(run.spent_usd, est)} estimated`;
}

/** P3d Cost prominence: a run's cost, prominent only on cost approvals and overruns; normal font everywhere. */
export function RunCost({ run }: { run: RunSummary }) {
  const prominent = COST_DECISION_STATUSES.includes(run.status);
  const over = run.status === "paused_overrun";
  return (
    <span
      data-cost={prominent ? "prominent" : "small"}
      className={
        prominent
          ? `tnum inline-flex min-h-7 items-center rounded-lg px-2 text-[15px] font-medium ${over ? "bg-crit-bg text-crit" : "bg-warn-bg text-warn"}`
          : "tnum text-sm text-text2"
      }
    >
      {costText(run)}
    </span>
  );
}

/** Runs that wait on a person: a checkpoint, a cost approval or an overrun. */
export const WAITING_STATUSES: RunStatus[] = ["awaiting_checkpoint", "awaiting_approval", "paused_overrun"];

export const CHECKPOINT_LABEL: Record<CheckpointKind, string> = {
  baseline_confirm: "Confirm the baseline",
  feature_set: "Feature set and dependencies",
  priority_order: "Priority order",
  prd_review: "PRD review",
  eng_review: "Engineering review",
  eng_dates: "Engineering dates",
  roadmap_items: "Roadmap items",
  roadmap_review: "Roadmap review",
  strategy_review: "Vision or strategy review",
  request_triage: "Request triage",
  launch_review: "Launch kit review",
  update_review: "Update review",
  pricing_review: "Pricing memo review",
};

/**
 * F4: a stop's name where a Baseline to PRD run is configured. The engineering stops show
 * their segment's title ("Engineering check"); the kind's label stays the spec flow's.
 */
export function stopLabel(segment: { name: string; title: string; checkpoint?: CheckpointKind | null }): string {
  if (segment.name in STOP_HELP) return segment.title;
  return segment.checkpoint ? CHECKPOINT_LABEL[segment.checkpoint] : segment.title;
}

/** F4: what each engineering stop does, said under its toggle. */
export const STOP_HELP: Record<string, string> = {
  eng_review: "The engineering lead checks feasibility and sizes before the priority order.",
  eng_dates: "After the PRD review, the engineering lead records the dates behind the draft's Now items.",
};

/** F4: the Engineering check of a Baseline to PRD run, as its checkpoint stores it (briefs_check). */
export type BriefsCheck = {
  features: { key: string; title: string; approach: string; size: string; depends_on: string[]; questions: { id: string; question: string; blocking: boolean }[] }[];
  /** An unknown code map id is one problem, with the features citing it. */
  problems: { code: string; message: string; feature?: string | null; features?: string[] }[];
  code_map_used: boolean;
  /** The repositories the briefs name that none of the run's code maps covers. */
  unmapped_repos?: string[];
  /** True when cited ids are in no map and the briefs name no repository without one. */
  unnamed_repo?: boolean;
};

export function briefsCheck(cp: Pick<CheckpointOut, "kind" | "payload">): BriefsCheck | null {
  const check = cp.kind === "eng_review" ? (cp.payload as { briefs_check?: BriefsCheck } | null)?.briefs_check : null;
  return check && Array.isArray(check.features) ? check : null;
}

/** F4 lane B: the Engineering dates stop of a Baseline to PRD run, as its checkpoint stores it (dates_check). */
export type DatesCheck = {
  prd: { document: string; version: number } | null;
  /** The draft's Now items, in order: each with the date the architect proposes, if any. */
  items: {
    key: string;
    title: string;
    section: string | null;
    size: string | null;
    proposed: { kind: "estimate" | "capacity" | "commitment"; reference: string; supports_date: string } | null;
    confidence: "low" | "medium" | "high" | null;
    assumptions: string[];
    no_date_reason: string | null;
  }[];
  /** The Next and Later items: no dates (O4 Roadmap shape), shown read-only. */
  others: { key: string; title: string; horizon: "next" | "later" }[];
  problems: { code: string; message: string }[];
};

export function datesCheck(cp: Pick<CheckpointOut, "kind" | "payload">): DatesCheck | null {
  const check = cp.kind === "eng_dates" ? (cp.payload as { dates_check?: DatesCheck } | null)?.dates_check : null;
  return check && Array.isArray(check.items) ? check : null;
}

/** F4: an engineering stop with its own review screen (the check's briefs or the dates). */
export const screenedStop = (cp: Pick<CheckpointOut, "kind" | "payload">) => !!(briefsCheck(cp) || datesCheck(cp));

/** F4 lane B: the Now items with a proposed date nobody decided yet (the gate's date_undecided). */
export const datesToDecide = (cp: Pick<CheckpointOut, "gate">) => (cp.gate?.left ?? []).filter((x) => x.code === "date_undecided").length;

export const SEGMENT_STATUS_KIND: Record<SegmentOut["status"], ChipKind> = {
  pending: "na",
  running: "acc",
  succeeded: "pass",
  failed: "crit",
  cancelled: "na",
  // C4: a reused baseline segment runs no step.
  skipped: "na",
};

export const SEGMENT_STATUS_LABEL: Record<SegmentOut["status"], string> = {
  pending: "Pending",
  running: "Running",
  succeeded: "Succeeded",
  failed: "Failed",
  cancelled: "Cancelled",
  skipped: "Skipped",
};

/**
 * A draft Oracle refused and sent back to the writer itself, while the revision runs (owner,
 * 2026-10-20): the run page, the runs list and the Inbox name this state, never "Draft rejected",
 * and nobody is asked to decide until the revision is imported or still refused.
 */
export const SENT_BACK_STATE = "Revising: sent back by Oracle";

/** C8: the Priorities screen in run mode for a priority stop's proposed order, if it has one. */
export function orderHref(cp: { kind: CheckpointKind; payload?: Record<string, unknown> | null }): string | null {
  const id = cp.kind === "priority_order" ? cp.payload?.priority_snapshot_id : null;
  return typeof id === "string" ? `/priorities?snapshot=${id}` : null;
}

/**
 * A checkpoint kind with its own review screen opens it (/runs/<id>/review/<checkpoint id>):
 * C7's feature set, D1's roadmap items, and F4's Engineering check and Engineering dates once
 * their checks are in; other kinds are decided on the run page.
 */
export function reviewHref(cp: { id: string; run_id: string; kind: CheckpointKind; payload?: CheckpointOut["payload"] }): string | null {
  return cp.kind === "feature_set" || cp.kind === "roadmap_items" || screenedStop({ kind: cp.kind, payload: cp.payload ?? {} }) ? `/runs/${cp.run_id}/review/${cp.id}` : null;
}

export const FINAL_STATUSES: RunStatus[] = ["succeeded", "failed", "cancelled"];

/** Asked before Retry on a lost submission: if the lost one landed, both run (and are paid for) until Oracle finds and cancels it. */
export const RETRY_CONFIRM =
  "This can start a paid duplicate run: if the lost submission landed, it runs too until Oracle finds it, cancels it and counts its cost. Retry?";

/** Asked before Stop cancelling: the run ends, and Oracle still counts the workflow's spend until SwarmCloud stops it. */
export const STOP_CANCELLING_CONFIRM = "Stop cancelling? The run ends; its spend still counts until SwarmCloud stops it.";

/** Asked before Cancel again on a stopped workflow over the run's ceiling: Oracle's cancel calls resume; nothing restarts. */
export const CANCEL_AGAIN_CONFIRM = "Cancel again? Oracle cancels this workflow again; nothing restarts.";

export function usd(value: number | null | undefined): string {
  return value == null ? "—" : formatMoney(value);
}

/** A run's short id, as B1 shows it ("0412"). */
export const shortId = (id: string) => id.replace(/-/g, "").slice(0, 4);

/**
 * The document a run writes, in words (qa-work-8/9): "Usage alerts roadmap", from runLabel
 * without its flow; null for a run that names no document.
 */
export function runDocName(run: Pick<RunSummary, "flow_title" | "document_slug" | "document_kind">): string | null {
  if (!run.document_slug) return null;
  const label = runLabel(run);
  const tail = ` · ${run.flow_title}`;
  // The document as the app names it ("Usage alerts PRD"); the run's own title keeps the title as written.
  return docLabel({ title: label.endsWith(tail) ? label.slice(0, -tail.length) : label, kind: run.document_kind });
}

/** What a run is for, in a list or a heading: its document, else its flow. */
export const runName = (run: Pick<RunSummary, "flow_title" | "document_slug" | "document_kind">) => runDocName(run) ?? run.flow_title;

/**
 * qa-work-4: a Roadmap items stop's open counts before its shared draft is read, counted as the
 * review screen counts them (reviewCounts: items, never reasons): an item with an open blocking
 * reason is blocking, one with only reasons to confirm is to confirm.
 */
export function checkCounts(reasons: { item: string; severity: string }[]): { blocking: number; toConfirm: number } {
  const worst = new Map<string, boolean>();
  for (const r of reasons) worst.set(r.item, (worst.get(r.item) ?? false) || r.severity === "blocking");
  let blocking = 0;
  for (const b of worst.values()) if (b) blocking += 1;
  return { blocking, toConfirm: worst.size - blocking };
}

/** A key in words, for a name the catalog does not give: "roadmap_items" is "Roadmap items". */
const keyWords = (key: string) => {
  const words = key.replace(/[-_]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

/** A file the agents wrote, in words (qa-work-8): "roadmap_items.yaml" is "Roadmap items". */
const FILE_WORDS: Record<string, string> = {
  "prd.md": "PRD draft",
  "roadmap.md": "Roadmap draft",
  "update.md": "Update draft",
  "pricing.md": "Pricing memo",
  "spec.md": "Spec draft",
  "design.md": "Design notes",
  "design.json": "Design data",
  "summary.md": "Summary",
  "review.yaml": "Review",
};
export const fileLabel = (name: string) => FILE_WORDS[name] ?? keyWords(name.replace(/\.[a-z]+$/i, ""));

/** A template's and a theme's names (qa-work-8): "Template: Now / Next / Later, theme Roadmap board". */
export function useTemplateText(template: string | null | undefined, theme: string | null | undefined): string | null {
  const t = useQuery(template ? "run-templates" : "run-templates|none", () => (template ? unwrap(api.GET("/v1/templates")) : Promise.resolve([] as Schemas["TemplateSummary"][])));
  const th = useQuery(theme ? "run-themes" : "run-themes|none", () => (theme ? unwrap(api.GET("/v1/themes")) : Promise.resolve([] as Schemas["ThemeOut"][])));
  if (!template) return null;
  const name = t.data?.find((x) => x.key === template)?.name ?? keyWords(template);
  const themeName = theme ? (th.data?.find((x) => x.key === theme)?.name ?? keyWords(theme)) : null;
  return `Template: ${name}${themeName ? `, theme ${themeName}` : ""}`;
}

/** Agent role keys to their names for people (the flow catalog's titles): "prioritizer" is "Prioritizer". */
export function useRoleNames(): (role: string) => string {
  const q = useQuery("flows", () => unwrap(api.GET("/v1/flows")));
  const roles = q.data?.roles ?? [];
  return (role: string) => roles.find((r) => r.key === role)?.title ?? keyWords(role);
}

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
            <tr key={s.seq} data-testid={`estimate-row-${s.name}`}>
              <td className="py-0.5 text-text">
                {/* E1 part B: Build roadmap reuses the approved version's draft items. */}
                {s.reused_from_version != null ? `${s.title} · reused from v${s.reused_from_version}` : s.title}
              </td>
              <td className="tnum py-0.5 text-right text-sm text-text2">{usd(s.estimate_usd)}</td>
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
            <td className="tnum pt-1.5 text-right" data-testid="estimate-total">
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

/** Where runs execute (ORACLE_RUNTIME defaults to swarmcloud): the text for an InfoTip. */
export function RunsWhere({ runtime }: { runtime?: string }) {
  if (runtime === "fake") {
    return (
      <span className="block" data-testid="runs-where">
        In test mode this server runs the agents itself; in normal use runs go to SwarmCloud.
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
