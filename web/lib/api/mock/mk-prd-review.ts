// MOCK-HOOK mk-prd-review: invented data for the PRD review mock-ups (decisions PR1..PR3).
// MOCK-HOOK An invented company (Lanternfish), invented people, features and goals; no real data.

export type MkPerson = { id: string; name: string; initials: string }; // MOCK-HOOK
export type MkGoal = { id: string; name: string; measure: string; start: string; target: string }; // MOCK-HOOK
export type MkFeature = {
  // MOCK-HOOK
  id: string;
  code: string;
  name: string;
  goal: string;
  owner: string | null;
  start: string; // MOCK-HOOK "2026-12-01"
  end: string;
  status: 'planned' | 'building' | 'draft';
  milestone?: string;
};
export type MkChange = {
  // MOCK-HOOK what changed since the last version
  id: string;
  kind: 'added' | 'changed' | 'removed';
  where: string; // MOCK-HOOK a feature id, a goal id or a section key
  field?: 'dates' | 'owner' | 'target' | 'text';
  before?: string;
  after?: string;
  by: string;
  at: string;
};

export const MK_PEOPLE: MkPerson[] = [
  { id: 'p1', name: 'Mara Quint', initials: 'MQ' }, // MOCK-HOOK
  { id: 'p2', name: 'Ishaan Pell', initials: 'IP' },
  { id: 'p3', name: 'Dot Varga', initials: 'DV' },
  { id: 'p4', name: 'Theo Brandt', initials: 'TB' },
  { id: 'p5', name: 'Noor Halvorsen', initials: 'NH' },
  { id: 'p6', name: 'Kemi Adeyo', initials: 'KA' },
];

export const MK_GOALS: MkGoal[] = [
  // MOCK-HOOK
  {
    id: 'g1',
    name: 'Faster first reply',
    measure: 'Median time to first reply',
    start: '9 h',
    target: '2 h',
  },
  {
    id: 'g2',
    name: 'Fewer lost requests',
    measure: 'Requests with no reply after 3 days',
    start: '12%',
    target: '3%',
  },
  {
    id: 'g3',
    name: 'More teams on paid plans',
    measure: 'Teams paying after the trial',
    start: '18%',
    target: '26%',
  },
];

export const MK_MILESTONES = [
  { id: 'm1', name: 'Beta for 20 teams', date: '2027-01-15' }, // MOCK-HOOK
  { id: 'm2', name: 'Open to all teams', date: '2027-03-01' },
];

const BASE: MkFeature[] = [
  // MOCK-HOOK the six features a normal one-pager carries
  {
    id: 'f1',
    code: 'F-201',
    name: 'One shared inbox per team',
    goal: 'g1',
    owner: 'p1',
    start: '2026-11-30',
    end: '2026-12-18',
    status: 'building',
    milestone: 'm1',
  },
  {
    id: 'f2',
    code: 'F-202',
    name: 'Assign rules by topic',
    goal: 'g1',
    owner: 'p2',
    start: '2026-12-07',
    end: '2027-01-12',
    status: 'planned',
    milestone: 'm1',
  },
  {
    id: 'f3',
    code: 'F-203',
    name: 'Reply templates',
    goal: 'g1',
    owner: 'p3',
    start: '2027-01-04',
    end: '2027-01-29',
    status: 'planned',
    milestone: 'm2',
  },
  {
    id: 'f4',
    code: 'F-204',
    name: 'Overdue nudges',
    goal: 'g2',
    owner: 'p4',
    start: '2026-12-14',
    end: '2027-01-22',
    status: 'planned',
    milestone: 'm1',
  },
  {
    id: 'f5',
    code: 'F-205',
    name: 'Snooze a thread',
    goal: 'g2',
    owner: null,
    start: '2027-01-18',
    end: '2027-02-12',
    status: 'draft',
    milestone: 'm2',
  },
  {
    id: 'f6',
    code: 'F-206',
    name: 'Seat upgrade from the inbox',
    goal: 'g3',
    owner: 'p5',
    start: '2027-01-25',
    end: '2027-02-26',
    status: 'planned',
    milestone: 'm2',
  },
];

const MORE: [string, string][] = [
  // MOCK-HOOK fourteen more for the long PRD (20 features)
  ['Customer history beside the thread', 'g1'],
  ['Keyboard reply shortcuts', 'g1'],
  ['Mobile push for new requests', 'g1'],
  ['Auto-close solved threads', 'g2'],
  ['Weekly lost-request digest', 'g2'],
  ['Shared notes on a thread', 'g2'],
  ['Merge duplicate requests', 'g2'],
  ['Office hours and away replies', 'g1'],
  ['Satisfaction score after a reply', 'g3'],
  ['Trial checklist in the inbox', 'g3'],
  ['Usage report for admins', 'g3'],
  ['Email forwarding set-up wizard', 'g1'],
  ['Tags and saved views', 'g2'],
  ['Plan limits shown before they bite', 'g3'],
];

export function mkFeatures(big: boolean): MkFeature[] {
  // MOCK-HOOK
  if (!big) return BASE.map((f) => ({ ...f }));
  const extra = MORE.map(([name, goal], i): MkFeature => {
    const s = new Date(Date.UTC(2026, 11, 1 + i * 6));
    const e = new Date(s.getTime() + (18 + (i % 4) * 7) * 86400000);
    return {
      id: `x${i}`,
      code: `F-${207 + i}`,
      name,
      goal,
      owner: i % 5 === 3 ? null : MK_PEOPLE[i % 6].id,
      start: s.toISOString().slice(0, 10),
      end: e.toISOString().slice(0, 10),
      status: i % 5 === 3 ? 'draft' : 'planned',
      milestone: i < 7 ? 'm1' : 'm2',
    };
  });
  return [...BASE.map((f) => ({ ...f })), ...extra];
}

export const MK_SECTIONS = [
  // MOCK-HOOK the PRD's prose, one line each when folded
  {
    key: 'problem',
    title: 'Problem',
    text: 'Small support teams answer customers from personal mailboxes. Requests get lost between people, and the first reply takes most of a working day.',
  },
  {
    key: 'who',
    title: 'Who has it',
    text: 'Teams of 3 to 15 people at Lanternfish customers who answer customer email together, most of them on the trial.',
  },
  {
    key: 'not',
    title: 'Not doing',
    text: 'Live chat. Phone calls. A public help centre. Reports beyond the admin usage report.',
  },
  {
    key: 'risks',
    title: 'Risks and open decisions',
    text: 'Assign rules may need a topic list from each team before beta. Open: do snoozed threads count as lost after 3 days?',
  },
];

export const MK_PRD = {
  // MOCK-HOOK
  title: 'Shared team inbox',
  version: 4,
  lastVersion: 3,
  lastVersionAt: 'Nov 9, 2026',
  owner: 'p1',
  status: 'In review',
};

export const MK_CHANGES: MkChange[] = [
  // MOCK-HOOK six changes since version 3
  { id: 'c1', kind: 'added', where: 'f5', by: 'p3', at: 'Nov 20, 4:12 PM' },
  {
    id: 'c2',
    kind: 'changed',
    where: 'f2',
    field: 'dates',
    before: 'Dec 7 – Dec 22',
    after: 'Dec 7 – Jan 12',
    by: 'p2',
    at: 'Nov 21, 10:03 AM',
  },
  {
    id: 'c3',
    kind: 'changed',
    where: 'f4',
    field: 'owner',
    before: 'Kemi Adeyo',
    after: 'Theo Brandt',
    by: 'p1',
    at: 'Nov 21, 2:40 PM',
  },
  {
    id: 'c4',
    kind: 'changed',
    where: 'g1',
    field: 'target',
    before: '3 h',
    after: '2 h',
    by: 'p1',
    at: 'Nov 22, 9:15 AM',
  },
  {
    id: 'c5',
    kind: 'changed',
    where: 'problem',
    field: 'text',
    before: 'Requests get lost between people.',
    after: 'Requests get lost between people, and the first reply takes most of a working day.',
    by: 'p6',
    at: 'Nov 22, 11:30 AM',
  },
  {
    id: 'c6',
    kind: 'removed',
    where: 'not',
    field: 'text',
    before: 'Slack replies.',
    by: 'p4',
    at: 'Nov 22, 3:05 PM',
  },
];
