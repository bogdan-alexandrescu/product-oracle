/**
 * MOCK-HOOK (GM1 mock-ups, never merged): GET /v1/simple/goal-map, the goal map's invented data.
 * Company goals, areas of focus in the owner's order, KPI milestones with their proof and the
 * features serving them. `?data=hard` gives the hard case: 5 areas, 12 milestones, 40 features,
 * one milestone missed, one goal not measured yet. Invented people, products and numbers only.
 */

export type GmStatus = "met" | "on_track" | "at_risk" | "missed" | "not_measured"; // MOCK-HOOK
export type GmLift = "helping" | "not_helping" | "not_measured"; // MOCK-HOOK

export interface GmGoal {
  id: string;
  name: string;
  measure: string;
  target: number;
  current: number | null;
  unit: string;
  status: GmStatus;
  /** The simple math it builds on, in words. */
  math: string;
  builds_on: string[];
  history: { date: string; text: string; by: string }[];
}
export interface GmArea {
  id: string;
  name: string;
  lever: string;
}
export interface GmMilestone {
  id: string;
  name: string;
  goal: string;
  measure: string;
  threshold: number;
  unit: string;
  current: number | null;
  status: GmStatus;
  areas: string[];
  depends: string[];
  month: string;
  days: (number | null)[];
  confirmed: string | null;
  proposed?: boolean;
}
export interface GmFeature {
  id: string;
  name: string;
  area: string;
  milestones: string[];
  lever: string;
  expected: string;
  confidence: "High" | "Medium" | "Low";
  released: boolean;
  measured: string | null;
  lift: GmLift;
}
export interface GmGuardrail {
  name: string;
  rule: string;
  current: number;
  days: number[];
  held: boolean;
}
export interface GoalMap {
  goals: GmGoal[];
  areas: GmArea[];
  guardrail: GmGuardrail;
  milestones: GmMilestone[];
  features: GmFeature[];
  today: string;
  reps: number;
}

const GOALS: GmGoal[] = [
  {
    id: "signups",
    name: "Sign-ups per rep per day",
    measure: "sign-ups per rep per day",
    target: 40,
    current: 31,
    unit: "",
    status: "on_track",
    math: "Each rep's daily sign-ups",
    builds_on: [],
    history: [
      { date: "Oct 30, 2026", text: "Target 30 → 40", by: "Dana Whitlock" },
      { date: "Sep 14, 2026", text: "Goal set at 30", by: "Dana Whitlock" },
    ],
  },
  {
    id: "conversions",
    name: "Paid conversions per rep per day",
    measure: "paid conversions per rep per day",
    target: 10,
    current: 5.6,
    unit: "",
    status: "at_risk",
    math: "Sign-ups per rep × conversion rate (needs 40–65 sign-ups at 15–25%)",
    builds_on: ["signups"],
    history: [{ date: "Oct 2, 2026", text: "Goal set at 10", by: "Dana Whitlock" }],
  },
  {
    id: "revenue",
    name: "Revenue per day",
    measure: "revenue per day",
    target: 20000,
    current: 11200,
    unit: "$",
    status: "on_track",
    math: "Reps × conversions per rep × value",
    builds_on: ["conversions"],
    history: [{ date: "Oct 2, 2026", text: "Goal set at $20k", by: "Dana Whitlock" }],
  },
];

const AREAS: GmArea[] = [
  { id: "scale", name: "Scale per rep", lever: "Sign-ups per rep" },
  { id: "safety", name: "Customer safety", lever: "Guardrail: complaints" },
  { id: "conv", name: "Conversions (incl. new channels)", lever: "Conversion rate" },
  { id: "onboard", name: "Onboarding & revenue", lever: "Value per conversion" },
];
const FIFTH: GmArea = { id: "reps", name: "More reps", lever: "Number of reps" };

const GUARDRAIL: GmGuardrail = { name: "Customer complaints", rule: "= 0 every day", current: 0, days: [0, 0, 0, 0, 0, 0, 0], held: true };

const by = ["Priya Okafor", "Marco Lindqvist", "Dana Whitlock", "Sam Ferreira"];

function ms(
  id: string,
  name: string,
  goal: string,
  threshold: number,
  current: number | null,
  status: GmStatus,
  areas: string[],
  depends: string[],
  month: string,
  unit = GOALS.find((g) => g.id === goal)!.unit,
): GmMilestone {
  const wiggle = [0.04, 0.01, 0.05, 0.02, 0.06, 0.03, 0.05];
  const days =
    current === null
      ? [null, null, null, null, null, null, null]
      : status === "met"
        ? wiggle.map((w, i) => Math.round(Math.max(threshold, current * (0.94 + w + i * 0.005)) * 10) / 10)
        : Array.from({ length: 7 }, (_, i) => Math.round(current * (1 - (6 - i) * 0.02 + wiggle[i] / 4) * 10) / 10);
  return {
    id,
    name,
    goal,
    measure: GOALS.find((g) => g.id === goal)!.measure,
    threshold,
    unit,
    current,
    status,
    areas,
    depends,
    month,
    days,
    confirmed: status === "met" ? by[id.length % by.length] : null,
  };
}

const MILESTONES: GmMilestone[] = [
  ms("m1", "25 sign-ups per rep", "signups", 25, 31, "met", ["scale"], [], "Oct"),
  ms("m2", "50 sign-ups per rep", "signups", 50, 31, "on_track", ["scale", "onboard"], ["m1"], "Nov"),
  ms("m3", "3 paid conversions per rep", "conversions", 3, 5.6, "met", ["conv"], ["m1"], "Oct"),
  ms("m4", "6 paid conversions per rep", "conversions", 6, 5.6, "at_risk", ["conv", "safety"], ["m3"], "Nov"),
  ms("m5", "$12k revenue per day", "revenue", 12000, 11200, "on_track", ["onboard"], ["m3"], "Nov", "$"),
  ms("m6", "10 paid conversions per rep", "conversions", 10, 5.6, "not_measured", ["conv", "onboard"], ["m2", "m4"], "Dec"),
  ms("m7", "$20k revenue per day", "revenue", 20000, 11200, "not_measured", ["onboard", "scale"], ["m5", "m6"], "Jan"),
];
for (const m of MILESTONES) if (m.status === "not_measured") m.days = m.days.map(() => null);
MILESTONES[5].current = null;
MILESTONES[6].current = null;

function ft(
  id: string,
  name: string,
  area: string,
  milestones: string[],
  lever: string,
  expected: string,
  confidence: GmFeature["confidence"],
  lift: GmLift,
  measured: string | null,
  released = lift !== "not_measured" || measured !== null,
): GmFeature {
  return { id, name, area, milestones, lever, expected, confidence, released, measured, lift };
}

const FEATURES: GmFeature[] = [
  ft("f1", "One-tap sign-up link", "scale", ["m1"], "Sign-ups per rep", "+6 a day", "High", "helping", "+8 a day"),
  ft("f2", "Rep call script hints", "scale", ["m2"], "Sign-ups per rep", "+5 a day", "Medium", "not_helping", "+0 a day"),
  ft("f3", "Lead list ranking", "scale", ["m2"], "Sign-ups per rep", "+7 a day", "Medium", "not_measured", null, false),
  ft("f4", "Complaint early warning", "safety", ["m4"], "Guardrail", "Keeps complaints at 0", "High", "helping", "0 complaints, 21 days"),
  ft("f5", "Refund in one step", "safety", ["m4"], "Guardrail", "Keeps complaints at 0", "Medium", "not_measured", null, false),
  ft("f6", "Trial reminder texts", "conv", ["m3"], "Conversion rate", "+3 points", "High", "helping", "+4 points"),
  ft("f7", "Partner referral channel", "conv", ["m4", "m6"], "Conversion rate", "+4 points", "Low", "not_measured", null, false),
  ft("f8", "Pricing page test", "conv", ["m4"], "Conversion rate", "+2 points", "Medium", "not_helping", "−1 point"),
  ft("f9", "Guided first week", "onboard", ["m2", "m5"], "Value per conversion", "+$40 each", "Medium", "helping", "+$55 each"),
  ft("f10", "Annual plan offer", "onboard", ["m5", "m7"], "Value per conversion", "+$90 each", "Low", "not_measured", null, false),
  ft("f11", "Team invite at sign-up", "onboard", ["m6"], "Value per conversion", "+$30 each", "Medium", "not_measured", null, false),
  ft("f12", "Rep daily scoreboard", "scale", ["m7"], "Sign-ups per rep", "+3 a day", "Medium", "not_measured", null, false),
];

/** The hard case: 5 areas, 12 milestones, 40 features, one milestone missed, one goal not measured yet. */
function hard(): GoalMap {
  const goals: GmGoal[] = GOALS.map((g) => ({ ...g, history: [...g.history] }));
  goals[2] = { ...goals[2], current: null, status: "not_measured" };
  const areas = [...AREAS, FIFTH];
  const extra: GmMilestone[] = [
    ms("m8", "75 sign-ups per rep", "signups", 75, null, "not_measured", ["scale", "reps"], ["m2"], "Dec"),
    ms("m9", "Complaints held 0 for 30 days", "conversions", 0, 0, "on_track", ["safety"], ["m4"], "Nov"),
    ms("m10", "8 paid conversions per rep", "conversions", 8, 5.6, "missed", ["conv"], ["m3"], "Oct"),
    ms("m11", "12 reps live", "signups", 12, 9, "on_track", ["reps"], [], "Nov"),
    ms("m12", "$30k revenue per day", "revenue", 30000, null, "not_measured", ["onboard", "reps"], ["m7"], "Feb", "$"),
  ];
  extra[0].current = null;
  extra[0].days = extra[0].days.map(() => null);
  extra[4].days = extra[4].days.map(() => null);
  extra[1].measure = "days in a row with no complaints";
  extra[3].measure = "reps live";
  const milestones = [...MILESTONES.map((m) => ({ ...m })), ...extra];
  for (const m of milestones) if (m.goal === "revenue" && !m.proposed) {
    m.current = null;
    m.days = m.days.map(() => null);
    m.status = "not_measured";
  }
  const names = [
    "Call queue autopilot", "Shared rep notes", "Smart follow-up timer", "Lead source tags", "Voice memo sign-up",
    "Quiet hours for calls", "Do-not-call check", "Plain cancel button", "Complaint reply in 1 hour", "Calm reminders",
    "Two-step checkout", "Chat channel trial", "Local-language pages", "Win-back offer", "Price in local money",
    "Welcome call booking", "Setup in 10 minutes", "Usage nudges", "Upgrade at day 20", "Family plan",
    "Rep hiring page", "New rep training", "Rep buddy system", "Territory planner", "Rep target board",
    "Weekend sign-up desk", "Sign-up kiosk mode", "Faster ID check",
  ];
  const areaFor = ["scale", "scale", "scale", "conv", "scale", "safety", "safety", "safety", "safety", "safety", "conv", "conv", "conv", "conv", "conv", "onboard", "onboard", "onboard", "onboard", "onboard", "reps", "reps", "reps", "reps", "reps", "scale", "scale", "reps"];
  const leverOf: Record<string, [string, string]> = {
    scale: ["Sign-ups per rep", "+2 a day"],
    safety: ["Guardrail", "Keeps complaints at 0"],
    conv: ["Conversion rate", "+1 point"],
    onboard: ["Value per conversion", "+$20 each"],
    reps: ["Number of reps", "+1 rep"],
  };
  const msFor: Record<string, string[]> = {
    scale: ["m2", "m8", "m7"],
    safety: ["m9", "m4"],
    conv: ["m10", "m6", "m4"],
    onboard: ["m5", "m7", "m12"],
    reps: ["m11", "m8", "m12"],
  };
  const lifts: GmLift[] = ["helping", "not_measured", "not_helping", "not_measured", "helping", "not_measured", "not_measured"];
  const more = names.map((name, i) => {
    const area = areaFor[i];
    const lift = lifts[i % lifts.length];
    const list = msFor[area];
    return ft(
      `h${i}`,
      name,
      area,
      [list[i % list.length]],
      leverOf[area][0],
      leverOf[area][1],
      (["High", "Medium", "Low"] as const)[i % 3],
      lift,
      lift === "helping" ? leverOf[area][1].replace("2", "3").replace("1 ", "2 ") : lift === "not_helping" ? "+0" : null,
      lift !== "not_measured" || i % 2 === 0,
    );
  });
  return { goals, areas, guardrail: GUARDRAIL, milestones, features: [...FEATURES, ...more], today: "Nov 3", reps: 12 };
}

export function goalMapOut(q: URLSearchParams): GoalMap {
  if (q.get("data") === "hard") return hard(); // MOCK-HOOK
  return {
    goals: GOALS.map((g) => ({ ...g, history: [...g.history] })),
    areas: [...AREAS],
    guardrail: GUARDRAIL,
    milestones: MILESTONES.map((m) => ({ ...m })),
    features: FEATURES.map((f) => ({ ...f })),
    today: "Nov 3",
    reps: 10,
  };
}
