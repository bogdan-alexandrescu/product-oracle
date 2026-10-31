// MOCK-HOOK: the whole file. Mock-ups only (mk-agentqs, decision AQ1): the questions a run's
// agents asked the owner at the Saved addresses feature-set stop, invented people and text.

/** One option an agent offered. */
export type AgentOption = { key: string; label: string; detail: string }; // MOCK-HOOK

/** A question an agent (analyst, architect) asked during a run step. */
export type AgentQuestion = { // MOCK-HOOK
  id: string; // MOCK-HOOK
  role: "analyst" | "architect"; // MOCK-HOOK
  /** The feature it concerns, or null for the whole set. */
  feature: string | null; // MOCK-HOOK
  question: string; // MOCK-HOOK
  /** Why the agent asks: what it could not find. */
  why: string; // MOCK-HOOK
  options: AgentOption[]; // MOCK-HOOK
  recommended: string; // MOCK-HOOK
  answer: { option: string; by: string; at: string; note?: string } | null; // MOCK-HOOK
}; // MOCK-HOOK

/** Where answers go: the step after this stop, which reads them with the decision. */
export const AGENT_QS_NEXT_STEP = "Design"; // MOCK-HOOK
export const AGENT_QS_STOP = "Feature set"; // MOCK-HOOK
export const AGENT_QS_RUN = "Saved addresses PRD"; // MOCK-HOOK

const BASE: AgentQuestion[] = [ // MOCK-HOOK
  { // MOCK-HOOK
    id: "aq-1", // MOCK-HOOK
    role: "architect", // MOCK-HOOK
    feature: "saved-addresses", // MOCK-HOOK
    question: "Does a way to send an address to the courier exist already, or do we build it?", // MOCK-HOOK
    why: "The design needs a send path to the courier. I found a half-built one in the order service but no tests and no caller.", // MOCK-HOOK
    options: [ // MOCK-HOOK
      { key: "reuse", label: "Reuse the order service path", detail: "About 3 days. Needs tests first; nobody owns it today." }, // MOCK-HOOK
      { key: "build", label: "Build a new send path", detail: "About 8 days. Clean, owned by the checkout team." }, // MOCK-HOOK
      { key: "later", label: "Leave sending out for now", detail: "Addresses are saved but typed again at the courier." }, // MOCK-HOOK
    ], // MOCK-HOOK
    recommended: "reuse", // MOCK-HOOK
    answer: null, // MOCK-HOOK
  }, // MOCK-HOOK
  { // MOCK-HOOK
    id: "aq-2", // MOCK-HOOK
    role: "analyst", // MOCK-HOOK
    feature: "bulk-edit", // MOCK-HOOK
    question: "Who edits addresses in bulk: shop staff, or the shoppers themselves?", // MOCK-HOOK
    why: "The interviews mention both. The answer changes who sees the import screen.", // MOCK-HOOK
    options: [ // MOCK-HOOK
      { key: "staff", label: "Shop staff only", detail: "One import screen in the admin." }, // MOCK-HOOK
      { key: "both", label: "Staff and shoppers", detail: "Two screens; shoppers get a simpler one." }, // MOCK-HOOK
    ], // MOCK-HOOK
    recommended: "staff", // MOCK-HOOK
    answer: null, // MOCK-HOOK
  }, // MOCK-HOOK
  { // MOCK-HOOK
    id: "aq-3", // MOCK-HOOK
    role: "analyst", // MOCK-HOOK
    feature: null, // MOCK-HOOK
    question: "Should the set count addresses outside the country, or home addresses only?", // MOCK-HOOK
    why: "Two goals disagree: paid conversion wants every country, early churn names home orders only.", // MOCK-HOOK
    options: [ // MOCK-HOOK
      { key: "home", label: "Home addresses only", detail: "Smaller set; abroad comes in a later PRD." }, // MOCK-HOOK
      { key: "all", label: "Every country", detail: "Adds postcode rules for 14 countries." }, // MOCK-HOOK
    ], // MOCK-HOOK
    recommended: "home", // MOCK-HOOK
    answer: { option: "home", by: "Mara Lindqvist", at: "Oct 17, 10:12" }, // MOCK-HOOK
  }, // MOCK-HOOK
  { // MOCK-HOOK
    id: "aq-4", // MOCK-HOOK
    role: "architect", // MOCK-HOOK
    feature: "address-lookup", // MOCK-HOOK
    question: "Keep the current postcode lookup provider, or move to the one the warehouse uses?", // MOCK-HOOK
    why: "The current contract ends in March; the warehouse provider answers faster in my test.", // MOCK-HOOK
    options: [ // MOCK-HOOK
      { key: "keep", label: "Keep the current provider", detail: "No work now; decide again in March." }, // MOCK-HOOK
      { key: "move", label: "Move to the warehouse provider", detail: "About 4 days; one provider for everything." }, // MOCK-HOOK
    ], // MOCK-HOOK
    recommended: "keep", // MOCK-HOOK
    answer: null, // MOCK-HOOK
  }, // MOCK-HOOK
]; // MOCK-HOOK

/** The hard case: a long run whose agents asked many questions, some long. */
const MORE: AgentQuestion[] = [ // MOCK-HOOK
  ["analyst", "address-labels", "Are labels free text, or a fixed list (Home, Work, Other)?", "free", "Free text", "fixed", "A fixed list"], // MOCK-HOOK
  ["architect", "pick-address", "Show the saved addresses as a list or as a single picker with the last one used already chosen, given that most shoppers on phones have exactly one address?", "picker", "One picker, last used chosen", "list", "A list of every address"], // MOCK-HOOK
  ["analyst", "address-edit", "When an address is edited, do orders already placed keep the old one?", "keep", "Placed orders keep the old address", "update", "Placed orders follow the edit"], // MOCK-HOOK
  ["architect", "delivery-notes", "Store delivery notes with the address or with each order?", "address", "With the address", "order", "With each order"], // MOCK-HOOK
  ["analyst", null, "Is the deadline the holiday sale on Dec 11, or is a January date acceptable?", "dec", "Dec 11, cut what does not fit", "jan", "January, keep the whole set"], // MOCK-HOOK
  ["architect", "saved-addresses", "How many addresses may one account keep?", "ten", "Up to 10", "any", "No limit"], // MOCK-HOOK
  ["analyst", "bulk-edit", "Import from a spreadsheet file, or paste rows into a box?", "file", "A spreadsheet file", "paste", "Paste rows"], // MOCK-HOOK
].map(([role, feature, question, a, al, b, bl], i) => ({ // MOCK-HOOK
  id: `aq-${i + 5}`, // MOCK-HOOK
  role: role as "analyst" | "architect", // MOCK-HOOK
  feature, // MOCK-HOOK
  question: question as string, // MOCK-HOOK
  why: "Nothing in the baseline or the interviews says; both ways change the requirements.", // MOCK-HOOK
  options: [ // MOCK-HOOK
    { key: a as string, label: al as string, detail: "The agent's pick." }, // MOCK-HOOK
    { key: b as string, label: bl as string, detail: "More work in this PRD." }, // MOCK-HOOK
  ], // MOCK-HOOK
  recommended: a as string, // MOCK-HOOK
  answer: i === 2 ? { option: a as string, by: "Tomás Reyes", at: "Oct 17, 11:40" } : null, // MOCK-HOOK
})); // MOCK-HOOK

/** The questions for a mock-up: `many` adds the hard case's seven more. */
export function agentQuestions(many: boolean): AgentQuestion[] { // MOCK-HOOK
  return many ? [...BASE, ...MORE] : BASE; // MOCK-HOOK
} // MOCK-HOOK

/** Feature titles of the scope-review set, for a question's "About". */
export const AGENT_QS_FEATURES: Record<string, string> = { // MOCK-HOOK
  "saved-addresses": "Saved addresses", // MOCK-HOOK
  "address-lookup": "Address lookup", // MOCK-HOOK
  "bulk-edit": "Bulk edit", // MOCK-HOOK
  "address-labels": "Address labels", // MOCK-HOOK
  "pick-address": "Pick address in one step", // MOCK-HOOK
  "address-edit": "Edit a saved address", // MOCK-HOOK
  "delivery-notes": "Delivery notes", // MOCK-HOOK
}; // MOCK-HOOK
