/**
 * AQ1 Cards atop the review, as oracle.runs.agent_questions: the questions a run's agents asked
 * at a stop (the segment's agent_questions.yaml), each with its options and the agent's pick,
 * and the answers the stop's approver role or above gives until it is decided. Invented people
 * and text: the "scope-review" scenario's Saved addresses PRD at its feature set.
 */
import type { Schemas } from "@/lib/api/client";

type Question = Schemas["AgentQuestionOut"];
type Person = Schemas["ReviewPerson"];

/** A stored question: its answer keeps who gave it by id, `mine` is worked out per reader. */
export type StoredAgentQuestion = Omit<Question, "answer"> & {
  answer: { option: string; note: string | null; by: Person | null; at: string } | null;
};

const opt = (key: string, label: string, detail: string) => ({ key, label, detail });

/** The three open questions and one answered by someone else (the frames' "rest"). */
function base(other: Person): StoredAgentQuestion[] {
  return [
    {
      id: "q1",
      role: "architect",
      feature: "saved-addresses",
      question: "Does a way to send an address to the courier exist already, or do we build it?",
      why: "The design needs a send path to the courier. I found a half-built one in the order service but no tests and no caller.",
      options: [
        opt("reuse", "Reuse the order service path", "About 3 days. Needs tests first; nobody owns it today."),
        opt("build", "Build a new send path", "About 8 days. Clean, owned by the checkout team."),
        opt("later", "Leave sending out for now", "Addresses are saved but typed again at the courier."),
      ],
      recommended: "reuse",
      answer: null,
    },
    {
      id: "q2",
      role: "analyst",
      feature: "bulk-edit",
      question: "Who edits addresses in bulk: shop staff, or the shoppers themselves?",
      why: "The interviews mention both. The answer changes who sees the import screen.",
      options: [opt("staff", "Shop staff only", "One import screen in the admin."), opt("both", "Staff and shoppers", "Two screens; shoppers get a simpler one.")],
      recommended: "staff",
      answer: null,
    },
    {
      id: "q3",
      role: "analyst",
      feature: null,
      question: "Should the set count addresses outside the country, or home addresses only?",
      why: "Two goals disagree: paid conversion wants every country, early churn names home orders only.",
      options: [opt("home", "Home addresses only", "Smaller set; abroad comes in a later PRD."), opt("all", "Every country", "Adds postcode rules for 14 countries.")],
      recommended: "home",
      answer: { option: "home", note: null, by: other, at: "2026-10-17T17:12:00Z" },
    },
    {
      id: "q4",
      role: "architect",
      feature: "address-lookup",
      question: "Keep the current postcode lookup provider, or move to the one the warehouse uses?",
      why: "The current contract ends in March; the warehouse provider answers faster in my test.",
      options: [opt("keep", "Keep the current provider", "No work now; decide again in March."), opt("move", "Move to the warehouse provider", "About 4 days; one provider for everything.")],
      recommended: "keep",
      answer: null,
    },
  ];
}

/** The hard case: a long run whose agents asked eleven questions, some long. */
function more(other: Person): StoredAgentQuestion[] {
  const rows: [string, string | null, string, string, string, string, string][] = [
    ["analyst", "address-labels", "Are labels free text, or a fixed list (Home, Work, Other)?", "free", "Free text", "fixed", "A fixed list"],
    ["architect", "pick-address", "Show the saved addresses as a list or as a single picker with the last one used already chosen, given that most shoppers on phones have exactly one address?", "picker", "One picker, last used chosen", "list", "A list of every address"],
    ["analyst", "address-edit", "When an address is edited, do orders already placed keep the old one?", "keep", "Placed orders keep the old address", "update", "Placed orders follow the edit"],
    ["architect", null, "Store delivery notes with the address or with each order?", "address", "With the address", "order", "With each order"],
    ["analyst", null, "Is the deadline the holiday sale on Dec 11, or is a January date acceptable?", "dec", "Dec 11, cut what does not fit", "jan", "January, keep the whole set"],
    ["architect", "saved-addresses", "How many addresses may one account keep?", "ten", "Up to 10", "any", "No limit"],
    ["analyst", "bulk-edit", "Import from a spreadsheet file, or paste rows into a box?", "file", "A spreadsheet file", "paste", "Paste rows"],
  ];
  return rows.map(([role, feature, question, a, al, b, bl], i) => ({
    id: `q${i + 5}`,
    role,
    feature,
    question,
    why: "Nothing in the baseline or the interviews says; both ways change the requirements.",
    options: [opt(a, al, "The agent's pick."), opt(b, bl, "More work in this PRD.")],
    recommended: a,
    answer: i === 2 ? { option: a, note: null, by: other, at: "2026-10-17T18:40:00Z" } : null,
  }));
}

/** The questions a scenario seeds at the feature set: `many` adds the hard case's seven. */
export function seedAgentQuestions(many: boolean): StoredAgentQuestion[] {
  const mara: Person = { id: null, name: "Mara Lindqvist", role: "approver" };
  const tomas: Person = { id: null, name: "Tomás Reyes", role: "approver" };
  return many ? [...base(mara), ...more(tomas)] : base(mara);
}

/** GET …/agent-questions as the API answers it, for the member `me`. */
export function agentQuestionsOut(stored: StoredAgentQuestion[], me: string | null, nextStep: string | null, canAnswer: boolean): Schemas["AgentQuestionsOut"] {
  return {
    questions: stored.map((q) => ({ ...q, answer: q.answer ? { ...q.answer, mine: q.answer.by?.id != null && q.answer.by.id === me } : null })),
    next_step: nextStep,
    can_answer: canAnswer,
  };
}
