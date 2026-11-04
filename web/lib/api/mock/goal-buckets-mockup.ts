// MOCK-HOOK: the whole file. Invented data for the goal-bucket editing mock-ups (mk-goalbuckets,
// decisions GB1..GB3): an invented e-bike subscription company, its goals, features and milestones.

export type MkMilestone = { code: string; name: string; start: string; end: string }; // MOCK-HOOK
export type MkGoal = { id: string; order: number; title: string; measure: string; target: string; by: string }; // MOCK-HOOK
/** `goals`: the goals it serves, the one it moves most first. */
export type MkFeature = { code: string; name: string; weeks: number; ms: string[]; goals: string[] }; // MOCK-HOOK

export const MK_MILESTONES: MkMilestone[] = [ // MOCK-HOOK
  { code: "M1", name: "Ride ready", start: "2026-11-02", end: "2026-11-27" },
  { code: "M2", name: "Fleet care", start: "2026-11-30", end: "2026-12-23" },
  { code: "M3", name: "Winter launch", start: "2027-01-04", end: "2027-02-12" },
];

const BASE_GOALS: MkGoal[] = [ // MOCK-HOOK
  { id: "g1", order: 1, title: "Faster first ride", measure: "Days from sign-up to first ride", target: "3 days", by: "2026-12-31" },
  { id: "g2", order: 2, title: "Fewer bikes in repair", measure: "Bikes out of service", target: "Under 4%", by: "2027-02-12" },
  { id: "g3", order: 3, title: "More riders keep riding", measure: "Riders still subscribed after 90 days", target: "70%", by: "2027-02-26" },
  { id: "g4", order: 4, title: "Grow shop partners", measure: "Partner bike shops live", target: "40 shops", by: "2027-03-31" },
  { id: "g5", order: 5, title: "Lower support load", measure: "Support chats per 100 riders a month", target: "8", by: "2027-01-29" },
];

const HARD_GOALS: MkGoal[] = [ // MOCK-HOOK
  {
    id: "g6",
    order: 6,
    title: "Win riders in two new cities, starting with Porto and then Valencia, before the spring riding season begins",
    measure: "Paying riders in the new cities",
    target: "1,200 riders",
    by: "2027-03-19",
  },
  { id: "g7", order: 7, title: "Safer night rides", measure: "Night-ride incidents per 10,000 rides", target: "Under 2", by: "2027-02-26" },
  { id: "g8", order: 8, title: "Cut bike delivery cost", measure: "Cost to deliver one bike", target: "€18", by: "2027-01-29" },
];

const BASE_FEATURES: MkFeature[] = [ // MOCK-HOOK
  { code: "F-1", name: "Same-day bike delivery slots", weeks: 4, ms: ["M1"], goals: ["g1"] },
  { code: "F-2", name: "Sign-up in three steps", weeks: 3, ms: ["M1"], goals: ["g1", "g3"] },
  { code: "F-3", name: "Pick-up from a partner shop", weeks: 5, ms: ["M1", "M2"], goals: ["g1", "g4"] },
  { code: "F-4", name: "Repair booking from the app", weeks: 4, ms: ["M2"], goals: ["g2"] },
  { code: "F-5", name: "Battery health alerts", weeks: 3, ms: ["M2"], goals: ["g2", "g5"] },
  { code: "F-6", name: "Spare-parts stock view", weeks: 2, ms: ["M2"], goals: ["g2"] },
  { code: "F-7", name: "Pause your plan for winter", weeks: 3, ms: ["M3"], goals: ["g3"] },
  { code: "F-8", name: "Ride streaks and badges", weeks: 2.5, ms: ["M3"], goals: ["g3"] },
  { code: "F-9", name: "Shop partner sign-up", weeks: 4, ms: ["M2"], goals: ["g4"] },
  { code: "F-10", name: "Shop payouts each week", weeks: 3, ms: ["M3"], goals: ["g4"] },
  { code: "F-11", name: "Answers in the help screen", weeks: 2, ms: ["M1"], goals: ["g5"] },
  { code: "F-12", name: "Chat hand-off to a shop", weeks: 3, ms: ["M3"], goals: ["g5", "g4"] },
];

/** The hard case: "Grow shop partners" holds 15 features over two milestones (M2, M3); three more goals. */
const HARD_EXTRA: MkFeature[] = [ // MOCK-HOOK
  { code: "F-13", name: "Shop map in the app", weeks: 2, ms: ["M2"], goals: ["g4"] },
  { code: "F-14", name: "Shop opening hours sync", weeks: 1.5, ms: ["M2"], goals: ["g4"] },
  { code: "F-15", name: "Shop stock of spare bikes", weeks: 3, ms: ["M2"], goals: ["g4", "g2"] },
  { code: "F-16", name: "Shop reviews by riders", weeks: 2, ms: ["M3"], goals: ["g4", "g3"] },
  { code: "F-17", name: "Shop staff accounts", weeks: 2.5, ms: ["M2"], goals: ["g4"] },
  { code: "F-18", name: "Shop repair price list", weeks: 1.5, ms: ["M3"], goals: ["g4"] },
  { code: "F-19", name: "Shop pick-up reminders", weeks: 1, ms: ["M3"], goals: ["g4", "g1"] },
  { code: "F-20", name: "Shop monthly report", weeks: 2, ms: ["M3"], goals: ["g4"] },
  { code: "F-21", name: "Shop contract e-sign", weeks: 2, ms: ["M2"], goals: ["g4"] },
  { code: "F-22", name: "Shop referral bonus", weeks: 1.5, ms: ["M3"], goals: ["g4"] },
  { code: "F-23", name: "Shop parts ordering", weeks: 3, ms: ["M3"], goals: ["g4", "g2"] },
  { code: "F-24", name: "Shop holiday closures", weeks: 1, ms: ["M3"], goals: ["g4"] },
  { code: "F-31", name: "Shop loyalty card", weeks: 2, ms: ["M3"], goals: ["g4"] },
  { code: "F-25", name: "Porto launch page", weeks: 2, ms: ["M3"], goals: ["g6"] },
  { code: "F-26", name: "Prices in more currencies", weeks: 2.5, ms: ["M3"], goals: ["g6"] },
  { code: "F-27", name: "Bike lights check at hand-over", weeks: 2, ms: ["M2"], goals: ["g7"] },
  { code: "F-28", name: "Night route tips", weeks: 1.5, ms: ["M3"], goals: ["g7", "g3"] },
  { code: "F-29", name: "Delivery van routes", weeks: 3, ms: ["M2"], goals: ["g8"] },
  { code: "F-30", name: "Bundle deliveries by street", weeks: 2, ms: ["M3"], goals: ["g8", "g1"] },
];

/** The goals and features one mock-up frame starts from. */
export function mkGoalBuckets(hard: boolean): { goals: MkGoal[]; features: MkFeature[] } { // MOCK-HOOK
  return hard
    ? { goals: [...BASE_GOALS, ...HARD_GOALS], features: [...BASE_FEATURES, ...HARD_EXTRA] }
    : { goals: BASE_GOALS.map((g) => ({ ...g })), features: BASE_FEATURES.map((f) => ({ ...f })) };
}
