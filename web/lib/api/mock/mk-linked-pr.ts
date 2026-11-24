// MOCK-HOOK (whole file): mk-linked-pr mock-ups (LP1..LP3). Invented pull requests for the
// invented company's features; local only, on a throwaway branch that is never merged.

export type MkPrState = 'open' | 'merged' | 'closed' | 'gone'; // MOCK-HOOK
export type MkPr = {
  n: number;
  title: string;
  state: MkPrState;
  by: string;
  when: string;
  /** 'code': found by the feature's code in its title or body; 'link': linked by a person. */
  via: 'code' | 'link';
}; // MOCK-HOOK

export const MK_REPO = 'alertly/web'; // MOCK-HOOK

/** LP1: what each feature has linked before the owner links one more. */ // MOCK-HOOK
export const MK_PRS_LP1: Record<string, MkPr[]> = {
  'Weekly alert digest': [
    {
      n: 482,
      title: 'F-79 Digest email layout',
      state: 'merged',
      by: 'Theo Brandt',
      when: 'Nov 12',
      via: 'code',
    },
    {
      n: 491,
      title: "Send the digest at 8 AM in each reader's time zone",
      state: 'open',
      by: 'Lena Ortiz',
      when: 'Nov 18',
      via: 'link',
    },
  ],
  'Setup checklist': [
    {
      n: 455,
      title: 'F-01 Checklist card on Home',
      state: 'open',
      by: 'Priya Raman',
      when: 'Nov 20',
      via: 'code',
    },
  ],
  'Alert rules engine': [
    {
      n: 462,
      title: 'Rules table and first rule types',
      state: 'merged',
      by: 'Theo Brandt',
      when: 'Nov 3',
      via: 'link',
    },
    {
      n: 470,
      title: 'Rule editor with thresholds and quiet hours',
      state: 'open',
      by: 'Lena Ortiz',
      when: 'Nov 21',
      via: 'link',
    },
    {
      n: 468,
      title: 'Try a rules engine library',
      state: 'closed',
      by: 'Theo Brandt',
      when: 'Nov 9',
      via: 'link',
    },
  ],
}; // MOCK-HOOK

/** LP1: the code host's recent pull requests not linked yet (the picker's list). */ // MOCK-HOOK
export const MK_CANDIDATES: MkPr[] = [
  {
    n: 503,
    title: 'Unsubscribe link in the digest footer',
    state: 'open',
    by: 'Lena Ortiz',
    when: 'Nov 23',
    via: 'link',
  },
  {
    n: 502,
    title: 'Digest preview in settings',
    state: 'open',
    by: 'Priya Raman',
    when: 'Nov 23',
    via: 'link',
  },
  {
    n: 501,
    title: 'Quiet hours on weekends for alert rules',
    state: 'open',
    by: 'Theo Brandt',
    when: 'Nov 22',
    via: 'link',
  },
  {
    n: 500,
    title: 'Bump the chart library to 5.2',
    state: 'merged',
    by: 'Theo Brandt',
    when: 'Nov 22',
    via: 'link',
  },
  {
    n: 499,
    title: 'Fix the flaky sign-in test',
    state: 'merged',
    by: 'Priya Raman',
    when: 'Nov 21',
    via: 'link',
  },
]; // MOCK-HOOK

/** The hard case: a feature built over many pull requests, some with long titles. */ // MOCK-HOOK
export const MK_MANY: MkPr[] = [
  {
    n: 482,
    title: 'F-79 Digest email layout',
    state: 'merged',
    by: 'Theo Brandt',
    when: 'Nov 12',
    via: 'code',
  },
  {
    n: 485,
    title: 'F-79 Digest builder: group alerts by team, then by rule, then by the hour they fired',
    state: 'merged',
    by: 'Lena Ortiz',
    when: 'Nov 13',
    via: 'code',
  },
  {
    n: 487,
    title: 'Digest send queue',
    state: 'closed',
    by: 'Theo Brandt',
    when: 'Nov 14',
    via: 'link',
  },
  {
    n: 488,
    title: 'Digest send queue with retries and a daily cap per company',
    state: 'merged',
    by: 'Theo Brandt',
    when: 'Nov 15',
    via: 'link',
  },
  {
    n: 491,
    title: "Send the digest at 8 AM in each reader's time zone",
    state: 'open',
    by: 'Lena Ortiz',
    when: 'Nov 18',
    via: 'link',
  },
  {
    n: 493,
    title: 'F-79 Plain-text version of the digest for mail apps that block pictures',
    state: 'merged',
    by: 'Priya Raman',
    when: 'Nov 19',
    via: 'code',
  },
  {
    n: 495,
    title: 'F-79 Digest settings page',
    state: 'open',
    by: 'Priya Raman',
    when: 'Nov 20',
    via: 'code',
  },
  {
    n: 497,
    title: 'Track opens and clicks in the digest',
    state: 'open',
    by: 'Lena Ortiz',
    when: 'Nov 21',
    via: 'link',
  },
  {
    n: 503,
    title: 'Unsubscribe link in the digest footer',
    state: 'open',
    by: 'Lena Ortiz',
    when: 'Nov 23',
    via: 'link',
  },
]; // MOCK-HOOK

/** LP2: the digest's pull requests all merged (the last one on Nov 23), so Oracle suggests Done. */ // MOCK-HOOK
export const MK_PRS_LP2: Record<string, MkPr[]> = {
  'Weekly alert digest': [
    {
      n: 482,
      title: 'F-79 Digest email layout',
      state: 'merged',
      by: 'Theo Brandt',
      when: 'Nov 12',
      via: 'code',
    },
    {
      n: 491,
      title: "Send the digest at 8 AM in each reader's time zone",
      state: 'merged',
      by: 'Lena Ortiz',
      when: 'Nov 18',
      via: 'link',
    },
    {
      n: 503,
      title: 'Unsubscribe link in the digest footer',
      state: 'merged',
      by: 'Lena Ortiz',
      when: 'Nov 23',
      via: 'link',
    },
  ],
  'Setup checklist': MK_PRS_LP1['Setup checklist'],
  'Alert rules engine': MK_PRS_LP1['Alert rules engine'],
  'Sample data import': [],
}; // MOCK-HOOK

/** LP2: the features Oracle suggests a status for, and why (the hard case adds more). */ // MOCK-HOOK
export type MkSuggest = {
  title: string;
  code: string | null;
  from: string;
  to: string;
  why: string;
}; // MOCK-HOOK
export const MK_SUGGESTS: MkSuggest[] = [
  {
    title: 'Weekly alert digest',
    code: 'F-79',
    from: 'Planned',
    to: 'Done',
    why: '3 of 3 pull requests merged · last Nov\u00a023',
  },
]; // MOCK-HOOK
export const MK_SUGGESTS_MANY: MkSuggest[] = [
  ...MK_SUGGESTS,
  {
    title: 'Setup checklist',
    code: 'F-01',
    from: 'Planned',
    to: 'In progress',
    why: '#455 Checklist card on Home opened Nov\u00a020',
  },
  {
    title: 'Lead list ranking',
    code: 'F-103',
    from: 'Planned',
    to: 'In progress',
    why: '#504 Ranking by last reply opened Nov\u00a023',
  },
  {
    title: 'One-tap sign-up link',
    code: 'F-101',
    from: 'In progress',
    to: 'Done',
    why: '2 of 2 pull requests merged · last Nov\u00a022',
  },
]; // MOCK-HOOK

/** LP3: a link that no longer resolves (deleted, moved, or access removed). */ // MOCK-HOOK
export const MK_GONE: MkPr = {
  n: 466,
  title: '#466',
  state: 'gone',
  by: '',
  when: 'Nov 8',
  via: 'link',
}; // MOCK-HOOK
