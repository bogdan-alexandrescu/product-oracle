// MOCK-HOOK: the whole file. Mock-ups for "My work: what I own or decide" (#1798, MW1..MW3);
// invented people, tracks and features only. Never merged.

export type MwKind = 'feature' | 'decision' | 'proposal' | 'milestone'; // MOCK-HOOK

export type MwItem = {
  // MOCK-HOOK
  id: string;
  kind: MwKind;
  code?: string;
  name: string;
  track: string;
  /** Month-first day, or null for no date. */
  due: string | null;
  /** 0 late, 1 this week, 2 next week, 3 later, 4 no date. */
  when: 0 | 1 | 2 | 3 | 4;
  risk?: boolean;
  /** Decisions: the recommended answer and the others. */
  rec?: string;
  options?: string[];
  blocks?: string;
  /** Proposals: who it waits on. */
  waits?: string;
};

// MOCK-HOOK: Avery Stone's own work in the mock company (Northwind Trail, invented).
export const MW_ITEMS: MwItem[] = [
  {
    id: 'd1',
    kind: 'decision',
    code: 'Q5',
    name: 'Reminder default time',
    track: 'Guided setup track',
    due: 'Nov 18',
    when: 0,
    rec: "9:00 in each person's zone",
    options: ['Noon', 'Let each person pick'],
    blocks: 'F-03 Health log',
  }, // MOCK-HOOK
  {
    id: 'f1',
    kind: 'feature',
    code: 'F-101',
    name: 'One-tap sign-up link',
    track: 'Guided setup track',
    due: 'Nov 20',
    when: 0,
  }, // MOCK-HOOK
  {
    id: 'f2',
    kind: 'feature',
    code: 'F-106',
    name: 'Trial reminder texts',
    track: 'Guided setup track',
    due: 'Nov 27',
    when: 1,
    risk: true,
  }, // MOCK-HOOK
  {
    id: 'd2',
    kind: 'decision',
    code: 'Q6',
    name: 'Invite limit on the free plan',
    track: 'Guided setup track',
    due: 'Nov 28',
    when: 1,
    rec: '5 invites',
    options: ['3 invites', 'No limit'],
    blocks: 'F-05 Invite teammates',
  }, // MOCK-HOOK
  {
    id: 'p1',
    kind: 'proposal',
    code: 'F-108',
    name: 'Pricing page test: start Dec 7',
    track: 'Pricing track',
    due: 'Nov 29',
    when: 1,
    waits: 'Priya Raman',
  }, // MOCK-HOOK
  {
    id: 'm1',
    kind: 'milestone',
    name: 'Onboarding beta',
    track: 'Onboarding roadmap',
    due: 'Dec 1',
    when: 2,
  }, // MOCK-HOOK
  {
    id: 'd3',
    kind: 'decision',
    code: 'Q8',
    name: 'Sign-in choice: Google at launch',
    track: 'Guided setup track',
    due: 'Dec 1',
    when: 2,
    rec: 'Yes, at launch',
    options: ['After launch'],
    blocks: 'F-01 Sign in',
  }, // MOCK-HOOK
  {
    id: 'f3',
    kind: 'feature',
    code: 'F-109',
    name: 'Guided first week',
    track: 'Guided setup track',
    due: 'Dec 4',
    when: 2,
  }, // MOCK-HOOK
  {
    id: 'f4',
    kind: 'feature',
    code: 'F-111',
    name: 'Team invite at sign-up',
    track: 'Guided setup track',
    due: 'Dec 15',
    when: 3,
  }, // MOCK-HOOK
  {
    id: 'm2',
    kind: 'milestone',
    name: 'Pricing launch',
    track: 'Pricing roadmap',
    due: 'Dec 14',
    when: 3,
  }, // MOCK-HOOK
  {
    id: 'p2',
    kind: 'proposal',
    code: 'F-112',
    name: 'Rep daily scoreboard: add to Sales track',
    track: 'Sales track',
    due: null,
    when: 4,
    waits: 'Theo Brandt',
  }, // MOCK-HOOK
  {
    id: 'f5',
    kind: 'feature',
    code: 'F-03',
    name: 'Health log',
    track: 'Guided setup track',
    due: null,
    when: 4,
  }, // MOCK-HOOK
];

// MOCK-HOOK: features with no owner yet, for the empty state's picker.
export const MW_UNOWNED: MwItem[] = [
  {
    id: 'u1',
    kind: 'feature',
    code: 'F-102',
    name: 'Rep call script hints',
    track: 'Guided setup track',
    due: 'Dec 9',
    when: 3,
  }, // MOCK-HOOK
  {
    id: 'u2',
    kind: 'feature',
    code: 'F-103',
    name: 'Lead list ranking',
    track: 'Guided setup track',
    due: 'Dec 11',
    when: 3,
  }, // MOCK-HOOK
  {
    id: 'u3',
    kind: 'feature',
    code: 'F-104',
    name: 'Complaint early warning',
    track: 'Guided setup track',
    due: 'Nov 30',
    when: 2,
  }, // MOCK-HOOK
  {
    id: 'u4',
    kind: 'feature',
    code: 'F-105',
    name: 'Refund in one step',
    track: 'Guided setup track',
    due: null,
    when: 4,
  }, // MOCK-HOOK
  {
    id: 'u5',
    kind: 'feature',
    code: 'F-107',
    name: 'Partner referral channel',
    track: 'Guided setup track',
    due: 'Jan 12',
    when: 3,
  }, // MOCK-HOOK
  {
    id: 'u6',
    kind: 'feature',
    code: 'F-110',
    name: 'Annual plan offer',
    track: 'Guided setup track',
    due: 'Dec 18',
    when: 3,
  }, // MOCK-HOOK
];

// MOCK-HOOK: forty items for the "owns forty" hard case, long names included.
const FORTY_NAMES = [
  'Shared calendar sync for every team space and its guests',
  'Bulk export of alert history',
  'Quiet hours by region',
  'Saved filters on the alert list',
  'Mobile push for urgent alerts only',
  'Weekly digest for account owners and their deputies',
  'Seat count warning before renewal',
  'Coupon codes at checkout',
  'Invoice email in the buyer’s own language',
  'Self-serve plan downgrade',
  'Usage meter on the billing page',
  'Trial extension by request',
  'Sign-in with a work email link',
  'Two-step sign-in for admins',
  'Team roles on the invite form',
  'Welcome checklist that remembers what each person skipped',
  'Sample project on first sign-in',
  'In-app tour for the alert rules page',
  'Status page link in the footer',
  'Read-only share links',
  'Comment mentions with email',
  'Dark mode for printed reports',
  'CSV import of contacts',
  'Duplicate contact merge',
  'Lead source on every deal',
  'Rep leaderboard by week',
  'Call notes from the phone app',
  'Spam check on sign-up',
];
const DAYS = [
  'Nov 16',
  'Nov 19',
  'Nov 23',
  'Nov 25',
  'Nov 26',
  'Nov 27',
  'Dec 1',
  'Dec 3',
  'Dec 8',
  'Dec 10',
  'Jan 6',
  'Jan 20',
  null,
]; // MOCK-HOOK
const WHEN: MwItem['when'][] = [0, 0, 0, 1, 1, 1, 2, 2, 3, 3, 3, 3, 4]; // MOCK-HOOK
export const MW_FORTY: MwItem[] = [
  ...MW_ITEMS, // MOCK-HOOK
  ...FORTY_NAMES.map((name, i) => ({
    id: `x${i}`, // MOCK-HOOK
    kind: (i % 9 === 4 ? 'milestone' : i % 7 === 3 ? 'decision' : 'feature') as MwKind, // MOCK-HOOK
    code: i % 9 === 4 ? undefined : i % 7 === 3 ? `Q${40 + i}` : `F-${140 + i}`, // MOCK-HOOK
    name, // MOCK-HOOK
    track: ['Usage alerts track', 'Pricing track', 'Guided setup track', 'Sales track'][i % 4], // MOCK-HOOK
    due: DAYS[i % DAYS.length], // MOCK-HOOK
    when: WHEN[i % WHEN.length], // MOCK-HOOK
    risk: i % 5 === 2, // MOCK-HOOK
    rec: i % 7 === 3 ? 'Yes, at launch' : undefined, // MOCK-HOOK
    options: i % 7 === 3 ? ['Not yet', 'Later this year'] : undefined, // MOCK-HOOK
  })),
].slice(0, 40); // MOCK-HOOK

// MOCK-HOOK: the decisions waiting for Avery Stone on Decisions (34) that have no due date and
// so are not listed on My work; My work links to them.
export const MW_MORE_DECISIONS = 31; // MOCK-HOOK

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']; // MOCK-HOOK
/** MOCK-HOOK: "Nov 20" -> 2026-11-20 (Jan to Mar fall in 2027). */
function isoOf(d: string): string {
  const [m, day] = d.split(' '); // MOCK-HOOK
  const mi = MONTHS.indexOf(m); // MOCK-HOOK
  return `${mi < 3 ? 2027 : 2026}-${String(mi + 1).padStart(2, '0')}-${day.padStart(2, '0')}`; // MOCK-HOOK
}
function minus28(iso: string): string {
  const t = new Date(`${iso}T12:00:00Z`); // MOCK-HOOK
  t.setUTCDate(t.getUTCDate() - 27); // MOCK-HOOK
  return t.toISOString().slice(0, 10); // MOCK-HOOK
}

/** MOCK-HOOK: which unowned features this frame has made mine (MW3 results). */
function takenNow(): string[] {
  if (typeof window === 'undefined') return []; // MOCK-HOOK
  const q = new URLSearchParams(window.location.search); // MOCK-HOOK
  if (q.get('case') === 'one') return ['u1']; // MOCK-HOOK
  if (q.get('pick') === 'done') return ['u1', 'u3']; // MOCK-HOOK
  return []; // MOCK-HOOK
}

/**
 * MOCK-HOOK: the mock roadmap's item as My work's row says it: Avery Stone owns it, on the row's
 * track, due the row's day (a four-week span to it). Only while a My work switch is on.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function mwRoadmapItem<T extends { code?: string | null; title: string; [k: string]: any }>(
  i: T,
  meId: string,
): T {
  const mine = [...MW_ITEMS, ...MW_UNOWNED.filter((u) => takenNow().includes(u.id))].find(
    (x) => x.kind === 'feature' && x.code && x.code === i.code,
  ); // MOCK-HOOK
  const row = mine ?? MW_UNOWNED.find((x) => x.code === i.code); // MOCK-HOOK
  if (!row) return i; // MOCK-HOOK
  const out = { ...i, title: row.name } as T & Record<string, unknown>; // MOCK-HOOK
  if (mine) {
    (out as Record<string, unknown>).owner = { id: meId, name: 'Avery Stone' }; // MOCK-HOOK
    (out as Record<string, unknown>).own_owner_id = meId; // MOCK-HOOK
  }
  const g = (i as Record<string, any>).goal; // MOCK-HOOK
  if (g && !g.due) (out as Record<string, unknown>).goal = { ...g, due: '2027-03-31' }; // MOCK-HOOK: the goal's target date, so Date is not blank beside the feature's dates
  if (row.due && i.start && i.end) {
    const end = isoOf(row.due); // MOCK-HOOK
    (out as Record<string, unknown>).start = {
      ...i.start,
      date: minus28(end),
      source: 'accepted',
      estimated: false,
    }; // MOCK-HOOK
    (out as Record<string, unknown>).end = {
      ...i.end,
      date: end,
      source: 'accepted',
      estimated: false,
    }; // MOCK-HOOK
  }
  return out; // MOCK-HOOK
}
