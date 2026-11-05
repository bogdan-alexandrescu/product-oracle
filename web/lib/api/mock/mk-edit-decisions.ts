// MOCK-HOOK: this whole file is mock data for the mk-edit-decisions mock-ups (never merged).
// MOCK-HOOK: invented text only; the fields Detailed's decision inspector reads (question, context, options, review date).

export type MkDecisionFields = { question: string; context: string; options: string[]; review_on: string }; // MOCK-HOOK

/** The long one: the hard case (many options, a long context). */ // MOCK-HOOK
export const MK_LONG: MkDecisionFields = { // MOCK-HOOK
  question: "Which regions get the shared inbox first, and do we hold the launch until the data-residency review for the second wave is signed off by the reviewers in every region?", // MOCK-HOOK
  context:
    "Support teams in three regions asked for the shared inbox this quarter. The residency review covers storage only; search indexes and exports are still open. Sales has two pilots waiting on a date, and the help-centre team needs four weeks to write the guides once the regions are fixed.", // MOCK-HOOK
  options: [ // MOCK-HOOK
    "North America first, Europe six weeks later", // MOCK-HOOK
    "All three regions together after the review", // MOCK-HOOK
    "Europe first, where the pilots are", // MOCK-HOOK
    "North America and Asia Pacific now, Europe after the review", // MOCK-HOOK
    "Pilot customers only, every region, behind a switch", // MOCK-HOOK
    "Wait a quarter and ship with search and exports", // MOCK-HOOK
  ], // MOCK-HOOK
  review_on: "2026-12-14", // MOCK-HOOK
}; // MOCK-HOOK

const BY_TITLE: Record<string, MkDecisionFields> = { // MOCK-HOOK
  "Ship usage caps before anomaly detection": { // MOCK-HOOK
    question: "Do caps wait for detection?", // MOCK-HOOK
    context: "Finance asks for caps; detection adds early warning only.", // MOCK-HOOK
    options: ["Caps first", "Ship together"], // MOCK-HOOK
    review_on: "2026-11-30", // MOCK-HOOK
  }, // MOCK-HOOK
}; // MOCK-HOOK

/** A decision's fields beside its row (the API's GET /v1/decisions/{decision} carries them). */ // MOCK-HOOK
export function mkDecisionFields(title: string): MkDecisionFields { // MOCK-HOOK
  return BY_TITLE[title] ?? { question: `${title}?`, context: "Raised in the weekly product review.", options: ["Yes, this quarter", "Not now"], review_on: "2026-12-01" }; // MOCK-HOOK
} // MOCK-HOOK

/** Extra open decisions so the list has a realistic volume (and one long one). */ // MOCK-HOOK
export const MK_EXTRA_DECISIONS = [ // MOCK-HOOK
  { title: "Roll out the shared inbox by region or all at once", long: true, approver: "Priya Nair" }, // MOCK-HOOK
  { title: "Keep the free plan's five-seat limit", long: false, approver: "Sam Okafor" }, // MOCK-HOOK
  { title: "Move the billing page into Settings", long: false, approver: "Lena Ortiz" }, // MOCK-HOOK
]; // MOCK-HOOK

/** People a decision can be reassigned to (invented). */ // MOCK-HOOK
export const MK_PEOPLE = ["Priya Nair", "Sam Okafor", "Lena Ortiz", "Jonas Berg", "Mei Tanaka", "Ravi Shah"]; // MOCK-HOOK

/** The long question: the hard case for questions (long text, many answers). */ // MOCK-HOOK
export const MK_LONG_Q = { // MOCK-HOOK
  title: "When a team has more than one workspace, which workspace's quiet hours and alert limits apply to a person who belongs to several of them?", // MOCK-HOOK
  recommendation: "The workspace the alert comes from; a person's own quiet hours always win over a workspace's", // MOCK-HOOK
  options: ["The person's home workspace", "The strictest of all their workspaces", "Each person picks one in Settings", "The team owner picks one for everyone", "Ask the person the first time it happens"], // MOCK-HOOK
}; // MOCK-HOOK
