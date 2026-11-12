/**
 * goal-map-tracks: the "goal-map-tracks" scenario (GM_TRACKS_SCENARIO), the Goal map drawn as a grid:
 * four goals as columns, the roadmap's five tracks as rows, each cell the features whose roadmap
 * item is on that track and serves that goal. Ten milestones by date; each feature is its own Simple
 * roadmap item ("gm-f1", ...; code F-201, ...) on one of the tracks (Scale, Safety, Activation,
 * Revenue, Account Management), as the map's areas are too. The goals are Baseline goals and goal
 * buckets (one store, the same ids), as goal-ladder's. "goal-map-tracks-hard" (GM_TRACKS_HARD_SCENARIO)
 * gives the first goal 30 long-named features and seven more milestones, and two features with no
 * track (one on a milestone, one on none). "goal-map-tracks-heads" (GM_TRACKS_HEADS_SCENARIO) and its
 * five-goal twin give the goals every status (On track, At risk, Met, Not measured) and long targets
 * (money, a number with a long unit), for the goal cards' header row. Invented company, people and products only.
 */
import type { Schemas } from "@/lib/api/client";

type GoalMap = Schemas["GoalMapOut"];
type GmGoal = Schemas["GmGoal"];
type GmMilestone = Schemas["GmMilestone"];
type GmFeature = Schemas["GmFeature"];
type Status = GmMilestone["status"];

export const GM_TRACKS_SCENARIO = "goal-map-tracks";
export const GM_TRACKS_HARD_SCENARIO = "goal-map-tracks-hard";
export const GM_TRACKS_HEADS_SCENARIO = "goal-map-tracks-heads";
export const GM_TRACKS_HEADS5_SCENARIO = "goal-map-tracks-heads-five";

/** The roadmap's tracks in their order: Simple's track key and its name (the map's areas are the same five). */
export const GM_TRACKS: { key: string; area: string; title: string; lever: string }[] = [
  { key: "gm-scale", area: "gtscale", title: "Scale", lever: "Reach" },
  { key: "gm-safety", area: "gtsafety", title: "Safety", lever: "Failed payments" },
  { key: "gm-activation", area: "gtactivation", title: "Activation", lever: "Activations" },
  { key: "gm-revenue", area: "gtrevenue-t", title: "Revenue", lever: "Value per account" },
  { key: "gm-accounts", area: "gtaccounts", title: "Account Management", lever: "Kept accounts" },
];
/** The scenario's names, for its specs. */
export const GM_TRACKS_NAMES = {
  today: "2026-11-10",
  goals: ["Booked demos per rep per day", "Failed payments per day", "Activations per team per week", "Revenue per day"],
  /** Hard only: the features with no track. */
  noTrackPlaced: "Receipt emails in plain words",
  noTrackUnplaced: "Help center search",
} as const;

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function goal(id: string, name: string, target: number, current: number, unit: string, status: Status, math: string): GmGoal {
  return {
    id, name, measure: name.toLowerCase(), target, current, unit, status, math, builds_on: [],
    history: [{ date: "Oct 1, 2026", text: `Goal set at ${unit === "$" ? `$${target / 1000}k` : target}`, by: "Robin Example" }],
    metric: { id: `metric-${id}`, title: name.toLowerCase() }, missing: null, choices: [], read_on: "Nov 10",
  };
}

const GOALS: GmGoal[] = [
  goal("gtdemos", "Booked demos per rep per day", 40, 31, "", "on_track", "Key results: 60% of calls reach a decision maker · 8 open demo slots per rep each day"),
  goal("gtpayments", "Failed payments per day", 0, 3, "", "at_risk", "Key results: card retries recover 90% · no payment stuck over 1 hour"),
  // Not measured yet: no metric, one to pick (with last week's value).
  {
    ...goal("gtactivations", "Activations per team per week", 30, 18, "", "at_risk", "Key results: setup done in 1 day · 70% of invited people sign in"),
    current: null, status: "not_measured", metric: null, read_on: null, choices: [{ id: "metric-gtactivations-weekly", title: "Weekly team activations", last: 22 }],
  },
  goal("gtrevenue", "Revenue per day", 20000, 13400, "$", "on_track", "Key results: 25% pick the annual plan · upgrades at day 20 reach 12%"),
];

/** The heads scenarios' goals: the same ids (their milestones and features stay), every status and long targets. */
const HEADS: Record<string, Partial<GmGoal>> = {
  gtdemos: { target: 40, current: 42, status: "met" },
  gtpayments: { name: "Recovered card payments per month", target: 250000, current: 150000, unit: "$", status: "at_risk" },
  gtactivations: { target: 1200, unit: "shops signed up each week" },
  gtrevenue: { target: 12000, current: 10200, unit: "$", status: "on_track" },
};
const FIFTH_GOAL: GmGoal = goal("gtreferrals", "Referrals from happy customers", 1500, 1200, "referred teams per month", "on_track", "Key results: 1 in 5 new teams comes from a referral");

/** The goals of a scenario: the four, or the heads scenarios' (five with GM_TRACKS_HEADS5_SCENARIO). */
function goalsOf(scenario: string | null): GmGoal[] {
  const four = GOALS.map((g) => ({ ...g, history: [...g.history] }));
  if (scenario !== GM_TRACKS_HEADS_SCENARIO && scenario !== GM_TRACKS_HEADS5_SCENARIO) return four;
  const heads = four.map((g) => ({ ...g, ...HEADS[g.id] }));
  return scenario === GM_TRACKS_HEADS5_SCENARIO ? [...heads, { ...FIFTH_GOAL, history: [...FIFTH_GOAL.history] }] : heads;
}

/** Whether a scenario is one of goal-map-tracks'. */
export const isTracksScenario = (s: string | null) => s === GM_TRACKS_SCENARIO || s === GM_TRACKS_HARD_SCENARIO || s === GM_TRACKS_HEADS_SCENARIO || s === GM_TRACKS_HEADS5_SCENARIO;

/** A map milestone as the db keeps it (a PRD's own carries `prd` and its plan's code). */
type Ms = GmMilestone & { prd?: { id: string; slug: string; title: string }; prd_code?: string };

function ms(id: string, name: string, g: string, iso: string, status: Status, threshold: number | null, prd?: string): Ms {
  const gl = GOALS.find((x) => x.id === g)!;
  const [, m, d] = iso.split("-").map(Number);
  // As the API reads a gate: none set is No gate; a goal not measured leaves it not measured.
  const read: Status = threshold === null ? "no_gate" : gl.current === null ? "not_measured" : status;
  return {
    id, name, goal: g, measure: gl.measure, threshold, unit: gl.unit, current: gl.current, status: read, areas: [], depends: [],
    month: MON[m - 1], due: `${MON[m - 1]} ${d}`, due_on: iso, days: Array.from({ length: 7 }, () => gl.current),
    confirmed: status === "met" ? "Robin Example" : null, confirmed_on: status === "met" ? "Nov 2" : null, proposed: false, can_change: true,
    ...(prd ? { prd: { id: `prd-${id}`, slug: prd.toLowerCase().replace(/[^a-z]+/g, "-"), title: prd }, prd_code: "" } : {}),
  };
}

const MILESTONES: Ms[] = [
  ms("gtm1", "25 demos per rep", "gtdemos", "2026-10-30", "met", 25),
  ms("gtm2", "Card retry live", "gtpayments", "2026-11-13", "on_track", null, "Payments clean-up"),
  ms("gtm3", "20 activations per team", "gtactivations", "2026-11-27", "on_track", 20),
  ms("gtm4", "$15k revenue per day", "gtrevenue", "2026-12-11", "on_track", 15000),
  ms("gtm5", "32 demos per rep", "gtdemos", "2026-12-18", "on_track", 32),
  ms("gtm6", "Under 1 failed payment a day", "gtpayments", "2027-01-08", "at_risk", 1),
  ms("gtm7", "Self-serve setup", "gtactivations", "2027-01-22", "on_track", null, "Setup in a day"),
  ms("gtm8", "Annual plans live", "gtrevenue", "2027-02-05", "at_risk", null, "Annual plans"),
  ms("gtm9", "40 demos per rep", "gtdemos", "2027-02-26", "at_risk", 40),
  ms("gtm10", "$20k revenue per day", "gtrevenue", "2027-03-19", "at_risk", 20000),
];

type State = "shipped" | "nothelping" | "planned";
// [name, track (by its area's short id; null: no track), milestone (null: none), state]
type Row = [name: string, track: string | null, milestone: string | null, state: State];

const ROWS: Record<string, Row[]> = {
  gtdemos: [
    ["One-tap demo booking", "gtscale", "gtm1", "shipped"],
    ["Call queue autopilot", "gtscale", "gtm1", "shipped"],
    ["Rep calendar sync", "gtscale", "gtm5", "nothelping"],
    ["Lead list ranking", "gtscale", "gtm5", "planned"],
    ["No-show reminder texts", "gtactivation", "gtm5", "planned"],
    ["Shared rep notes", "gtaccounts", "gtm9", "planned"],
    ["Demo room in the browser", "gtscale", "gtm9", "planned"],
    ["Rep daily scoreboard", "gtscale", null, "planned"],
  ],
  gtpayments: [
    ["Card retry on day 1, 3 and 7", "gtsafety", "gtm2", "shipped"],
    ["Expired card warning", "gtsafety", "gtm2", "shipped"],
    ["Bank transfer fallback", "gtsafety", "gtm6", "planned"],
    ["Payment status page", "gtaccounts", "gtm6", "nothelping"],
    ["Plain cancel button", "gtaccounts", "gtm6", "planned"],
    ["Fraud check before charge", "gtsafety", null, "planned"],
  ],
  gtactivations: [
    ["Guided first week", "gtactivation", "gtm3", "shipped"],
    ["Team invite at sign-up", "gtactivation", "gtm3", "shipped"],
    ["Setup checklist", "gtactivation", "gtm3", "nothelping"],
    ["Import from spreadsheets", "gtactivation", "gtm7", "planned"],
    ["Welcome call booking", "gtaccounts", "gtm7", "planned"],
    ["Usage nudges", "gtactivation", "gtm7", "planned"],
    ["Sample data to start", "gtscale", "gtm7", "planned"],
    ["Admin setup in 10 minutes", "gtactivation", null, "planned"],
    ["Single sign-on", "gtsafety", null, "planned"],
  ],
  gtrevenue: [
    ["Pricing page test", "gtrevenue-t", "gtm4", "shipped"],
    ["Upgrade at day 20", "gtrevenue-t", "gtm4", "nothelping"],
    ["Price in local money", "gtrevenue-t", "gtm4", "planned"],
    ["Annual plan offer", "gtrevenue-t", "gtm8", "planned"],
    ["Invoice for finance teams", "gtaccounts", "gtm8", "planned"],
    ["Seat-based billing", "gtrevenue-t", "gtm8", "planned"],
    ["Win-back offer", "gtaccounts", "gtm10", "planned"],
    ["Partner referral channel", "gtscale", "gtm10", "planned"],
    ["Usage add-ons", "gtrevenue-t", "gtm10", "planned"],
    ["Renewal reminders", "gtaccounts", null, "planned"],
  ],
};

const LONG = [
  "Call queue autopilot that skips leads already booked by another rep this week",
  "Rep calendar sync with team holidays and shared demo rooms",
  "Lead list ranking by likelihood to book in the next two weeks",
  "No-show reminder texts sent an hour and a day before each demo",
  "Shared rep notes that follow a lead between reps and teams",
  "Demo room in the browser with screen sharing and no install",
  "Rep daily scoreboard on the team's big screen",
  "Territory planner for new reps in their first month",
  "Voice memo notes turned into follow-up tasks",
  "Smart follow-up timer that waits for the lead's local morning",
  "Lead source tags carried from the first ad to the booked demo",
  "Weekend booking desk staffed by two reps on rotation",
  "Rep buddy system pairing each new rep with a senior rep",
  "Quiet hours so no rep calls a lead after 8 PM their time",
  "Do-not-call check before every dial",
  "Booking page in six languages",
  "Demo slot overbooking guard",
  "Auto-reschedule when a rep is out sick",
  "Lead hand-off between day and night shifts",
  "Calendar holds released after 24 hours",
  "Rep coaching clips from the best calls of the week",
  "One inbox for email, text and chat replies",
  "Missed call callback within five minutes",
  "Rep target board with weekly goals by team",
  "Lead deduplication across all sign-up forms",
  "Demo prep sheet built from the lead's company page",
  "Two-click demo booking from the pricing page",
  "Follow-up email templates written by the best reps",
];
const HARD_MS: [string, string, Status, number][] = [
  ["Pilot team on autopilot", "2026-11-06", "met", 26],
  ["28 demos per rep", "2026-11-20", "on_track", 28],
  ["New reps booking in week 1", "2026-12-04", "on_track", 29],
  ["30 demos per rep", "2027-01-15", "on_track", 30],
  ["Weekend desk open", "2027-01-29", "at_risk", 33],
  ["35 demos per rep", "2027-02-12", "at_risk", 35],
  ["Every team on the new booking page", "2027-03-05", "at_risk", 37],
];

/** Each link's expected lift and confidence, by feature and milestone (none: "" and Medium). */
const LIFTS: Record<string, Record<string, [string, "High" | "Medium" | "Low"]>> = {
  "Lead list ranking": { gtm5: ["+2 demos a day", "High"] },
  "No-show reminder texts": { gtm5: ["+1 demo a day", "High"], gtm9: ["+3 demos a day", "Low"] },
};
/** A feature on two milestones of one goal: its first milestone's row, and the other one. */
export const GM_TRACKS_TWO = { name: "No-show reminder texts", also: "gtm9" } as const;

/** Each goal's rows (the hard case's first goal at volume, and the two features with no track). */
function rowsOf(hard: boolean): Record<string, Row[]> {
  const rows: Record<string, Row[]> = Object.fromEntries(Object.entries(ROWS).map(([k, v]) => [k, [...v]]));
  if (!hard) return rows;
  const tracks = ["gtscale", "gtscale", "gtactivation", "gtaccounts", "gtsafety"];
  const places = ["gtm1", "gth0", "gth1", "gth2", "gtm5", "gth3", "gth4", "gth5", "gtm9", "gth6"];
  rows.gtdemos = LONG.slice(0, 28).map((name, i): Row => [name, tracks[(i + Math.floor(i / 10)) % 5], places[i % 10], i < 6 ? "shipped" : i % 7 === 3 ? "nothelping" : "planned"]);
  rows.gtdemos.push(["Rep daily scoreboard on every team's wall screen and on phones", "gtscale", null, "planned"], ["Call recording consent check for every country we call", "gtsafety", null, "planned"]);
  rows.gtpayments.push([GM_TRACKS_NAMES.noTrackPlaced, null, "gtm6", "planned"]);
  rows.gtactivations.push([GM_TRACKS_NAMES.noTrackUnplaced, null, null, "planned"]);
  return rows;
}

/** Every feature in order ("f1", ...), with its goal: the map's and the roadmap's numbering. */
function featureRows(hard: boolean): { id: string; goal: string; row: Row }[] {
  const rows = rowsOf(hard);
  let n = 0;
  return GOALS.flatMap((g) => (rows[g.id] ?? []).map((row) => ({ id: `f${++n}`, goal: g.id, row })));
}

/** The scenarios' guardrail, at risk: broken on three of the last 7 days (a day's value is its breaches). */
export const GM_TRACKS_GUARDRAIL = { name: "Failed payments", rule: "under 2% every day", current: 3, days: [0, 1, 0, 0, 1, 1, 0], held: false };

/** The goal map of the goal-map-tracks scenarios (short ids: goal-map.ts gives them the API's ids).
 * A feature on no milestone is no map feature: the map reads it from the roadmap (unplaced). */
export function tracksMap(hard: boolean, scenario: string | null = null): GoalMap {
  const milestones: Ms[] = MILESTONES.map((m) => ({ ...m, days: [...m.days] }));
  if (hard) HARD_MS.forEach(([name, iso, status, t], i) => milestones.push(ms(`gth${i}`, name, "gtdemos", iso, status, t)));
  const features: GmFeature[] = featureRows(hard).flatMap(({ id, row: [name, area, m, state] }) => {
    if (!m) return [];
    const lift: GmFeature["lift"] = state === "shipped" ? "helping" : state === "nothelping" ? "not_helping" : "not_measured";
    const lever = GM_TRACKS.find((t) => t.area === area)?.lever ?? "";
    const on = name === GM_TRACKS_TWO.name ? [m, GM_TRACKS_TWO.also] : [m];
    const links = on.map((x) => {
      const [expected, confidence] = LIFTS[name]?.[x] ?? ["", "Medium" as const];
      return { milestone: x, expected, confidence, measured: null, lift, shipped_on: state === "planned" ? null : "Oct 20", before: null, after: null };
    });
    return [{ id, name, code: "", area, milestones: on, lever, expected: links[0].expected, confidence: links[0].confidence, released: state !== "planned", measured: null, lift, links }];
  });
  return {
    goals: goalsOf(scenario),
    areas: GM_TRACKS.map((t) => ({ id: t.area, name: t.title, lever: t.lever })),
    guardrail: { ...GM_TRACKS_GUARDRAIL, days: [...GM_TRACKS_GUARDRAIL.days] },
    milestones: milestones as GmMilestone[],
    features,
    gaps: [],
    unplaced: [],
    off_map: [],
    today: "Nov 10",
    today_on: GM_TRACKS_NAMES.today,
    reps: 12,
    approver: "Robin Example",
    can_edit: true,
    places: [],
  };
}

/** The scenario's goals as Baseline goals (and goal buckets): the map's own ids through `idOf`. */
export function tracksGoals(idOf: (k: string) => string, scenario: string | null = null): { id: string; key: string; title: string; status: "confirmed"; parent_id: null; attrs: Record<string, unknown> }[] {
  return goalsOf(scenario).map((g, n) => ({
    id: idOf(g.id), key: `g.${g.id}`, title: g.name, status: "confirmed" as const, parent_id: null,
    attrs: { metric: g.measure, target: g.target, unit: g.unit, math: g.math, position: n + 1 },
  }));
}

/**
 * Each feature as its Simple roadmap item: key ("gm-f1", the map feature's), title, code's section
 * (f-201: F-201), status, its track's key (none: no track) and its goal (short id), its own as the API's
 * item goal: a feature taken off its last milestone stays under it (unplaced).
 */
export function tracksItems(hard: boolean): { key: string; title: string; section: string; status: "done" | "planned"; track?: string; goal: string }[] {
  return featureRows(hard).map(({ id, goal, row: [title, area, , state] }) => {
    const track = GM_TRACKS.find((t) => t.area === area)?.key;
    return {
      key: `gm-${id}`, title, section: `f-${200 + Number(id.slice(1))}`, status: state === "planned" ? ("planned" as const) : ("done" as const),
      ...(track ? { track } : {}),
      goal,
    };
  });
}
