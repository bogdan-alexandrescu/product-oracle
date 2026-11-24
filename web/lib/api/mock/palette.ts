// MOCK-HOOK: whole file. mk-palette mock-ups (#1794, decisions CP1..CP3): the palette's invented
// index beyond the roadmap's own features (PRDs, goals, key results, milestones, recent items) and
// the "many long names" set for the hard case. Invented people and products only. Never merged.

export type PaletteKind = 'Feature' | 'PRD' | 'Goal' | 'Key result' | 'Milestone'; // MOCK-HOOK

export type PaletteSeed = { kind: PaletteKind; code?: string; name: string; where: string; href: string }; // MOCK-HOOK

export const PALETTE_SEED: PaletteSeed[] = [
  { kind: 'PRD', name: 'Usage alerts PRD', where: 'One-pagers · In review', href: '/simple/one-pagers' },
  { kind: 'PRD', name: 'Guided setup PRD', where: 'One-pagers · Approved', href: '/simple/one-pagers' },
  { kind: 'PRD', name: 'Plan changes PRD', where: 'One-pagers · Draft', href: '/simple/one-pagers' },
  { kind: 'PRD', name: 'Annual billing PRD', where: 'One-pagers · In review', href: '/simple/one-pagers' },
  { kind: 'PRD', name: 'Team onboarding PRD', where: 'One-pagers · Draft', href: '/simple/one-pagers' },
  { kind: 'PRD', name: 'Clinic outreach PRD', where: 'One-pagers · Draft', href: '/simple/one-pagers' },
  { kind: 'Goal', name: 'Growth', where: 'Goal map · 9.4% of 12%', href: '/simple/goals' },
  { kind: 'Goal', name: 'Activation', where: 'Goal map · 38% of 45%', href: '/simple/goals' },
  { kind: 'Goal', name: 'Cut early churn', where: 'Goal map · Proposed', href: '/simple/goals' },
  { kind: 'Key result', name: 'Teams active after 90 days', where: 'Growth', href: '/simple/goals' },
  { kind: 'Key result', name: 'Days to the first alert', where: 'Activation', href: '/simple/goals' },
  { kind: 'Key result', name: 'Sign-ups per rep per day', where: 'Growth', href: '/simple/goals' },
  { kind: 'Key result', name: 'Paid conversions per rep per day', where: 'Growth', href: '/simple/goals' },
  { kind: 'Milestone', code: 'M3', name: '50 sign-ups per rep', where: 'Roadmap · Dec 2', href: '/simple/roadmap' },
  { kind: 'Milestone', code: 'M4', name: '6 paid conversions per rep', where: 'Roadmap · Dec 4', href: '/simple/roadmap' },
  { kind: 'Milestone', code: 'M6', name: 'Beta', where: 'Roadmap · Nov 30', href: '/simple/roadmap' },
  { kind: 'Milestone', code: 'M7', name: '10 paid conversions per rep', where: 'Roadmap · Jan 4', href: '/simple/roadmap' },
  { kind: 'Milestone', code: 'M8', name: '$20k revenue per day', where: 'Roadmap · Feb 1', href: '/simple/roadmap' },
];

/** Recent items (the empty box shows them): invented. */
export const PALETTE_RECENT = ['Weekly alert digest', 'Annual billing PRD', 'Growth']; // MOCK-HOOK

const WORDS = [
  'Alert', 'Digest', 'Quiet hours', 'Team', 'Billing', 'Region', 'Invite', 'Health log', 'Export', 'Seat',
];
const TAILS = [
  'for teams that share one billing account across regions',
  'with a weekly summary sent to every approver on the account',
  'that pauses alerts during each person\'s quiet hours',
  'shown on the phone and in the email digest',
  'so admins can move seats between workspaces without support',
];

/** Hard case (?many=1): 60 more features with long invented names, codes F-201..F-260. */
export const PALETTE_MANY: PaletteSeed[] = Array.from({ length: 60 }, (_, i) => ({ // MOCK-HOOK
  kind: 'Feature' as const,
  code: `F-${201 + i}`,
  name: `${WORDS[i % WORDS.length]} ${['rules', 'center', 'digest', 'settings', 'report', 'alerts'][i % 6]} ${TAILS[i % TAILS.length]}`,
  where: ['Alerts roadmap · Usage alerts track', 'Onboarding roadmap · Guided setup track', 'Pricing roadmap · Plan changes track'][i % 3],
  href: '/simple/roadmap',
}));
