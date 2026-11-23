// MOCK-HOOK: mk-roadmap-edit mock-ups only (never merged). Invented company "Juniper Lane", a
// home-energy app; invented people, features, goals and dates. Every line in this file is mock-up data.

export type ReItem = {
  id: string;
  code: string;
  name: string;
  track: string;
  goal: string;
  start: string; // ISO date, used only to place the bar; shown month first
  end: string;
  kind: 'dated' | 'est' | 'draft';
  owner: string | null;
  horizon: 'now' | 'next' | 'later';
  was?: [string, string]; // its dates in the approved version, when changed since
  decision?: string; // what needs a decision, if anything
  isNew?: boolean;
};
export type ReMilestone = { id: string; name: string; date: string; isNew?: boolean };

export const RE_TODAY = '2026-11-23';
export const RE_FROM = '2026-10-01';
export const RE_TO = '2027-06-30';
export const RE_PEOPLE = ['Mara Quill', 'Tobias Fenn', 'Ines Okafor', 'Jun Park', 'Leo Brandt', 'Sofi Arden'];
export const RE_TRACKS = ['Billing track', 'Mobile app track', 'Energy insights track'];
export const RE_GOALS = ['Cut bill shocks', 'Grow monthly users', 'Faster setup'];

export const RE_ITEMS: ReItem[] = [
  { id: 'a1', code: 'F-12', name: 'Bill forecast', track: 'Billing track', goal: 'Cut bill shocks', start: '2026-10-05', end: '2026-11-27', kind: 'dated', owner: 'Mara Quill', horizon: 'now' },
  { id: 'a2', code: 'F-14', name: 'Spike alerts by text', track: 'Billing track', goal: 'Cut bill shocks', start: '2026-11-16', end: '2027-01-08', kind: 'dated', owner: 'Tobias Fenn', horizon: 'now', was: ['2026-11-02', '2026-12-18'] },
  { id: 'a3', code: 'F-17', name: 'Split bills between flatmates', track: 'Billing track', goal: 'Grow monthly users', start: '2027-01-11', end: '2027-03-05', kind: 'est', owner: null, horizon: 'next', decision: 'Draft with no owner to confirm it' },
  { id: 'a4', code: 'F-21', name: 'Paper bill opt-out', track: 'Billing track', goal: 'Cut bill shocks', start: '2027-03-15', end: '2027-04-30', kind: 'draft', owner: null, horizon: 'later' },
  { id: 'b1', code: 'F-08', name: 'Faster sign-in', track: 'Mobile app track', goal: 'Faster setup', start: '2026-10-12', end: '2026-12-04', kind: 'dated', owner: 'Ines Okafor', horizon: 'now' },
  { id: 'b2', code: 'F-19', name: 'Meter photo reader', track: 'Mobile app track', goal: 'Faster setup', start: '2026-12-07', end: '2027-02-12', kind: 'dated', owner: 'Jun Park', horizon: 'next', was: ['2026-12-07', '2027-01-22'], decision: 'Ends after its milestone' },
  { id: 'b3', code: 'F-23', name: 'Home screen widget', track: 'Mobile app track', goal: 'Grow monthly users', start: '2027-02-15', end: '2027-04-09', kind: 'est', owner: 'Jun Park', horizon: 'later' },
  { id: 'c1', code: 'F-05', name: 'Weekly energy report', track: 'Energy insights track', goal: 'Grow monthly users', start: '2026-10-19', end: '2026-12-18', kind: 'dated', owner: 'Leo Brandt', horizon: 'now' },
  { id: 'c2', code: 'F-26', name: 'Compare with similar homes', track: 'Energy insights track', goal: 'Cut bill shocks', start: '2027-01-04', end: '2027-02-26', kind: 'est', owner: 'Sofi Arden', horizon: 'next', was: ['2027-01-18', '2027-03-12'] },
  { id: 'c3', code: 'F-29', name: 'Solar panel advice', track: 'Energy insights track', goal: 'Grow monthly users', start: '2027-03-01', end: '2027-05-14', kind: 'draft', owner: null, horizon: 'later', decision: 'Not in the Ground Truth' },
];

export const RE_MILESTONES: ReMilestone[] = [
  { id: 'm1', name: 'Winter tariff launch', date: '2026-12-14' },
  { id: 'm2', name: 'Board meeting', date: '2027-02-10' },
  { id: 'm3', name: 'Spring release', date: '2027-04-12' },
];

const WORDS = ['Usage', 'Tariff', 'Account', 'Payment', 'Outage', 'Smart plug', 'Heat pump', 'Boiler', 'Meter', 'Budget', 'Referral', 'Help'];
const TAILS = ['history', 'reminders', 'settings', 'chart', 'export', 'check-in', 'tips', 'switcher', 'badges', 'search'];

/** The hard case: a 60-item roadmap, one with a very long title. */
export function reBigItems(): ReItem[] {
  const out: ReItem[] = [...RE_ITEMS];
  for (let i = 0; out.length < 60; i++) {
    const g = RE_GOALS[i % 3];
    const t = RE_TRACKS[(i + 1) % 3];
    const s = new Date(Date.UTC(2026, 9, 5 + ((i * 11) % 200)));
    const e = new Date(s.getTime() + (28 + ((i * 7) % 50)) * 86400000);
    const iso = (d: Date) => d.toISOString().slice(0, 10);
    out.push({
      id: `x${i}`,
      code: `F-${40 + i}`,
      name:
        i === 7
          ? 'Let renters and landlords share one energy account with separate bills and alerts'
          : `${WORDS[i % WORDS.length]} ${TAILS[(i * 3) % TAILS.length]}`,
      track: t,
      goal: g,
      start: iso(s),
      end: iso(e),
      kind: i % 9 === 0 ? 'draft' : i % 4 === 0 ? 'est' : 'dated',
      owner: i % 6 === 0 ? null : RE_PEOPLE[i % RE_PEOPLE.length],
      horizon: s < new Date(Date.UTC(2026, 11, 20)) ? 'now' : s < new Date(Date.UTC(2027, 2, 1)) ? 'next' : 'later',
      was: i % 5 === 2 ? [iso(new Date(s.getTime() - 14 * 86400000)), iso(e)] : undefined,
      decision: i % 8 === 3 ? 'Starts before what it depends on ends' : undefined,
    });
  }
  return out;
}
