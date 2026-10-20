import type { ChipKind, IconName } from "@/components/ds";

/** Fictional sample data for the kit page (the Quillfield clinic set: check-in, deposits, reminders). */
export type SampleFeature = {
  id: string;
  title: string;
  goal: string;
  proposed?: boolean;
  status: { kind: ChipKind; label: string };
  confidence: number | null;
  journey: number;
  cost: number | null;
  horizon: "Now" | "Next" | "Later";
};

export const FEATURES: SampleFeature[] = [
  { id: "check-in", title: "Clinic check-in kiosk", goal: "G1", status: { kind: "pass", label: "Traced" }, confidence: 81, journey: 8, cost: 18.4, horizon: "Now" },
  { id: "deposits", title: "Online deposits", goal: "G2", status: { kind: "acc", label: "In flight" }, confidence: 66, journey: 5, cost: 27.6, horizon: "Now" },
  { id: "reminders", title: "Visit reminders", goal: "G3", status: { kind: "warn", label: "Flagged" }, confidence: 34, journey: 3, cost: 6.2, horizon: "Next" },
  { id: "waitlist", title: "Waitlist by text", goal: "G1", status: { kind: "na", label: "Draft" }, confidence: null, journey: 1, cost: null, horizon: "Next" },
  { id: "intake", title: "Intake forms", goal: "G4", proposed: true, status: { kind: "crit", label: "Blocked" }, confidence: 12, journey: 6, cost: 9.1, horizon: "Later" },
  { id: "front-desk", title: "Front desk queue", goal: "G1", status: { kind: "pass", label: "Traced" }, confidence: 92, journey: 9, cost: 4.8, horizon: "Later" },
  { id: "no-shows", title: "No-show deposits", goal: "G2", status: { kind: "warn", label: "In review" }, confidence: 58, journey: 7, cost: 12.0, horizon: "Later" },
  { id: "rebook", title: "One-tap rebook", goal: "G3", status: { kind: "na", label: "Idea" }, confidence: 0, journey: 2, cost: null, horizon: "Later" },
];

export const CHIP_KINDS: { kind: ChipKind; label: string }[] = [
  { kind: "pass", label: "Approved" },
  { kind: "warn", label: "In review" },
  { kind: "crit", label: "Blocked" },
  { kind: "na", label: "Draft" },
  { kind: "acc", label: "9 new" },
  { kind: "now", label: "Now" },
  { kind: "line", label: "v3" },
];

export const ICONS = [
  "home", "requests", "baseline", "prds", "priorities", "roadmap", "runs", "inbox", "settings", "more",
  "plus", "check", "x", "flag", "coin", "pause", "doc", "comment", "ask", "alert", "arrow", "back",
  "chevron-left", "chevron-right",
  "search", "clock", "user", "lock", "grip", "sun", "moon", "monitor", "signout", "folder", "link", "sources",
] as const satisfies readonly IconName[];

// Fails to compile when the kit gains an icon this page does not show.
type MissingIcon = Exclude<IconName, (typeof ICONS)[number]>;
export const ALL_ICONS_SHOWN: [MissingIcon] extends [never] ? true : MissingIcon = true;
