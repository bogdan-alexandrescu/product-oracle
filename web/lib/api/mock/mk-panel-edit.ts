// MOCK-HOOK: mk-panel-edit mock-up data (throwaway branch, never merged). Invented people,
// features and text only: a made-up company, Brightwell, and its made-up team.

export const PE_PEOPLE = [ // MOCK-HOOK
  { id: 'p1', name: 'Mira Okafor', role: 'Product lead' }, // MOCK-HOOK
  { id: 'p2', name: 'Jonah Reyes', role: 'Engineering lead' }, // MOCK-HOOK
  { id: 'p3', name: 'Priya Lund', role: 'Design' }, // MOCK-HOOK
  { id: 'p4', name: 'Theo Marsh', role: 'Engineering' }, // MOCK-HOOK
  { id: 'p5', name: 'Avery Stone', role: 'Owner of the roadmap' }, // MOCK-HOOK
]; // MOCK-HOOK

export const PE_MILESTONES = ['M6 Beta · Nov 30', 'M7 10 paid conversions · Jan 15', 'Board meeting · Jan 22']; // MOCK-HOOK

/** The hard case: a long title and 8 dependencies (invented). */
export const PE_HARD = { // MOCK-HOOK
  title: // MOCK-HOOK
    'Let account admins route every usage alert to the right team by region, product line and on-call rota, with quiet hours', // MOCK-HOOK
  code: 'F-212', // MOCK-HOOK
  deps: [ // MOCK-HOOK
    'F-201 Alert rules engine', // MOCK-HOOK
    'F-202 Team directory sync', // MOCK-HOOK
    'F-203 Region tags on accounts', // MOCK-HOOK
    'F-204 Product line catalogue', // MOCK-HOOK
    'F-205 On-call rota import', // MOCK-HOOK
    'F-206 Quiet hours per team', // MOCK-HOOK
    'F-207 Alert delivery log', // MOCK-HOOK
    'F-208 Admin roles for routing', // MOCK-HOOK
  ], // MOCK-HOOK
}; // MOCK-HOOK

/** The flags every proposal acts on (invented). */
export const PE_FLAGS = { // MOCK-HOOK
  owner: 'Draft with no owner to confirm it', // MOCK-HOOK
  dates: 'Oracle suggests Oct 6 – Nov 24 from the team’s pace', // MOCK-HOOK
  link: 'F-79 Weekly alert digest starts before this ends', // MOCK-HOOK
}; // MOCK-HOOK
