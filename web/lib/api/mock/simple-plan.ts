/**
 * The plan-model lane: a PRD's plan as data (GET /v1/simple/prds/{prd}/plan and POST
 * .../plan/read-again, as api/oracle/simple serves them), in the mock's "simple-plan"
 * scenario: Guided setup's three dated milestones, its features' slices (one per milestone a
 * feature spans), the four goals' targets per milestone, the engineer-weeks per goal and a
 * year-end break. Invented data: no company or customer names.
 *
 * The numbers add up: each milestone's planned weeks (its slices' engineer-weeks) stay within
 * its capacity, and each milestone's goal weeks (every slice counted once, under its goal)
 * sum to its planned weeks. PM-owned work carries no engineer-weeks.
 */
import type { Schemas } from "@/lib/api/client";

type Slice = Schemas["SimpleSlice"];
type PlanOut = Schemas["SimplePlanOut"];
type Role = Schemas["Me"]["role"];

/** The PRD the plan belongs to (the mock's Guided setup, whose roadmap is onboarding-roadmap). */
export const PLAN_PRD_SLUG = "guided-setup";

const DAY = 86_400_000;
const ms = (day: string): number => Date.parse(`${day}T00:00:00Z`);
const iso = (t: number): string => new Date(t).toISOString().slice(0, 10);
const addDays = (day: string, n: number): string => iso(ms(day) + n * DAY);
const minOf = (xs: string[]) => xs.reduce((a, b) => (b < a ? b : a));
const maxOf = (xs: string[]) => xs.reduce((a, b) => (b > a ? b : a));

type Milestone = { code: string; name: string; start: string; end: string; capacity: number; done_when: string[] };
const MILESTONES: Milestone[] = [
  { code: "M1", name: "Prove it", start: "2026-11-02", end: "2026-11-27", capacity: 16, done_when: ["Ten pilot teams finish setup in a day", "Setup errors are alerted within five minutes"] },
  { code: "M2", name: "Scale volume", start: "2026-11-30", end: "2026-12-25", capacity: 16, done_when: ["Bulk import handles 10,000 rows", "Invites come back from 40% of new admins"] },
  { code: "M3", name: "Open to all", start: "2026-12-28", end: "2027-02-12", capacity: 24, done_when: ["Anyone can sign up without a sales call", "Annual billing is live"] },
];

const HOLIDAYS = [{ start: "2026-12-28", end: "2027-01-01", label: "Year-end break" }];

const GOALS: { name: string; targets: [string, string][] }[] = [
  { name: "Reliability", targets: [["M1", "99.5% setup success"], ["M2", "99.7% setup success"], ["M3", "99.9% setup success"]] },
  { name: "Growth", targets: [["M1", "100 weekly active teams"], ["M2", "250 weekly active teams"], ["M3", "600 weekly active teams"]] },
  { name: "Activation", targets: [["M1", "50% finish setup in a day"], ["M2", "60% finish setup in a day"], ["M3", "65% finish setup in a day"]] },
  { name: "Revenue", targets: [["M1", "$0 (no paid plan yet)"], ["M2", "$5,000 monthly recurring revenue"], ["M3", "$20,000 monthly recurring revenue"]] },
];

/** [feature code, plain name, goal, then per milestone: [milestone, engineer-weeks (null: PM-owned), week offset in it]]. */
type Feature = [string, string, string, [string, number | null, number][]];
const FEATURES: Feature[] = [
  ["F-01", "Setup checklist", "Activation", [["M1", 3, 0]]],
  ["F-02", "Sample data import", "Activation", [["M1", 3, 1]]],
  ["F-03", "Setup failure alerts", "Reliability", [["M1", 2, 0]]],
  ["F-04", "Pricing page words", "Revenue", [["M1", null, 2]]],
  ["F-05", "Team invites", "Growth", [["M1", 3, 1], ["M2", 2, 0]]],
  ["F-06", "Setup error report", "Reliability", [["M1", 2, 2]]],
  ["F-07", "Bulk import", "Activation", [["M2", 3, 0]]],
  ["F-08", "Usage dashboard", "Growth", [["M2", 3, 1]]],
  ["F-09", "Retry queue", "Reliability", [["M2", 3, 0]]],
  ["F-10", "Launch email", "Growth", [["M2", null, 3]]],
  ["F-11", "Self-serve checkout", "Revenue", [["M2", 2, 2], ["M3", 3, 0]]],
  ["F-12", "Referral link", "Growth", [["M2", 2, 2], ["M3", 2, 1]]],
  ["F-13", "Public signup", "Growth", [["M3", 4, 0]]],
  ["F-14", "Plan limits", "Revenue", [["M3", 3, 2]]],
  ["F-15", "Status page", "Reliability", [["M3", 2, 0]]],
  ["F-16", "Onboarding emails", "Activation", [["M3", 2, 3]]],
  ["F-17", "Annual billing", "Revenue", [["M3", 3, 3]]],
  ["F-18", "Pricing questions page", "Revenue", [["M3", null, 4]]],
  ["F-19", "Load test", "Reliability", [["M3", 2, 4]]],
  ["F-20", "Help center search", "Activation", [["M3", 2, 4]]],
];

const inHoliday = (day: string) => HOLIDAYS.some((h) => day >= h.start && day <= h.end);

/** A slice placed inside its milestone (Oracle estimates it): a Monday start, its weeks long. */
function placed(m: Milestone, weeks: number | null, offset: number): { start: string; end: string } {
  let start = addDays(m.start, offset * 7);
  while (inHoliday(start)) start = addDays(start, 7);
  const end = addDays(start, Math.max(1, weeks ?? 1) * 7 - 3);
  return { start: start > m.end ? m.end : start, end: end > m.end ? m.end : end };
}

export const planSlices = (): Slice[] =>
  FEATURES.flatMap(([code, name, goal, parts]) =>
    parts.map(([mc, weeks, offset], k) => {
      const m = MILESTONES.find((x) => x.code === mc)!;
      const at = placed(m, weeks, offset);
      return {
        code: parts.length > 1 ? `${code}${"abcdefgh"[k]}` : code,
        feature_code: code,
        name,
        milestone: m.code,
        milestone_name: m.name,
        milestone_start: m.start,
        milestone_end: m.end,
        start_date: at.start,
        end_date: at.end,
        estimated: true,
        effort_weeks: weeks,
        goal,
        pm_owned: weeks === null,
      };
    }),
  );

/** "2 Nov - 12 Feb" (the plan's span, as the API labels it). */
const dayMonth = (day: string) => new Date(ms(day)).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
export const planSpan = (): Schemas["SimplePlanSpan"] => {
  const start = minOf(MILESTONES.map((m) => m.start));
  const end = maxOf(MILESTONES.map((m) => m.end));
  return { start, end, label: `${dayMonth(start)} - ${dayMonth(end)}` };
};

/** The roadmap's milestone fields for one plan milestone (SimpleMilestone's new ones). */
export const planMilestones = () =>
  MILESTONES.map((m) => ({
    code: m.code,
    name: m.name,
    start_date: m.start,
    end_date: m.end,
    effort_weeks: m.capacity,
    done_when: [...m.done_when],
    targets: GOALS.flatMap((g) => g.targets.filter(([c]) => c === m.code).map(([, target]) => ({ goal: g.name, target }))),
  }));

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

export interface PlanDb {
  /** When the PRD's plan was last read (ISO time). */
  read_at: string;
  version: number;
  /** roadmap-gantt ("simple-plan-two"): other PRDs whose items carry this plan's slices too. */
  prds?: string[];
  /** roadmap-gantt: PRDs whose plan the reader cannot open (404, as for a PRD they cannot read). */
  hidden?: string[];
}

export const seedPlan = (): PlanDb => ({ read_at: "2026-10-20T15:05:00Z", version: 3 });

export function planOut(plan: PlanDb | undefined, prd: Schemas["SimpleDocRef"], role: Role): PlanOut {
  const can = role === "owner";
  if (!plan) {
    return { prd, version: null, status: "none", source: null, dated: false, message: "This PRD has no plan yet.", milestones: [], slices: [], goals: [], goal_weeks: [], span: null, holidays: [], can_read_again: can, read_at: null };
  }
  const slices = planSlices();
  const weeks = new Map<string, number>();
  for (const s of slices) {
    if (s.effort_weeks == null || !s.goal) continue;
    const k = `${s.goal}|${s.milestone}`;
    weeks.set(k, (weeks.get(k) ?? 0) + s.effort_weeks);
  }
  return {
    prd,
    version: plan.version,
    status: "ready",
    source: "prd",
    dated: true,
    message: null,
    milestones: planMilestones().map((m) => ({
      ...m,
      planned_weeks: slices.filter((s) => s.milestone === m.code).reduce((n, s) => n + (s.effort_weeks ?? 0), 0),
      feature_codes: [...new Set(slices.filter((s) => s.milestone === m.code).map((s) => s.feature_code))],
      source: "prd" as const,
    })),
    slices,
    goals: GOALS.map((g) => ({ name: g.name, targets: g.targets.map(([milestone, target]) => ({ milestone, target })) })),
    goal_weeks: GOALS.flatMap((g) => MILESTONES.flatMap((m) => {
      const w = weeks.get(`${g.name}|${m.code}`);
      return w ? [{ goal: g.name, milestone: m.code, weeks: w }] : [];
    })),
    span: planSpan(),
    holidays: HOLIDAYS.map((h) => ({ ...h })),
    can_read_again: can,
    read_at: plan.read_at,
  };
}

/**
 * GET /v1/simple/prds/{prd}/plan and POST .../plan/read-again (owners only; others 403).
 * `prdOf` names the PRD a slug or id is (null: no such PRD); the plan is the plan PRD's only.
 */
export function routeSimplePlan(
  plan: PlanDb | undefined,
  role: Role,
  prdOf: (ref: string) => Schemas["SimpleDocRef"] | null,
  req: Request,
  p: string[],
): Response | null {
  if (p[1] !== "simple" || p[2] !== "prds" || !p[3] || p[4] !== "plan") return null;
  if (plan?.hidden?.includes(p[3])) return json(404, { detail: "No such PRD" });
  const prd = prdOf(p[3]);
  if (!prd) return json(404, { detail: "No such PRD" });
  const mine = prd.slug === PLAN_PRD_SLUG ? plan : undefined;
  if (!p[5] && req.method === "GET") return json(200, planOut(mine, prd, role));
  if (p[5] === "read-again" && !p[6] && req.method === "POST") {
    if (role !== "owner") return json(403, { detail: "Only an owner reads the plan again" });
    if (mine) mine.read_at = new Date().toISOString();
    return json(200, planOut(mine, prd, role));
  }
  return null;
}
