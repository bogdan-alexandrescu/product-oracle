// MOCK-HOOK: whole file. Mock-up data for '@mentions and the activity history' (mk-mentions, MA1..MA3).
// Invented people and text only. Never merged.
export type MkPerson = { id: string; name: string; role: string }; // MOCK-HOOK
export type MkEvent = { // MOCK-HOOK
  id: string;
  kind: 'change' | 'comment' | 'added';
  who: string;
  at: string;
  field?: string;
  before?: string;
  after?: string;
  /** a commenter's change, waiting or decided */
  proposal?: { state: 'waiting' | 'accepted'; by?: string; at?: string };
  oracle?: boolean;
  undo?: boolean;
  body?: string;
  mine?: boolean;
};

export const MK_PEOPLE: MkPerson[] = [ // MOCK-HOOK
  { id: 'p1', name: 'Avery Stone', role: 'Owner' },
  { id: 'p2', name: 'Priya Raman', role: 'Approver' },
  { id: 'p3', name: 'Theo Brandt', role: 'Commenter' },
  { id: 'p4', name: 'Lena Ortiz', role: 'Viewer' },
  { id: 'p5', name: 'Jun Park', role: 'Approver' },
  { id: 'p6', name: 'Marisol Okonkwo-Fairweather', role: 'Commenter' },
  { id: 'p7', name: 'Sam Whitaker', role: 'Approver' },
  { id: 'p8', name: 'Samira Haddad', role: 'Commenter' },
  { id: 'p9', name: 'Samuel Lindqvist-Arrowsmith', role: 'Viewer' },
  { id: 'p10', name: 'Sammy Cho', role: 'Commenter' },
  { id: 'p11', name: 'Rosalind Achterberg-Nakamura', role: 'Approver' },
];

/** F-79 Weekly alert digest, newest first. */
export const MK_EVENTS: MkEvent[] = [ // MOCK-HOOK
  { id: 'e1', kind: 'comment', who: 'Theo Brandt', at: '2026-11-23T15:10:00Z', body: 'Pilot customers asked for Monday mornings. Can the digest go out then?' },
  { id: 'e2', kind: 'change', who: 'Priya Raman', at: '2026-11-23T11:02:00Z', field: 'Dates', before: 'Oct 31 – Dec 10', after: 'Oct 31 – Dec 18' },
  { id: 'e3', kind: 'change', who: 'Theo Brandt', at: '2026-11-22T16:40:00Z', field: 'Owner', before: 'No owner', after: 'Jun Park', proposal: { state: 'accepted', by: 'Priya Raman', at: '2026-11-22T17:05:00Z' } },
  { id: 'e4', kind: 'comment', who: 'Priya Raman', at: '2026-11-22T10:15:00Z', body: '@[Avery Stone] the email team needs the copy by Dec 1.' },
  { id: 'e5', kind: 'change', who: 'Avery Stone', at: '2026-11-21T09:30:00Z', field: 'Status', before: 'Not started', after: 'In progress', mine: true },
  { id: 'e6', kind: 'change', who: 'Oracle', at: '2026-11-20T08:00:00Z', field: 'Confidence', before: 'Medium', after: 'Low', oracle: true, proposal: { state: 'accepted', by: 'Avery Stone', at: '2026-11-20T09:12:00Z' } },
  { id: 'e7', kind: 'comment', who: 'Avery Stone', at: '2026-11-19T14:22:00Z', body: 'Linking the PRD section once it is approved.' },
  { id: 'e8', kind: 'change', who: 'Avery Stone', at: '2026-11-18T13:00:00Z', field: 'Goal', before: 'No goal', after: 'Grow retention', mine: true },
  { id: 'e9', kind: 'change', who: 'Priya Raman', at: '2026-11-17T12:45:00Z', field: 'Depends on', before: 'Nothing', after: 'Alert rules engine' },
  { id: 'e9b', kind: 'change', who: 'Avery Stone', at: '2026-11-16T10:20:00Z', field: 'Dates', before: 'Oct 28 – Dec 5', after: 'Oct 31 – Dec 10', mine: true },
  { id: 'e10', kind: 'added', who: 'Avery Stone', at: '2026-11-16T10:00:00Z', after: 'Usage alerts roadmap' },
];

/** A waiting proposal by a commenter, for the hard role case. */
export const MK_WAITING: MkEvent = { // MOCK-HOOK
  id: 'w1', kind: 'change', who: 'Theo Brandt', at: '2026-11-24T08:20:00Z', field: 'Dates', before: 'Oct 31 – Dec 18', after: 'Nov 2 – Dec 21', proposal: { state: 'waiting' },
};

const FIELDS: [string, string[]][] = [ // MOCK-HOOK
  ['Dates', ['Oct 31 – Dec 10', 'Oct 31 – Dec 18', 'Nov 4 – Dec 22', 'Nov 7 – Jan 9', 'Oct 28 – Dec 5']],
  ['Status', ['Not started', 'In progress', 'Blocked', 'In progress']],
  ['Owner', ['Jun Park', 'Marisol Okonkwo-Fairweather', 'Sam Whitaker', 'Rosalind Achterberg-Nakamura']],
  ['Confidence', ['High', 'Medium', 'Low']],
  ['Outcome', ['Admins see alerts in one weekly email', 'Admins act on alerts within a day', 'Fewer alert emails per admin']],
  ['Horizon', ['Now', 'Next', 'Later']],
];
const WHO = ['Priya Raman', 'Marisol Okonkwo-Fairweather', 'Rosalind Achterberg-Nakamura', 'Avery Stone', 'Theo Brandt', 'Sam Whitaker', 'Oracle']; // MOCK-HOOK
const SAID = [ // MOCK-HOOK
  'Moving this after the pricing launch so support is not swamped.',
  '@[Rosalind Achterberg-Nakamura] can your team cover the January on-call week?',
  'Pilot feedback: the digest is too long when a team has more than 40 alerts.',
  'Agreed, holding the date.',
  '@[Priya Raman] @[Jun Park] this needs a decision before Friday.',
];

/** Two hundred events for the hard case, newest first (Sep 1 – Nov 23). */
export function mkManyEvents(): MkEvent[] { // MOCK-HOOK
  const out: MkEvent[] = [];
  let t = Date.parse('2026-11-23T16:00:00Z');
  for (let i = 0; i < 200; i++) {
    t -= (i % 3 === 0 ? 3 : 7) * 3600_000 + (i % 5) * 600_000;
    const who = WHO[(i * 5 + (i >> 2)) % WHO.length];
    const at = new Date(t).toISOString();
    if (i % 6 === 2) {
      out.push({ id: `h${i}`, kind: 'comment', who: who === 'Oracle' ? 'Priya Raman' : who, at, body: SAID[i % SAID.length] });
      continue;
    }
    const [field, vals] = FIELDS[(i * 7) % FIELDS.length];
    const k = i % vals.length;
    out.push({
      id: `h${i}`, kind: 'change', who, at, field,
      before: vals[(k + 1) % vals.length], after: vals[k],
      oracle: who === 'Oracle' || undefined,
      proposal: who === 'Theo Brandt' || who === 'Oracle' ? { state: 'accepted', by: 'Priya Raman', at } : undefined,
      mine: who === 'Avery Stone' || undefined,
    });
  }
  return out;
}
