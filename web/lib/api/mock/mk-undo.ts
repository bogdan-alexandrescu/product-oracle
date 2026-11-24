// MOCK-HOOK (mk-undo mock-ups only, never merged): invented history lines for the Undo mock-ups'
// History states (UT3). Invented people and text only. // MOCK-HOOK

export type MkHistoryLine = { // MOCK-HOOK
  who: string; // MOCK-HOOK
  what: string; // MOCK-HOOK
  when: string; // MOCK-HOOK
  undo?: boolean; // MOCK-HOOK
  undone?: boolean; // MOCK-HOOK
}; // MOCK-HOOK

export const MK_HISTORY: MkHistoryLine[] = [ // MOCK-HOOK
  { who: 'Jordan Park', what: 'set the status to At risk', when: 'Nov 23, 4:12 PM', undo: true }, // MOCK-HOOK
  { who: 'Mina Okafor', what: 'added the dependency on F-70 Alert rules engine', when: 'Nov 21, 10:03 AM', undo: true }, // MOCK-HOOK
  { who: 'Avery Stone', what: 'moved it to Oct 31 – Dec 10', when: 'Nov 18, 9:40 AM', undo: true }, // MOCK-HOOK
  { who: 'Theo Lindqvist', what: 'proposed cutting it · declined', when: 'Nov 14, 2:55 PM' }, // MOCK-HOOK
  { who: 'Avery Stone', what: 'added it to Usage alerts track', when: 'Nov 2, 11:20 AM' }, // MOCK-HOOK
]; // MOCK-HOOK

/** Changes made today on other pages (UT3 b's "Your changes" list). */ // MOCK-HOOK
export const MK_MINE: MkHistoryLine[] = [ // MOCK-HOOK
  { who: 'Avery Stone', what: 'Moved F-112 Seat-based invoices to rank 2 in Priorities', when: '11:42 AM', undo: true }, // MOCK-HOOK
  { who: 'Avery Stone', what: 'Set F-88 Quiet hours for alerts to Done', when: '11:31 AM', undo: true }, // MOCK-HOOK
  { who: 'Avery Stone', what: 'Moved F-131 Self-serve plan downgrade with prorated credit for annual teams to Trash', when: '10:58 AM', undo: true }, // MOCK-HOOK
  { who: 'Avery Stone', what: 'Cut F-64 In-app tour from the roadmap', when: '9:15 AM', undo: true }, // MOCK-HOOK
]; // MOCK-HOOK

/** A commenter's own proposals today (UT3 b's hard case): each waits for the owner; Withdraw takes it back. */ // MOCK-HOOK
export const MK_ASKED: MkHistoryLine[] = [ // MOCK-HOOK
  { who: 'Theo Lindqvist', what: 'Proposed: move F-112 Seat-based invoices to rank 2', when: '11:42 AM', undo: true }, // MOCK-HOOK
  { who: 'Theo Lindqvist', what: 'Proposed: set F-88 Quiet hours for alerts to Done', when: '11:31 AM', undo: true }, // MOCK-HOOK
  { who: 'Theo Lindqvist', what: 'Proposed: cut F-64 In-app tour from the roadmap', when: '9:15 AM', undo: true }, // MOCK-HOOK
]; // MOCK-HOOK
