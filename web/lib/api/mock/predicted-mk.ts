// MOCK-HOOK file: every line here is mock-up data for mk-predicted (planned vs predicted dates), never merged.
// Invented goals' planned and predicted dates, by goal name as the mock Goal map names them.

export type PmFeature = { code: string; name: string; end: string | null; ms: string }; // MOCK-HOOK
export type PmMilestone = { code: string; name: string; planned: string; predicted: string | null; driver: string | null }; // MOCK-HOOK
export type PmGoal = {
  planned: string;
  predicted: string | null;
  driver: string | null; // feature name that sets the predicted date
  dated: number; // features with an end date
  total: number;
  slipRate: number; // how many days past plan the team's past features ended, on average (outcome records)
  history: { week: string; predicted: string | null }[];
  milestones: PmMilestone[];
  features: PmFeature[];
}; // MOCK-HOOK

const weeks = ['2026-10-06', '2026-10-13', '2026-10-20', '2026-10-27', '2026-11-03', '2026-11-10', '2026-11-17', '2026-11-24'];
const hist = (xs: (string | null)[]) => weeks.map((week, i) => ({ week, predicted: xs[i] }));

const small: Record<string, PmGoal> = {
  'Sign-ups per rep per day': {
    planned: '2026-11-30',
    predicted: '2026-11-26',
    driver: 'Lead list ranking',
    dated: 4,
    total: 4,
    slipRate: 2,
    history: hist(['2026-11-30', '2026-12-03', '2026-12-03', '2026-11-30', '2026-11-28', '2026-11-28', '2026-11-26', '2026-11-26']),
    milestones: [
      { code: 'M1', name: '25 sign-ups per rep', planned: '2026-10-31', predicted: '2026-10-29', driver: 'One-tap sign-up link' },
      { code: 'M3', name: '50 sign-ups per rep', planned: '2026-11-30', predicted: '2026-11-26', driver: 'Lead list ranking' },
    ],
    features: [
      { code: 'F-109', name: 'Guided first week', end: '2026-11-20', ms: 'M3' },
      { code: 'F-103', name: 'Lead list ranking', end: '2026-11-26', ms: 'M3' },
      { code: 'F-101', name: 'One-tap sign-up link', end: '2026-10-29', ms: 'M1' },
      { code: 'F-102', name: 'Rep call script hints', end: '2026-11-18', ms: 'M3' },
    ],
  },
  'Paid conversions per rep per day': {
    planned: '2026-12-31',
    predicted: '2027-01-12',
    driver: 'Partner referral channel',
    dated: 4,
    total: 5,
    slipRate: 6,
    history: hist(['2026-12-31', '2026-12-31', '2026-12-29', '2027-01-04', '2027-01-04', '2027-01-08', '2027-01-12', '2027-01-12']),
    milestones: [
      { code: 'M2', name: '3 paid conversions per rep', planned: '2026-10-31', predicted: '2026-10-30', driver: 'Trial reminder texts' },
      { code: 'M4', name: '6 paid conversions per rep', planned: '2026-11-30', predicted: '2026-12-09', driver: 'Pricing page test' },
      { code: 'M7', name: '10 paid conversions per rep', planned: '2026-12-31', predicted: '2027-01-12', driver: 'Partner referral channel' },
    ],
    features: [
      { code: 'F-104', name: 'Complaint early warning', end: '2026-11-21', ms: 'M4' },
      { code: 'F-107', name: 'Partner referral channel', end: '2027-01-12', ms: 'M7' },
      { code: 'F-108', name: 'Pricing page test', end: '2026-12-09', ms: 'M4' },
      { code: 'F-105', name: 'Refund in one step', end: null, ms: 'M4' },
      { code: 'F-106', name: 'Trial reminder texts', end: '2026-10-30', ms: 'M2' },
    ],
  },
  'Revenue per day': {
    planned: '2027-01-31',
    predicted: null,
    driver: null,
    dated: 1,
    total: 4,
    slipRate: 6,
    history: hist([null, null, null, null, null, null, null, null]),
    milestones: [
      { code: 'M5', name: '$12k revenue per day', planned: '2026-11-30', predicted: '2026-11-30', driver: 'Annual plan offer' },
      { code: 'M8', name: '$20k revenue per day', planned: '2027-01-31', predicted: null, driver: null },
    ],
    features: [
      { code: 'F-110', name: 'Annual plan offer', end: '2026-11-30', ms: 'M5' },
      { code: 'F-109', name: 'Guided first week', end: null, ms: 'M5' },
      { code: 'F-112', name: 'Rep daily scoreboard', end: null, ms: 'M8' },
      { code: 'F-111', name: 'Team invite at sign-up', end: null, ms: 'M8' },
    ],
  },
};

// The hard case: one goal with twenty features and four milestones, long names.
const BIG_NAMES = [
  'Pricing page test', 'Partner referral channel', 'Complaint early warning', 'Refund in one step', 'Trial reminder texts',
  'Checkout that remembers a half-filled card and the plan picked before', 'Annual plan nudge', 'Seat count picker',
  'Invoice in the buyer’s own currency', 'Cancel survey', 'Upgrade prompt after the third alert', 'Win-back email series',
  'Plan compare table', 'Coupon at checkout', 'Sales-assisted trial for teams over fifty seats', 'Usage receipt',
  'Card retry schedule', 'Self-serve plan change', 'Quote builder', 'Paid trial extension',
];
const BIG_ENDS = [
  '2026-12-09', '2027-01-12', '2026-11-21', null, '2026-10-30', '2027-02-27', '2026-12-18', '2026-12-02',
  '2027-01-20', '2026-11-28', '2027-03-06', '2026-12-30', '2026-11-25', '2026-12-12', '2027-03-09', null,
  '2027-01-08', '2027-02-10', '2027-02-19', '2026-12-22',
];
const BIG_MS = ['M4', 'M7', 'M4', 'M4', 'M2', 'M9', 'M7', 'M4', 'M7', 'M4', 'M9', 'M7', 'M4', 'M7', 'M9', 'M9', 'M7', 'M9', 'M9', 'M7'];
const big: PmGoal = {
  ...small['Paid conversions per rep per day'],
  predicted: '2027-03-09',
  driver: 'Sales-assisted trial for teams over fifty seats',
  dated: 18,
  total: 20,
  history: hist(['2027-02-28', '2027-02-28', '2027-03-02', '2027-03-02', '2027-03-04', '2027-03-06', '2027-03-09', '2027-03-09']),
  planned: '2027-02-28',
  milestones: [
    { code: 'M2', name: '3 paid conversions per rep', planned: '2026-10-31', predicted: '2026-10-30', driver: 'Trial reminder texts' },
    { code: 'M4', name: '6 paid conversions per rep', planned: '2026-11-30', predicted: '2026-12-09', driver: 'Pricing page test' },
    { code: 'M7', name: '10 paid conversions per rep', planned: '2026-12-31', predicted: '2027-01-20', driver: 'Invoice in the buyer’s own currency' },
    { code: 'M9', name: '12 paid conversions per rep in every region and on every plan', planned: '2027-02-28', predicted: '2027-03-09', driver: 'Sales-assisted trial for teams over fifty seats' },
  ],
  features: BIG_NAMES.map((name, i) => ({ code: ['F-108', 'F-107', 'F-104', 'F-105', 'F-106'][i] ?? `F-${115 + i}`, name, end: BIG_ENDS[i], ms: BIG_MS[i] })),
};

/** A goal's planned and predicted dates; `big` turns the paid conversions goal into the hard case. */
export function predictedFor(goal: string, isBig: boolean): PmGoal | null { // MOCK-HOOK
  if (isBig && goal === 'Paid conversions per rep per day') return big; // MOCK-HOOK
  return small[goal] ?? null; // MOCK-HOOK
} // MOCK-HOOK

/** A feature's end date as the mock-up's goals read it (the panel shows the same). */
export function mkEnd(name: string, isBig: boolean): string | null { // MOCK-HOOK
  for (const g of [...(isBig ? [big] : []), ...Object.values(small)]) { // MOCK-HOOK
    const f = g.features.find((x) => x.name === name && x.end); // MOCK-HOOK
    if (f) return f.end; // MOCK-HOOK
  } // MOCK-HOOK
  return null; // MOCK-HOOK
} // MOCK-HOOK

/** With an mk-predicted switch on: the milestone code a feature's end date sets (F-107: M7), else null. */
export function mkMilestoneOf(name: string): string | null { // MOCK-HOOK
  if (typeof window === 'undefined' || !/[?&](pc1|pc2|pc3)=/.test(window.location.search)) return null; // MOCK-HOOK
  const isBig = /mkdata=big|pc3=/.test(window.location.search); // MOCK-HOOK
  for (const g of [...(isBig ? [big] : []), ...Object.values(small)]) { // MOCK-HOOK
    const f = g.features.find((x) => x.name === name); // MOCK-HOOK
    if (f) return f.ms; // MOCK-HOOK
  } // MOCK-HOOK
  return null; // MOCK-HOOK
} // MOCK-HOOK

/** A feature the mock-up's goals list with no end date (F-105 Refund in one step). */
export function mkUndated(name: string, isBig: boolean): boolean { // MOCK-HOOK
  return [...(isBig ? [big] : []), ...Object.values(small)].some((g) => g.features.some((x) => x.name === name && !x.end)); // MOCK-HOOK
} // MOCK-HOOK

/** The name of the milestone a feature's end date sets (F-107: 10 paid conversions per rep). */
export function mkMilestoneName(name: string, isBig: boolean): string | null { // MOCK-HOOK
  for (const g of [...(isBig ? [big] : []), ...Object.values(small)]) { // MOCK-HOOK
    const f = g.features.find((x) => x.name === name && x.end); // MOCK-HOOK
    const m = f && g.milestones.find((x) => x.code === f.ms); // MOCK-HOOK
    if (m) return m.name; // MOCK-HOOK
  } // MOCK-HOOK
  return null; // MOCK-HOOK
} // MOCK-HOOK
