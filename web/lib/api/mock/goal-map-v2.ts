// MOCK-HOOK (whole file): goal-map-v2 mock-ups only. Invented example data for the four Goal map
// proposals (?gm=a|b|c|d): 4 goals, 5 tracks, milestones by date, features per goal.
import type { GoalMap, GmFeature, GmGoal, GmMilestone, GmStatus } from "./goal-map";

export const GM_V2_SCENARIO = "goal-map-v2";
export const GM_V2_HARD_SCENARIO = "goal-map-v2-hard";

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function goal(id: string, name: string, measure: string, target: number, current: number, unit: string, status: GmStatus, krs: string): GmGoal {
  return {
    id,
    name,
    measure,
    target,
    current,
    unit,
    status,
    math: krs,
    builds_on: [],
    history: [{ date: "Oct 1, 2026", text: `Goal set at ${unit === "$" ? `$${target / 1000}k` : target}`, by: "Robin Example" }],
    metric: { id: `metric-${id}`, title: measure },
    missing: null,
    choices: [],
    read_on: "Nov 10",
  };
}

const GOALS: GmGoal[] = [
  goal("v2demos", "Booked demos per rep per day", "booked demos per rep per day", 40, 31, "", "on_track", "Key results: 60% of calls reach a decision maker · 8 open demo slots per rep each day"),
  goal("v2payments", "Failed payments per day", "failed payments per day", 0, 3, "", "at_risk", "Key results: card retries recover 90% · no payment stuck over 1 hour"),
  goal("v2activations", "Activations per team per week", "activations per team per week", 30, 18, "", "at_risk", "Key results: setup done in 1 day · 70% of invited people sign in"),
  goal("v2revenue", "Revenue per day", "revenue per day", 20000, 13400, "$", "on_track", "Key results: 25% pick the annual plan · upgrades at day 20 reach 12%"),
];

const AREAS = [
  { id: "v2scale", name: "Scale", lever: "Reach" },
  { id: "v2safety", name: "Safety", lever: "Failed payments" },
  { id: "v2activation", name: "Activation", lever: "Activations" },
  { id: "v2revenue-t", name: "Revenue", lever: "Value per account" },
  { id: "v2accounts", name: "Account Management", lever: "Kept accounts" },
];

type Ms = GmMilestone & { prd?: { id: string; slug: string; title: string }; prd_code?: string };

function ms(id: string, name: string, g: string, iso: string, status: GmStatus, threshold: number | null, prd?: string): Ms {
  const gl = GOALS.find((x) => x.id === g)!;
  const [, m, d] = iso.split("-").map(Number);
  const out: Ms = {
    id,
    name,
    goal: g,
    measure: gl.measure,
    threshold,
    unit: gl.unit,
    current: gl.current,
    status,
    areas: [],
    depends: [],
    month: MON[m - 1],
    due: `${MON[m - 1]} ${d}`,
    due_on: iso,
    days: Array.from({ length: 7 }, () => gl.current),
    confirmed: status === "met" ? "Robin Example" : null,
    confirmed_on: status === "met" ? "Nov 2" : null,
    proposed: false,
    can_change: true,
  };
  if (prd) {
    out.prd = { id: `prd-${id}`, slug: prd.toLowerCase().replace(/[^a-z]+/g, "-"), title: prd };
    out.prd_code = "";
  }
  return out;
}

const MILESTONES: Ms[] = [
  ms("v2m1", "25 demos per rep", "v2demos", "2026-10-30", "met", 25),
  ms("v2m2", "Card retry live", "v2payments", "2026-11-13", "on_track", null, "Payments clean-up"),
  ms("v2m3", "20 activations per team", "v2activations", "2026-11-27", "on_track", 20),
  ms("v2m4", "$15k revenue per day", "v2revenue", "2026-12-11", "on_track", 15000),
  ms("v2m5", "32 demos per rep", "v2demos", "2026-12-18", "on_track", 32),
  ms("v2m6", "Under 1 failed payment a day", "v2payments", "2027-01-08", "at_risk", 1),
  ms("v2m7", "Self-serve setup", "v2activations", "2027-01-22", "on_track", null, "Setup in a day"),
  ms("v2m8", "Annual plans live", "v2revenue", "2027-02-05", "at_risk", null, "Annual plans"),
  ms("v2m9", "40 demos per rep", "v2demos", "2027-02-26", "at_risk", 40),
  ms("v2m10", "$20k revenue per day", "v2revenue", "2027-03-19", "at_risk", 20000),
];

type F = GmFeature & { goal?: string };
type Row = [name: string, track: string, milestone: string | null, state: "shipped" | "nothelping" | "planned"];

const ROWS: Record<string, Row[]> = {
  v2demos: [
    ["One-tap demo booking", "v2scale", "v2m1", "shipped"],
    ["Call queue autopilot", "v2scale", "v2m1", "shipped"],
    ["Rep calendar sync", "v2scale", "v2m5", "nothelping"],
    ["Lead list ranking", "v2scale", "v2m5", "planned"],
    ["No-show reminder texts", "v2activation", "v2m5", "planned"],
    ["Shared rep notes", "v2accounts", "v2m9", "planned"],
    ["Demo room in the browser", "v2scale", "v2m9", "planned"],
    ["Rep daily scoreboard", "v2scale", null, "planned"],
  ],
  v2payments: [
    ["Card retry on day 1, 3 and 7", "v2safety", "v2m2", "shipped"],
    ["Expired card warning", "v2safety", "v2m2", "shipped"],
    ["Bank transfer fallback", "v2safety", "v2m6", "planned"],
    ["Payment status page", "v2accounts", "v2m6", "nothelping"],
    ["Plain cancel button", "v2accounts", "v2m6", "planned"],
    ["Fraud check before charge", "v2safety", null, "planned"],
  ],
  v2activations: [
    ["Guided first week", "v2activation", "v2m3", "shipped"],
    ["Team invite at sign-up", "v2activation", "v2m3", "shipped"],
    ["Setup checklist", "v2activation", "v2m3", "nothelping"],
    ["Import from spreadsheets", "v2activation", "v2m7", "planned"],
    ["Welcome call booking", "v2accounts", "v2m7", "planned"],
    ["Usage nudges", "v2activation", "v2m7", "planned"],
    ["Sample data to start", "v2scale", "v2m7", "planned"],
    ["Admin setup in 10 minutes", "v2activation", null, "planned"],
    ["Single sign-on", "v2safety", null, "planned"],
  ],
  v2revenue: [
    ["Pricing page test", "v2revenue-t", "v2m4", "shipped"],
    ["Upgrade at day 20", "v2revenue-t", "v2m4", "nothelping"],
    ["Price in local money", "v2revenue-t", "v2m4", "planned"],
    ["Annual plan offer", "v2revenue-t", "v2m8", "planned"],
    ["Invoice for finance teams", "v2accounts", "v2m8", "planned"],
    ["Seat-based billing", "v2revenue-t", "v2m8", "planned"],
    ["Win-back offer", "v2accounts", "v2m10", "planned"],
    ["Partner referral channel", "v2scale", "v2m10", "planned"],
    ["Usage add-ons", "v2revenue-t", "v2m10", "planned"],
    ["Renewal reminders", "v2accounts", null, "planned"],
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
const HARD_MS: [string, string, GmStatus, number][] = [
  ["Pilot team on autopilot", "2026-11-06", "met", 26],
  ["28 demos per rep", "2026-11-20", "on_track", 28],
  ["New reps booking in week 1", "2026-12-04", "on_track", 29],
  ["30 demos per rep", "2027-01-15", "on_track", 30],
  ["Weekend desk open", "2027-01-29", "at_risk", 33],
  ["35 demos per rep", "2027-02-12", "at_risk", 35],
  ["Every team on the new booking page", "2027-03-05", "at_risk", 37],
];

function feature(id: string, row: Row, g: string): F {
  const [name, area, m, state] = row;
  const lift = state === "shipped" ? "helping" : state === "nothelping" ? "not_helping" : "not_measured";
  return {
    id,
    name,
    code: "",
    area,
    milestones: m ? [m] : [],
    lever: "",
    expected: "",
    confidence: "Medium",
    released: state !== "planned",
    measured: null,
    lift,
    links: m ? [{ milestone: m, expected: "", confidence: "Medium", measured: null, lift, shipped_on: state === "planned" ? null : "Oct 20", before: null, after: null }] : [],
    goal: g,
  };
}

/** The goal map for the goal-map-v2 scenarios (short ids; the caller gives them the API's ids). */
export function goalMapV2(hard: boolean): GoalMap {
  const goals = GOALS.map((g) => ({ ...g, history: [...g.history] }));
  const milestones: Ms[] = MILESTONES.map((m) => ({ ...m, days: [...m.days] }));
  const rows: Record<string, Row[]> = Object.fromEntries(Object.entries(ROWS).map(([k, v]) => [k, [...v]]));
  if (hard) {
    HARD_MS.forEach(([name, iso, status, t], i) => milestones.push(ms(`v2h${i}`, name, "v2demos", iso, status, t)));
    const tracks = ["v2scale", "v2scale", "v2activation", "v2accounts", "v2safety"];
    const places = ["v2m1", "v2h0", "v2h1", "v2h2", "v2m5", "v2h3", "v2h4", "v2h5", "v2m9", "v2h6"];
    rows.v2demos = LONG.slice(0, 28).map((name, i): Row => [name, tracks[(i + Math.floor(i / 10)) % 5], places[i % 10], i < 6 ? "shipped" : i % 7 === 3 ? "nothelping" : "planned"]);
    rows.v2demos.push(["Rep daily scoreboard on every team's wall screen and on phones", "v2scale", null, "planned"], ["Call recording consent check for every country we call", "v2safety", null, "planned"]);
  }
  let n = 0;
  const features: F[] = [];
  for (const g of goals) for (const r of rows[g.id] ?? []) features.push(feature(`f${++n}`, r, g.id));
  return {
    goals,
    areas: AREAS,
    guardrail: null,
    milestones,
    features,
    gaps: [],
    unplaced: [],
    off_map: [],
    today: "Nov 10",
    today_on: "2026-11-10",
    reps: 12,
    approver: "Robin Example",
    can_edit: true,
    places: [],
  } as GoalMap;
}
