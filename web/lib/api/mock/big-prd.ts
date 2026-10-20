/**
 * The big-PRD scenario (po-mock-scenario=big-prd): one fictional PRD of 100+ sections in
 * nested chapters, with mixed review states, comments and Oracle suggestions, for the PRD
 * page's outline rail, section switcher and review panel (I3 PRD navigation, 2026-10-20).
 */
import type { DocumentSeed, SectionSeed } from "./fixtures";

export const BIG_PRD_SLUG = "platform-handbook";

const CHAPTERS: { title: string; parts: (string | [string, string[]])[] }[] = [
  { title: "Goals and outcomes", parts: ["Goal trace", "North-star metric", "Guardrail metrics", "Out of scope", "Assumptions"] },
  {
    title: "Problem",
    parts: ["Who is affected", "Evidence from support", "Evidence from sales calls", ["Funnel numbers", ["Sign-up", "Activation", "Retention"]], "Why now"],
  },
  { title: "Users and jobs", parts: ["Workspace owner", "Billing admin", "Team member", "Guest reviewer", "Support agent", "Jobs to be done"] },
  {
    title: "Scope",
    parts: [
      "In the first release",
      "Later releases",
      ["Explicitly not doing", ["Custom roles", "Single sign-on for guests"]],
      "Dependencies on other teams",
      "Open scope questions",
    ],
  },
  {
    title: "Workspace setup",
    parts: ["Create a workspace", "Name and address", "Invite the first members", ["Import from a spreadsheet", ["Column mapping", "Duplicate rows", "Error report"]], "Default settings"],
  },
  {
    title: "Members and roles",
    parts: ["Owner", "Approver", "Commenter", "Viewer", "Changing a role", "Removing a member and what happens to their approvals"],
  },
  {
    title: "Billing",
    parts: ["Plans", "Seats", ["Invoices", ["Invoice numbering", "Tax lines", "Credit notes"]], "Failed payments", "Refunds"],
  },
  { title: "Notifications", parts: ["Email digest", "In-app inbox", "Mobile push", "Quiet hours", "Unsubscribe rules"] },
  {
    title: "Search and navigation",
    parts: ["Global search", "Recent items", ["Filters", ["By owner", "By state", "By date"]], "Keyboard shortcuts", "Empty states"],
  },
  { title: "Integrations", parts: ["Calendar", "Chat", "Issue tracker", "Webhooks", "Public API limits"] },
  {
    title: "Security and privacy",
    parts: ["Data residency", "Audit log", ["Retention", ["Deleted workspaces", "Exports"]], "Access reviews", "Incident response"],
  },
  { title: "Rollout and success", parts: ["Beta cohort", "Launch checklist", "Success metrics", "Risks and open questions", "Decision log"] },
];

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

function body(heading: string, i: number): string {
  return [
    `${heading} covers what the first release must do and how we will know it works.`,
    i % 3 === 0 ? "- Owners can see the state at a glance\n- Every change is recorded with who made it\n- Nothing is lost on reload" : "",
    i % 4 === 0 ? `The team measured this in September: ${10 + (i % 17)}% of new workspaces stall here.` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** A long section: the review panel and the card must stay usable with it open. */
const LONG_BODY = Array.from(
  { length: 40 },
  (_, i) => `Paragraph ${i + 1}. The import keeps every row it can read and reports the rest with the reason, so an owner can fix the file and import again without starting over.`,
).join("\n\n");

function sections(): SectionSeed[] {
  const out: SectionSeed[] = [{ key: "title", level: 1, heading: "Platform handbook PRD", body: "One workspace for every team: setup, members, billing and the rest." }];
  let i = 0;
  CHAPTERS.forEach((ch, c) => {
    const chKey = `ch-${c + 1}`;
    out.push({ key: chKey, level: 2, heading: `${c + 1}. ${ch.title}`, body: body(ch.title, i++) });
    ch.parts.forEach((part, p) => {
      const [name, kids] = typeof part === "string" ? [part, []] : part;
      const key = `${c + 1}-${p + 1}-${slug(name)}`;
      out.push({ key, level: 3, heading: `${c + 1}.${p + 1} ${name}`, body: key === "5-4-import-from-a-spreadsheet" ? LONG_BODY : body(name, i++) });
      kids.forEach((kid, k) => {
        out.push({ key: `${key}-${k + 1}`, level: 4, heading: `${c + 1}.${p + 1}.${k + 1} ${kid}`, body: body(kid, i++) });
      });
    });
  });
  // Pad to well over 100 sections with an appendix of glossary entries.
  out.push({ key: "appendix", level: 2, heading: "Appendix: glossary", body: "Terms used in this document." });
  const terms = ["Workspace", "Seat", "Approver", "Digest", "Residency", "Cohort", "Guardrail", "Webhook", "Audit entry", "Quiet hours", "Credit note", "Guest"];
  terms.forEach((t, k) => out.push({ key: `glossary-${slug(t)}`, level: 3, heading: `A.${k + 1} ${t}`, body: `${t}: as used in this document.` }));
  return out;
}

export const BIG_PRD: DocumentSeed = {
  slug: BIG_PRD_SLUG,
  title: "Platform handbook PRD",
  template: "oracle-default",
  template_version: "1",
  versions: [{ number: 1, created_at: "2026-10-19T09:00:00Z", snapshot: "2026-10-19T08:55Z", sections: sections(), citations: [] }],
};

/** Review state of the seed: verdicts by section key. */
export const BIG_PRD_REVIEWS: Record<string, { verdict: "approved" | "changes_requested" | "rejected"; note: string | null }> = {
  title: { verdict: "approved", note: null },
  "ch-1": { verdict: "approved", note: null },
  "1-1-goal-trace": { verdict: "approved", note: null },
  "1-2-north-star-metric": { verdict: "approved", note: null },
  "1-3-guardrail-metrics": { verdict: "changes_requested", note: "Add a refund-rate guardrail." },
  "1-4-out-of-scope": { verdict: "approved", note: null },
  "1-5-assumptions": { verdict: "rejected", note: "These are wishes, not assumptions; list what we checked." },
  "ch-2": { verdict: "approved", note: null },
  "2-1-who-is-affected": { verdict: "approved", note: null },
  "2-4-funnel-numbers-1": { verdict: "changes_requested", note: "Say which month the sign-up figure is from." },
  "3-2-billing-admin": { verdict: "approved", note: null },
  "6-6-removing-a-member-and-what-happens-to-their-approvals": { verdict: "changes_requested", note: "Say what happens to pending approvals." },
  "7-3-invoices-2": { verdict: "rejected", note: "Tax lines are handled by the billing provider." },
};

/** Comments by section key: [quote, comment]. */
export const BIG_PRD_COMMENTS: [string, string, string][] = [
  ["1-3-guardrail-metrics", "Guardrail metrics covers what the first release must do", "Which guardrail stops the rollout?"],
  ["2-2-evidence-from-support", "Evidence from support covers", "Link the support tickets here."],
  ["2-2-evidence-from-support", "how we will know it works", "How many tickets is 'most'?"],
  ["4-3-explicitly-not-doing", "Explicitly not doing covers", "Big customers will ask for SSO for guests."],
  ["5-4-import-from-a-spreadsheet", "Paragraph 1. The import keeps every row it can read", "What is the row limit?"],
  ["5-4-import-from-a-spreadsheet", "Paragraph 12. The import keeps every row", "Can an owner undo an import?"],
  ["6-5-changing-a-role", "Changing a role covers", "Who is notified when a role changes?"],
  ["8-4-quiet-hours", "Quiet hours covers", "Quiet hours should follow the member's time zone."],
  ["9-4-keyboard-shortcuts", "Keyboard shortcuts covers", "List the shortcuts in a table."],
  ["12-3-success-metrics", "Success metrics covers", "Add the target for week-4 retention."],
];

/** Oracle's suggestions on some of those comments: the comment's text, then the suggestion. */
export const BIG_PRD_SUGGESTIONS: { comment: string; status: "open" | "accepted" | "dismissed"; text: string; rationale: string }[] = [
  {
    comment: "Link the support tickets here.",
    status: "open",
    text: "Evidence from support: 41 tickets in September asked for shared workspaces; the top five are linked in Sources.",
    rationale: "The reviewer asks for the evidence; the count and the links answer it.",
  },
  {
    comment: "What is the row limit?",
    status: "open",
    text: "An import reads up to 5,000 rows; a larger file is refused with the limit named.",
    rationale: "States the limit the import already enforces.",
  },
  {
    comment: "Who is notified when a role changes?",
    status: "accepted",
    text: "The member whose role changed and the workspace owners are notified by email and in the inbox.",
    rationale: "Names who is told, as asked.",
  },
  {
    comment: "Quiet hours should follow the member's time zone.",
    status: "dismissed",
    text: "Quiet hours follow each member's time zone.",
    rationale: "Matches the request.",
  },
];
