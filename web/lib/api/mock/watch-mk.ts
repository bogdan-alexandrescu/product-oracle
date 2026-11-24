// MOCK-HOOK: mk-watch mock-ups only (decisions WD1..WD3). Invented people, items and dates.

export type MkSlip = { // MOCK-HOOK
  code: string; // MOCK-HOOK
  name: string; // MOCK-HOOK
  kind: 'Feature' | 'Milestone' | 'Goal' | 'PRD'; // MOCK-HOOK
  from: string; // MOCK-HOOK
  to: string; // MOCK-HOOK
  days: number; // MOCK-HOOK
  why: string; // MOCK-HOOK
  goal: string; // MOCK-HOOK
  past?: string; // MOCK-HOOK
}; // MOCK-HOOK

export const MK_SLIPS: MkSlip[] = [ // MOCK-HOOK
  { // MOCK-HOOK
    code: 'F-79', // MOCK-HOOK
    name: 'Weekly alert digest', // MOCK-HOOK
    kind: 'Feature', // MOCK-HOOK
    from: 'Dec 10', // MOCK-HOOK
    to: 'Dec 18', // MOCK-HOOK
    days: 8, // MOCK-HOOK
    why: 'Alert rules engine, which it needs, now ends Nov 18', // MOCK-HOOK
    goal: 'Grow retention', // MOCK-HOOK
    past: 'Milestone Beta', // MOCK-HOOK
  }, // MOCK-HOOK
  { // MOCK-HOOK
    code: 'F-01', // MOCK-HOOK
    name: 'Setup checklist', // MOCK-HOOK
    kind: 'Feature', // MOCK-HOOK
    from: 'Nov 15', // MOCK-HOOK
    to: 'Nov 29', // MOCK-HOOK
    days: 14, // MOCK-HOOK
    why: 'Rae Okafor set it At risk: “Waiting on the import design”', // MOCK-HOOK
    goal: 'Faster activation', // MOCK-HOOK
  }, // MOCK-HOOK
  { // MOCK-HOOK
    code: 'M6', // MOCK-HOOK
    name: 'Beta', // MOCK-HOOK
    kind: 'Milestone', // MOCK-HOOK
    from: 'Nov 30', // MOCK-HOOK
    to: 'Dec 7', // MOCK-HOOK
    days: 7, // MOCK-HOOK
    why: 'Jonah Prell moved it to fit the alert digest', // MOCK-HOOK
    goal: 'Grow retention', // MOCK-HOOK
  }, // MOCK-HOOK
]; // MOCK-HOOK

const LONG = [ // MOCK-HOOK
  ['F-112', 'Rep daily scoreboard with team and region breakdowns for managers'], // MOCK-HOOK
  ['F-104', 'Complaint early warning from support tickets and app store reviews'], // MOCK-HOOK
  ['F-109', 'Guided first week'], // MOCK-HOOK
  ['F-103', 'Lead list ranking by likely paid conversion this quarter'], // MOCK-HOOK
  ['F-101', 'One-tap sign-up link'], // MOCK-HOOK
  ['F-107', 'Partner referral channel with shared revenue reports'], // MOCK-HOOK
  ['F-108', 'Pricing page test'], // MOCK-HOOK
  ['F-105', 'Refund in one step'], // MOCK-HOOK
  ['F-102', 'Rep call script hints'], // MOCK-HOOK
]; // MOCK-HOOK
const WHY = [ // MOCK-HOOK
  'Its estimate grew from 3 to 5 weeks', // MOCK-HOOK
  'Sample data import, which it needs, moved 6 days', // MOCK-HOOK
  'Mira Castell moved it: “Design review slipped a week”', // MOCK-HOOK
  'Status changed to Blocked by Dev Anand', // MOCK-HOOK
]; // MOCK-HOOK

/** The hard case: many slips in one digest, long names. */ // MOCK-HOOK
export const MK_SLIPS_MANY: MkSlip[] = [ // MOCK-HOOK
  ...MK_SLIPS, // MOCK-HOOK
  ...LONG.map(([code, name], k) => ({ // MOCK-HOOK
    code, // MOCK-HOOK
    name, // MOCK-HOOK
    kind: 'Feature' as const, // MOCK-HOOK
    from: `Jan ${5 + k}`, // MOCK-HOOK
    to: `Jan ${12 + k * 2}`, // MOCK-HOOK
    days: 7 + k, // MOCK-HOOK
    why: WHY[k % WHY.length], // MOCK-HOOK
    goal: k % 2 ? 'Paid conversions per rep per day' : 'Sign-ups per rep per day', // MOCK-HOOK
  })), // MOCK-HOOK
]; // MOCK-HOOK

export type MkWatched = { code: string; name: string; kind: string; reason: string; tells: string }; // MOCK-HOOK

/** What the signed-in owner watches (Avery Stone): theirs by default, plus a few they picked. */ // MOCK-HOOK
export const MK_WATCHED: MkWatched[] = [ // MOCK-HOOK
  { code: 'F-79', name: 'Weekly alert digest', kind: 'Feature', reason: 'You decide it', tells: 'Everything' }, // MOCK-HOOK
  { code: 'M6', name: 'Beta', kind: 'Milestone', reason: 'You own it', tells: 'Everything' }, // MOCK-HOOK
  { code: 'G-2', name: 'Faster activation', kind: 'Goal', reason: 'You own it', tells: 'Everything' }, // MOCK-HOOK
  { code: 'P-3', name: 'Usage alerts', kind: 'PRD', reason: 'You approve it', tells: 'Dates and status' }, // MOCK-HOOK
  { code: 'F-104', name: 'Complaint early warning from support tickets and app store reviews', kind: 'Feature', reason: 'You picked it', tells: 'Dates only' }, // MOCK-HOOK
  { code: 'F-112', name: 'Rep daily scoreboard with team and region breakdowns for managers', kind: 'Feature', reason: 'You picked it', tells: 'Everything' }, // MOCK-HOOK
  { code: 'F-109', name: 'Guided first week', kind: 'Feature', reason: 'You picked it', tells: 'Everything' }, // MOCK-HOOK
  { code: 'F-103', name: 'Lead list ranking by likely paid conversion this quarter', kind: 'Feature', reason: 'You picked it', tells: 'Mentions only' }, // MOCK-HOOK
  { code: 'M7', name: 'Pricing launch', kind: 'Milestone', reason: 'You picked it', tells: 'Everything' }, // MOCK-HOOK
  { code: 'F-107', name: 'Partner referral channel with shared revenue reports', kind: 'Feature', reason: 'You picked it', tells: 'Everything' }, // MOCK-HOOK
  { code: 'F-105', name: 'Refund in one step', kind: 'Feature', reason: 'You picked it', tells: 'Dates only' }, // MOCK-HOOK
  { code: 'G-4', name: 'Paid conversions per rep per day', kind: 'Goal', reason: 'You picked it', tells: 'Everything' }, // MOCK-HOOK
]; // MOCK-HOOK

export const MK_WATCHERS = ['Avery Stone', 'Rae Okafor', 'Jonah Prell', 'Mira Castell', 'Dev Anand', 'Lena Hartwig']; // MOCK-HOOK
/** Everyone who could be asked to watch (watchers plus a few who do not watch yet). */ // MOCK-HOOK
export const MK_PEOPLE = [...MK_WATCHERS.slice(1), 'Rafael Moss', 'Noor Haddad', 'Sam Whitlow']; // MOCK-HOOK
