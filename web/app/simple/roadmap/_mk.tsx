"use client";

// tb-mk (the owner's pick B, "Icon in the label"): every roadmap milestone is one of six kinds;
// each label chip leads with its kind's small icon and ends with its status mark (a tick on
// track, a filled tick hit, an amber warning at risk, a red warning missed), the reason in its
// tooltip; the legend sits behind the Milestones band's (i).

import type { ReactNode } from "react";

import type { Schemas } from "@/lib/api/client";

type Gm = Schemas["SimpleGoalMilestone"];
export type MkKind = Gm["kind"];
export type MkStatus = Gm["status"];

export const MK_KINDS: { kind: MkKind; name: string; tip: string }[] = [
  { kind: "goal", name: "Goal", tip: "A measured goal that must be hit, from a baseline to a target" },
  { kind: "sub_goal", name: "Sub-goal", tip: "A measured step that builds toward a goal" },
  { kind: "delivery", name: "Delivery", tip: "Features shipped together by a date; done when shipped" },
  { kind: "decision", name: "Decision", tip: "By its date the team knows something and decides; done when the answer is recorded" },
  { kind: "outside", name: "Outside date", tip: "Set from outside (a conference, a partner launch, a contract, a freeze)" },
  { kind: "handoff", name: "Hand-off", tip: "One track delivers what another track waits on" },
];
export const kindName = (k: MkKind | null | undefined) => MK_KINDS.find((x) => x.kind === k)?.name ?? "Milestone";
export const MK_STATUS: Record<MkStatus, string> = { on_track: "On track", at_risk: "At risk", hit: "Hit", missed: "Missed" };
export const statusColor = (s: MkStatus) => ({ on_track: "var(--accent)", at_risk: "var(--warn)", hit: "var(--pass)", missed: "var(--crit)" })[s];
export const isMeasured = (k: MkKind | null | undefined) => k === "goal" || k === "sub_goal";

/** A kind's own small mark (the label's icon, the picker, the legend). */
export function MkIcon({ kind, size = 12, color = "currentColor" }: { kind: MkKind | null | undefined; size?: number; color?: string }) {
  const s = { width: size, height: size, flex: "none" as const, display: "block" };
  const p = { stroke: color, strokeWidth: 1.8, fill: "none", strokeLinejoin: "round" as const, strokeLinecap: "round" as const };
  let body: ReactNode;
  if (kind === "sub_goal") body = <path d="M8 2.2 13.8 8 8 13.8 2.2 8Z" {...p} fill="var(--surface)" />;
  else if (kind === "delivery")
    body = (
      <>
        <path d="M3.5 14.5V1.8" {...p} />
        <path d="M3.5 2.2h9l-2.2 3.2 2.2 3.2h-9Z" {...p} fill={color} />
      </>
    );
  else if (kind === "decision") body = <path d="M3 14.5V2.5M13 14.5V2.5M3 5.5h10M3 9.5h10" {...p} />;
  else if (kind === "outside")
    body = (
      <>
        <path d="M8 15c3-3.6 4.8-6.2 4.8-8.6a4.8 4.8 0 0 0-9.6 0C3.2 8.8 5 11.4 8 15Z" {...p} fill={color} />
        <circle cx="8" cy="6.4" r="1.7" fill="var(--surface)" />
      </>
    );
  else if (kind === "handoff")
    body = (
      <>
        <path d="M1.8 8h11" {...p} />
        <path d="M9 3.8 13.4 8 9 12.2" {...p} />
      </>
    );
  else body = <path d="M8 1.5 14.5 8 8 14.5 1.5 8Z" {...p} fill={color} />;
  return (
    <svg aria-hidden data-testid="mk-icon" data-kind={kind ?? undefined} viewBox="0 0 16 16" style={s}>
      {body}
    </svg>
  );
}

/** The status mark: a tick on track, a filled tick when hit, a warning when at risk or missed. */
export function MkStatusMark({ status, size = 12 }: { status: MkStatus; size?: number }) {
  const c = statusColor(status);
  return (
    <svg aria-hidden viewBox="0 0 16 16" style={{ width: size, height: size, flex: "none", display: "block" }}>
      {status === "hit" && (
        <>
          <circle cx="8" cy="8" r="7" fill={c} />
          <path d="M4.6 8.2 7 10.5l4.4-4.8" stroke="var(--surface)" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
        </>
      )}
      {status === "on_track" && <path d="M3.5 8.4 6.6 11.4 12.6 4.8" stroke={c} strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" />}
      {(status === "at_risk" || status === "missed") && (
        <>
          <path d="M8 1.8 15 14.2H1Z" fill={c} />
          <path d="M8 6.2v3.6" stroke="var(--surface)" strokeWidth="1.8" strokeLinecap="round" />
          <circle cx="8" cy="12" r="1" fill="var(--surface)" />
        </>
      )}
    </svg>
  );
}

/** The legend behind the Milestones band's (i): each kind's icon, then each status mark. */
export function MkLegend() {
  const row = (icon: ReactNode, words: string, key: string) => (
    <span key={key} className="flex items-center gap-2 whitespace-nowrap">
      {icon} {words}
    </span>
  );
  return (
    <span className="flex flex-col gap-1 text-xs" data-testid="mk-legend">
      {MK_KINDS.map((k) => row(<MkIcon kind={k.kind} />, k.name, k.kind))}
      {(Object.keys(MK_STATUS) as MkStatus[]).map((s) => row(<MkStatusMark status={s} />, MK_STATUS[s], s))}
    </span>
  );
}

/** What it is done by, in one line (a measure: baseline to target). */
export function doneLine(m: Pick<Gm, "measure" | "baseline" | "target" | "current" | "done_when_line" | "kind">): string {
  if (isMeasured(m.kind) && m.measure) return `${m.measure}: ${m.baseline ?? "?"} → ${m.target ?? "?"}${m.current != null ? ` (now ${m.current})` : ""}`;
  return m.done_when_line ? `Done when ${m.done_when_line.charAt(0).toLowerCase()}${m.done_when_line.slice(1)}` : "";
}
