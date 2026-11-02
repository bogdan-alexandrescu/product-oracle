// MOCK-HOOK: the whole file. Mock-ups for "Starting a PRD from Simple" (NP1): invented data only.

/** One of the brief's questions Oracle asks before it drafts, with the answer each mock-up state shows. */
export type NewPrdQuestion = {
  id: string;
  text: string;
  /** Why Oracle asks, in one line. */
  why: string;
  answer: string | null;
  /** The person picked "I don't know". */
  unknown?: boolean;
  /** The person sent the question to someone to answer later. */
  later?: string;
};

// MOCK-HOOK
export const NEWPRD = {
  title: "Shared shopping lists",
  problem: "People who shop for a household keep separate lists, so they buy the same things twice and forget others.",
  who: "Households of two or more people who shop each week",
  goal: "Raise activation",
  goalPath: "From 31% · now 38% · target 45%",
  questions: [
    {
      id: "q1",
      text: "Who should get it first?",
      why: "So the draft says who the first release is for.",
      answer: "Households where a second person already joined, about 4,200 of them.",
    },
    {
      id: "q2",
      text: "How will you know it worked?",
      why: "The draft needs one number to watch.",
      answer: "More new households add a second person in their first week: from 18% to 30%.",
    },
    {
      id: "q3",
      text: "What could stop this from shipping at all?",
      why: "The draft lists what it waits on.",
      answer: "Lists need the new household sign-in, planned for next month.",
    },
    {
      id: "q4",
      text: "Is there a date it must ship by?",
      why: "A date changes what fits in the first release.",
      answer: null,
      unknown: true,
    },
    {
      id: "q5",
      text: "Which teams must agree before it ships?",
      why: "The draft lists who signs off.",
      answer: null,
      later: "Priya Raman",
    },
    {
      id: "q6",
      text: "Is there anything a shared list must never show to the other person?",
      why: "Privacy limits go in the draft's rules.",
      answer: "Nothing from a person's own private list, and no prices they paid.",
    },
  ] as NewPrdQuestion[],
  /** The answer the typing frame shows, cut short as if still being typed. */
  typing: "More new households add a second person in their first we",
  /** The people "Ask someone later" offers. */
  people: ["Priya Raman", "Theo Brandt", "Lena Ortiz", "Jonas Weber", "Mei Tanaka"],
  /** The new PRD, as the One-pagers list and Home show it once it drafts. */
  made: {
    slug: "shared-shopping-lists",
    status: "Drafting",
    eta: "Ready in about 4 minutes",
    started: "Started Oct 22, 2:14 PM",
  },
  /** What the chat (option d) says. */
  chat: {
    what: "What should it be about? Say it in a line or two, and I fill in the rest.",
    ask: "Start a PRD for shared shopping lists, so a household keeps one list.",
    guess:
      "Here is what I took from your message. Change what is wrong; then I ask six short questions and draft.",
  },
};
