"use client"; // MOCK-HOOK
/* MOCK-HOOK milestone-kinds: the owner's four proposals (?mk=a|b|c|d) on the real Milestones band, the
 * MOCK-HOOK card and "+ Milestone". Temporary: every line here is a mock-up hook; the kind data is invented
 * MOCK-HOOK and read by name from the mock's "milestone-kinds" scenario. */
// MOCK-HOOK
import type { ReactNode } from "react"; // MOCK-HOOK
// MOCK-HOOK
export type MkVariant = "a" | "b" | "c" | "d"; // MOCK-HOOK
export type MkKind = "sub" | "goal" | "delivery" | "gate" | "outside" | "handoff"; // MOCK-HOOK
export type MkStatus = "on_track" | "at_risk" | "hit" | "missed"; // MOCK-HOOK
export type MkMeasure = { name: string; baseline: string; target: string; now?: string }; // MOCK-HOOK
export type MkInfo = { kind: MkKind | null; status: MkStatus; why?: string; measure?: MkMeasure; done_when?: string; toward: string; from?: string; to?: string; parent?: string; subs?: string[] }; // MOCK-HOOK
// MOCK-HOOK
/** MOCK-HOOK The variant in the address (?mk=a|b|c|d), else none (the band as built). */
export function mkVariant(): MkVariant | null { // MOCK-HOOK
  if (typeof window === "undefined") return null; // MOCK-HOOK
  const v = new URLSearchParams(window.location.search).get("mk"); // MOCK-HOOK
  return v === "a" || v === "b" || v === "c" || v === "d" ? v : null; // MOCK-HOOK
} // MOCK-HOOK
// MOCK-HOOK
export const MK_KINDS: { kind: MkKind; name: string; tip: string }[] = [ // MOCK-HOOK
  { kind: "goal", name: "Goal", tip: "A measured goal that must be hit, from a baseline to a target" }, // MOCK-HOOK
  { kind: "sub", name: "Sub-goal", tip: "A measured step that builds toward a goal" }, // MOCK-HOOK
  { kind: "delivery", name: "Delivery", tip: "Features shipped together by a date; done when shipped" }, // MOCK-HOOK
  { kind: "gate", name: "Decision", tip: "By its date the team knows something and decides; done when the answer is recorded" }, // MOCK-HOOK
  { kind: "outside", name: "Outside date", tip: "Set from outside (a conference, a partner launch, a contract, a freeze); work must be ready for it" }, // MOCK-HOOK
  { kind: "handoff", name: "Hand-off", tip: "One track delivers what another track waits on" }, // MOCK-HOOK
]; // MOCK-HOOK
export const kindName = (k: MkKind | null) => MK_KINDS.find((x) => x.kind === k)?.name ?? "Milestone"; // MOCK-HOOK
export const MK_STATUS: Record<MkStatus, string> = { on_track: "On track", at_risk: "At risk", hit: "Hit", missed: "Missed" }; // MOCK-HOOK
export const statusColor = (s: MkStatus) => ({ on_track: "var(--accent)", at_risk: "var(--warn)", hit: "var(--pass)", missed: "var(--crit)" })[s]; // MOCK-HOOK
export const MK_GOALS = ["Grow paying teams", "Keep members safe", "Handle 10x messages", "Keep accounts healthy"]; // MOCK-HOOK
// MOCK-HOOK
/** MOCK-HOOK The example kind data, by milestone name (invented). */
const MK_DATA: Record<string, MkInfo> = { // MOCK-HOOK
  "Safe daily DM limit found": { kind: "gate", status: "missed", why: "No answer by Dec 7: the test ran in 2 of 5 regions", done_when: "The safe daily limit is recorded", toward: "Keep members safe" }, // MOCK-HOOK
  "Signup in 2 min for 60%": { kind: "sub", status: "hit", why: "62% on Dec 10", measure: { name: "New teams signed up within 2 minutes", baseline: "35%", target: "60%", now: "62%" }, toward: "Grow paying teams", parent: "400 paying teams" }, // MOCK-HOOK
  "Queue ready for checkout": { kind: "handoff", status: "on_track", done_when: "Checkout runs on the new queue in test", toward: "Grow paying teams", from: "Scale", to: "Growth & Revenue" }, // MOCK-HOOK
  "Holiday code freeze": { kind: "outside", status: "on_track", done_when: "Seat admin page is live by the freeze", toward: "Keep accounts healthy" }, // MOCK-HOOK
  "Trial to paid at 6%": { kind: "sub", status: "at_risk", why: "4.0% now, up from 3.1%: trial emails start late", measure: { name: "Trials that turn paid", baseline: "3.1%", target: "6%", now: "4.0%" }, toward: "Grow paying teams", parent: "400 paying teams" }, // MOCK-HOOK
  Beta: { kind: "delivery", status: "on_track", done_when: "Split storage and new queue at 50 teams", toward: "Handle 10x messages" }, // MOCK-HOOK
  "Partner app launch": { kind: "outside", status: "on_track", done_when: "Renewal reminders ready for launch day", toward: "Keep accounts healthy" }, // MOCK-HOOK
  "Reports answered in 1 day": { kind: "goal", status: "on_track", measure: { name: "Reports answered within a day", baseline: "40%", target: "90%", now: "55%" }, toward: "Keep members safe" }, // MOCK-HOOK
  "400 paying teams": { kind: "goal", status: "on_track", measure: { name: "Paying teams", baseline: "180", target: "400", now: "236" }, toward: "Grow paying teams", subs: ["Signup in 2 min for 60%", "Trial to paid at 6%", "Churn under 3% a month"] }, // MOCK-HOOK
  "Public launch": { kind: "delivery", status: "on_track", done_when: "Team checkout and credits ship to all", toward: "Grow paying teams" }, // MOCK-HOOK
}; // MOCK-HOOK
export const mkInfo = (name: string): MkInfo => MK_DATA[name] ?? { kind: "delivery", status: "on_track", done_when: "", toward: MK_GOALS[0] }; // MOCK-HOOK
export const isGoalKind = (k: MkKind | null) => k === "goal" || k === "sub"; // MOCK-HOOK
/** MOCK-HOOK What it is done by, in one line (a measure: baseline to target). */
export const doneLine = (i: MkInfo) => (i.measure ? `${i.measure.name}: ${i.measure.baseline} → ${i.measure.target}${i.measure.now ? ` (now ${i.measure.now})` : ""}` : i.done_when ? `Done when ${i.done_when.charAt(0).toLowerCase()}${i.done_when.slice(1)}` : ""); // MOCK-HOOK
// MOCK-HOOK
/** MOCK-HOOK A kind's own small mark (A's band markers, B's label icons, the picker). */
export function MkIcon({ kind, size = 12, color = "currentColor" }: { kind: MkKind | null; size?: number; color?: string }) { // MOCK-HOOK
  const s = { width: size, height: size, flex: "none" as const, display: "block" }; // MOCK-HOOK
  const p = { stroke: color, strokeWidth: 1.8, fill: "none", strokeLinejoin: "round" as const, strokeLinecap: "round" as const }; // MOCK-HOOK
  let body: ReactNode; // MOCK-HOOK
  if (kind === "goal") body = <path d="M8 1.5 14.5 8 8 14.5 1.5 8Z" {...p} fill={color} />; // MOCK-HOOK
  else if (kind === "sub") body = <path d="M8 2.2 13.8 8 8 13.8 2.2 8Z" {...p} fill="var(--surface)" />; // MOCK-HOOK
  else if (kind === "delivery") body = <><path d="M3.5 14.5V1.8" {...p} /><path d="M3.5 2.2h9l-2.2 3.2 2.2 3.2h-9Z" {...p} fill={color} /></>; // MOCK-HOOK
  else if (kind === "gate") body = <><path d="M3 14.5V2.5M13 14.5V2.5M3 5.5h10M3 9.5h10" {...p} /></>; // MOCK-HOOK
  else if (kind === "outside") body = <><path d="M8 15c3-3.6 4.8-6.2 4.8-8.6a4.8 4.8 0 0 0-9.6 0C3.2 8.8 5 11.4 8 15Z" {...p} fill={color} /><circle cx="8" cy="6.4" r="1.7" fill="var(--surface)" /></>; // MOCK-HOOK
  else if (kind === "handoff") body = <><path d="M1.8 8h11" {...p} /><path d="M9 3.8 13.4 8 9 12.2" {...p} /></>; // MOCK-HOOK
  else body = <path d="M8 1.5 14.5 8 8 14.5 1.5 8Z" {...p} fill={color} />; // MOCK-HOOK
  return ( // MOCK-HOOK
    <svg aria-hidden viewBox="0 0 16 16" style={s}> {/* MOCK-HOOK */}
      {body} {/* MOCK-HOOK */}
    </svg> // MOCK-HOOK
  ); // MOCK-HOOK
} // MOCK-HOOK
// MOCK-HOOK
/** MOCK-HOOK B's status mark: a tick on track, a filled tick when hit, a warning when at risk or missed. */
export function MkStatusMark({ status, size = 12 }: { status: MkStatus; size?: number }) { // MOCK-HOOK
  const c = statusColor(status); // MOCK-HOOK
  return ( // MOCK-HOOK
    <svg aria-hidden viewBox="0 0 16 16" style={{ width: size, height: size, flex: "none", display: "block" }}> {/* MOCK-HOOK */}
      {status === "hit" && <><circle cx="8" cy="8" r="7" fill={c} /><path d="M4.6 8.2 7 10.5l4.4-4.8" stroke="var(--surface)" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" /></>} {/* MOCK-HOOK */}
      {status === "on_track" && <path d="M3.5 8.4 6.6 11.4 12.6 4.8" stroke={c} strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" />} {/* MOCK-HOOK */}
      {(status === "at_risk" || status === "missed") && <><path d="M8 1.8 15 14.2H1Z" fill={c} /><path d="M8 6.2v3.6" stroke="var(--surface)" strokeWidth="1.8" strokeLinecap="round" /><circle cx="8" cy="12" r="1" fill="var(--surface)" /></>} {/* MOCK-HOOK */}
    </svg> // MOCK-HOOK
  ); // MOCK-HOOK
} // MOCK-HOOK
// MOCK-HOOK
/** MOCK-HOOK The legend behind the band's (i), per proposal. */
export function MkLegend({ v }: { v: MkVariant }) { // MOCK-HOOK
  const row = (icon: ReactNode, words: string, key: string) => ( // MOCK-HOOK
    <span key={key} className="flex items-center gap-2 whitespace-nowrap"> {/* MOCK-HOOK */}
      {icon} {words} {/* MOCK-HOOK */}
    </span> // MOCK-HOOK
  ); // MOCK-HOOK
  const kinds = MK_KINDS.map((k) => row(<MkIcon kind={k.kind} color="currentColor" />, k.name, k.kind)); // MOCK-HOOK
  const statuses = (["on_track", "at_risk", "hit", "missed"] as MkStatus[]).map((s) => row(v === "c" ? <i className="block h-2.5 w-2.5 rotate-45 rounded-[1px]" style={{ background: statusColor(s) }} /> : <MkStatusMark status={s} />, MK_STATUS[s], s)); // MOCK-HOOK
  return ( // MOCK-HOOK
    <span className="flex flex-col gap-1 text-xs" data-testid="mk-legend"> {/* MOCK-HOOK */}
      {v === "d" && row(<MkIcon kind="goal" />, "Top row: goals and sub-goals", "top")} {/* MOCK-HOOK */}
      {v === "d" && row(<MkIcon kind="delivery" />, "Bottom row: dates, deliveries, decisions, hand-offs", "bottom")} {/* MOCK-HOOK */}
      {(v === "a" || v === "b") && kinds} {/* MOCK-HOOK */}
      {v === "a" && row(<span className="block h-2.5 w-4 border-t-2 border-current" />, "Hand-off arrow: from one track to another", "arrow")} {/* MOCK-HOOK */}
      {(v === "b" || v === "c") && statuses} {/* MOCK-HOOK */}
    </span> // MOCK-HOOK
  ); // MOCK-HOOK
} // MOCK-HOOK
