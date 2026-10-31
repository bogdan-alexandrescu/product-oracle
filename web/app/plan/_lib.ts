import type { ChipKind } from "@/components/ds";
import type { Schemas } from "@/lib/api/client";
import { formatDay } from "@/lib/format";
import { docLabel } from "@/lib/labels";

export type PlanItem = Schemas["PlanItem"];
export type PlanDrift = Schemas["PlanDrift"];
export type PlanPrd = Schemas["PlanPrd"];
export type Horizon = PlanItem["horizon"];
type Basis = Schemas["ScheduleBasisOut"];

export const HORIZONS: Horizon[] = ["now", "next", "later"];
export const HORIZON_LABEL: Record<Horizon, string> = { now: "Now", next: "Next", later: "Later" };

const STATE: Record<Exclude<PlanItem["state"], "proposed">, { kind: ChipKind; label: string }> = {
  done: { kind: "pass", label: "Done" },
  slipped: { kind: "crit", label: "Slipped" },
  at_risk: { kind: "crit", label: "At risk" },
  on_track: { kind: "pass", label: "On track" },
  planned: { kind: "na", label: "Planned" },
};

/**
 * The state chip (F1 §5): a draft's item is "Proposed", with how it differs from its approved twin.
 * `label` is the whole state; `head` the pill's word and `detail` the rest, said outside the pill
 * where room is short (qa-plan-30: "Proposed" then "Next → Now", never wrapped inside the pill).
 */
export function stateChip(i: PlanItem): { kind: ChipKind; label: string; dashed: boolean; head: string; detail: string; sep: string } {
  // qa-plan-31: an approved item its draft drops has one state, not "Planned" and "Dropped" at once.
  if (i.state !== "proposed" && i.change?.kind === "dropped") {
    const draft = i.change.draft_version != null ? `in draft ${i.change.draft_version} ` : "";
    const detail = `${draft}(was ${STATE[i.state].label})`;
    return { kind: "warn", label: `Dropped ${detail}`, dashed: false, head: "Dropped", detail, sep: " " };
  }
  if (i.state !== "proposed") return { ...STATE[i.state], dashed: false, head: STATE[i.state].label, detail: "", sep: "" };
  const c = i.change;
  let detail = "";
  if (c?.kind === "new") detail = "new";
  else if (c?.kind === "moved" && c.from_horizon && c.to_horizon) detail = `${HORIZON_LABEL[c.from_horizon]} → ${HORIZON_LABEL[c.to_horizon]}`;
  else if (c?.kind === "changed") detail = "changed";
  return { kind: "line", label: detail ? `Proposed · ${detail}` : "Proposed", dashed: true, head: "Proposed", detail, sep: detail ? " · " : "" };
}

/** The Engineering cell (F1 §6): the issue part, then the date part, joined by " · "; "—" when both are empty. */
export function engineeringLine(i: PlanItem): string {
  return engineeringParts(i).filter(Boolean).join(" · ") || "—";
}

/**
 * qa4-plan-30: an issue as the row names it: a GitHub reference ("acme/app#418") is "Issue 418",
 * a tracker key ("ENG-402") stays as it is. The inspector gives the whole reference and its link.
 */
export function issueName(ref: string): string {
  const m = /^[\w.-]+\/[\w.-]+#(\d+)$/.exec(ref);
  return m ? `Issue ${m[1]}` : ref;
}

/** The Engineering cell's two parts, [issue, date], each "" when there is none. */
export function engineeringParts(i: PlanItem): [string, string] {
  const e = i.engineering;
  const keys = e.records.map((r) => issueName(r.external_ref));
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
  return [issue, day];
}

/**
 * F3: the basis the item's date rests on (verified) or lost (withdrawn): one of the bases the plan
 * names for it (engineering.basis_ids: this PRD's, supporting the date, covering the item and named
 * in the date's source); the latest when several do. None for an unverified date.
 */
export function dateBasis(i: PlanItem, bases: Basis[]): Basis | undefined {
  const { date, date_status, basis_ids } = i.engineering;
  if (!date || (date_status !== "verified" && date_status !== "withdrawn")) return undefined;
  const at = (b: Basis) => (date_status === "verified" ? b.verified_at : b.withdrawn_at) ?? b.created_at;
  return bases.filter((b) => b.status === date_status && basis_ids.includes(b.id)).sort((a, b) => at(b).localeCompare(at(a)))[0];
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

/** The next decision as a verb phrase: [for many or "you", for one]. */
const NEXT_VERB: Record<string, [string, string]> = {
  review_prd: ["review the PRD", "reviews the PRD"],
  verify_date: ["verify the date", "verifies the date"],
  reverify_date: ["re-verify the date", "re-verifies the date"],
  decide_slip: ["decide on the slip", "decides on the slip"],
  resolve_blocker: ["resolve the blocker", "resolves the blocker"],
  reconcile: ["reconcile the plan with the tracker", "reconciles the plan with the tracker"],
  link_issue: ["link a tracker issue", "links a tracker issue"],
};

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** The button that takes the next decision, for a viewer who may: "Review the PRD", "Link issue". */
export function nextButton(n: PlanItem["next"]): string {
  if (n.action === "link_issue") return "Link issue";
  const v = n.action ? NEXT_VERB[n.action] : undefined;
  return v ? cap(v[0]) : n.label;
}

/**
 * qa-plan-29: the next decision as one sentence, who first: "Owners decide on the slip",
 * "Waiting on approvers to review the PRD", "You verify the date".
 */
export function nextSentence(n: PlanItem["next"], me: string | null | undefined): string {
  if (!n.action) return "—";
  const v = NEXT_VERB[n.action];
  const who = whoLabel(n.who, me);
  if (!v) return who ? `${n.label} · ${who}` : n.label;
  if (!who) return cap(v[0]);
  if (who === "you") return n.action === "review_prd" ? "Review the PRD" : `You ${v[0]}`;
  if (n.action === "review_prd") return `Waiting on ${who} to review the PRD`;
  const many = who === "owners" || who === "approvers" || who.endsWith("s");
  return `${cap(who)} ${many ? v[0] : v[1]}`;
}

/** "Usage alerts PRD v1" or "Checkout redesign PRD draft 2". */
export function prdLabel(i: PlanItem): string {
  if (!i.prd) return "—";
  const v = i.prd.version == null ? "" : i.prd.approved ? ` v${i.prd.version}` : ` draft ${i.prd.version}`;
  return `${docLabel({ title: i.prd.title, kind: "prd" })}${v}`;
}

/** The PRD by its name alone, for a column headed PRD: "Usage alerts" (qa-plan-5). */
export function prdName(i: PlanItem): string {
  if (!i.prd) return "—";
  return i.prd.title.replace(/[\s,·-]+PRD\b.*$/i, "").trim() || i.prd.title;
}

export const roadmapHref = (i: PlanItem) => `/documents/${i.roadmap.slug}/v/${i.roadmap.version}#${i.roadmap.anchor}`;

/** H4 §5: the row's strategy marker, the most severe open finding (none once all are waived). */
export function driftMarker(i: PlanItem): { kind: ChipKind; label: string } | null {
  const open = (i.drift ?? []).filter((d) => d.status === "open");
  const top = open.find((d) => d.severity === "high") ?? open[0];
  return top ? { kind: top.severity === "high" ? "crit" : "warn", label: top.label } : null;
}

/**
 * qa-plan-1: a track's health as one badge, the same on its PRD card and its track panel. Both
 * read the track's own health (the API's track overview), never a figure of their own.
 */
const TRACK_HEALTH: Record<Schemas["TrackOverview"]["health"], { kind: ChipKind; label: string }> = {
  on_track: { kind: "pass", label: "On track" },
  at_risk: { kind: "warn", label: "At risk" },
  off_track: { kind: "crit", label: "Off track" },
  no_roadmap: { kind: "na", label: "No roadmap" },
  paused: { kind: "na", label: "Paused" },
  closed: { kind: "na", label: "Closed" },
};
export function trackHealth(health: Schemas["TrackOverview"]["health"]): { kind: ChipKind; label: string } {
  return TRACK_HEALTH[health] ?? { kind: "na", label: "No roadmap" };
}
