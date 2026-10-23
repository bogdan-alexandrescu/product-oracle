import type { ChipKind } from "@/components/ds";
import type { Schemas } from "@/lib/api/client";
import { formatDay } from "@/lib/format";

export type PlanItem = Schemas["PlanItem"];
export type PlanPrd = Schemas["PlanPrd"];
export type Horizon = PlanItem["horizon"];

export const HORIZONS: Horizon[] = ["now", "next", "later"];
export const HORIZON_LABEL: Record<Horizon, string> = { now: "Now", next: "Next", later: "Later" };

const STATE: Record<Exclude<PlanItem["state"], "proposed">, { kind: ChipKind; label: string }> = {
  done: { kind: "pass", label: "Done" },
  slipped: { kind: "crit", label: "Slipped" },
  at_risk: { kind: "crit", label: "At risk" },
  on_track: { kind: "pass", label: "On track" },
  planned: { kind: "na", label: "Planned" },
};

/** The state chip (F1 §5): a draft's item is "Proposed", with how it differs from its approved twin. */
export function stateChip(i: PlanItem): { kind: ChipKind; label: string; dashed: boolean } {
  if (i.state !== "proposed") return { ...STATE[i.state], dashed: false };
  const c = i.change;
  let suffix = "";
  if (c?.kind === "new") suffix = " · new";
  else if (c?.kind === "moved" && c.from_horizon && c.to_horizon) suffix = ` · ${HORIZON_LABEL[c.from_horizon]} → ${HORIZON_LABEL[c.to_horizon]}`;
  else if (c?.kind === "changed") suffix = " · changed";
  return { kind: "line", label: `Proposed${suffix}`, dashed: true };
}

/** The Engineering cell (F1 §6): the issue part, then the date part, joined by " · "; "—" when both are empty. */
export function engineeringLine(i: PlanItem): string {
  const e = i.engineering;
  const keys = e.records.map((r) => r.external_ref);
  let issue = "";
  if (keys.length) issue = keys[0] + (keys.length > 1 ? ` +${keys.length - 1}` : "");
  else if (i.origin === "approved" && i.horizon !== "later") issue = "Untracked";
  let day = "";
  if (e.slip_days != null) day = `slipped ${e.slip_days} d`;
  else if (e.date_status === "verified" && e.date) day = `${formatDay(e.date)} ✓`;
  else if (e.date_status === "unverified") day = "unverified";
  else if (e.date_status === "withdrawn") day = "date withdrawn";
  else if (target(i)) day = `${formatDay(target(i)!)} ✓`;
  else if (keys.length && !e.date) day = "no date";
  return [issue, day].filter(Boolean).join(" · ") || "—";
}

/** F7: the first linked record's target date (a GitHub issue's milestone due date), when the item has none of its own. */
const target = (i: PlanItem) => i.engineering.records.find((r) => r.target_date)?.target_date ?? null;

/** Who makes the next decision: a person when one is named (the viewer reads "you"), else the role. */
export function whoLabel(who: Schemas["PlanWho"] | null | undefined, me: string | null | undefined): string | null {
  if (!who) return null;
  if (who.user_id && who.user_id === me) return "you";
  switch (who.role) {
    case "track_owner":
      return "the track owner";
    case "engineering_lead":
      return "the engineering lead";
    case "owner":
      return "owners";
    case "approver":
      return "approvers";
    default:
      return `${who.role}s`;
  }
}

/** "Usage alerts PRD v1" or "Checkout redesign PRD draft 2". */
export function prdLabel(i: PlanItem): string {
  if (!i.prd) return "—";
  const v = i.prd.version == null ? "" : i.prd.approved ? ` v${i.prd.version}` : ` draft ${i.prd.version}`;
  return `${i.prd.title}${v}`;
}

export const roadmapHref = (i: PlanItem) => `/documents/${i.roadmap.slug}/v/${i.roadmap.version}#${i.roadmap.anchor}`;
