/**
 * Generic, fictional PRD drafts used by mock mode (NEXT_PUBLIC_API_MOCKS=1).
 * No real company, product or customer names: this repository is public.
 */

import { PRODUCT_CHAT_ID, seededItemId } from "./ids";

export type CitationSeed = {
  id: string;
  source: "slack" | "notion" | "gdocs" | "github" | "fireflies" | "upload" | "web" | "oracle";
  ref: string;
  title: string;
  excerpt: string;
  retrieved_at: string;
  /** E1: a source an edit added to a spec version (listed under "Added sources"). */
  added?: boolean;
  state_label?: string;
  /** What the writer computed (change D): the source item it read, its confidence 0-1 or a note. */
  item?: string;
  confidence?: number | null;
  confidence_note?: string;
  low_confidence?: boolean;
};

export type SectionSeed = { key: string; level: number; heading: string; body: string };

export type VersionSeed = {
  number: number;
  created_at: string;
  snapshot?: string;
  sections: SectionSeed[];
  citations: CitationSeed[];
  /** Front matter `brief: [...]` (O1f); without it a "Full version {#full}" heading splits the layers. */
  brief?: string[];
  /** Provenance (O4b): the PRD version a roadmap version was built from. */
  source?: { slug: string; version: number };
  /** Who imported it (#256); the agent-track API token by default. */
  by?: { id: string; name: string };
};

export type DocumentSeed = {
  slug: string;
  title: string;
  kind?: "prd" | "roadmap" | "spec" | "vision" | "strategy" | "update";
  /** A spec's depth: a technical brief or a full engineering spec (E1). */
  depth?: "brief" | "full";
  template?: string;
  template_version?: string;
  theme?: string;
  versions: VersionSeed[];
};

const CHECKOUT_CITATIONS: CitationSeed[] = [
  {
    id: "c1",
    source: "slack",
    ref: "https://example.slack.com/archives/C0PRODUCT/p1700000000",
    title: "#product thread on checkout drop-off",
    excerpt: "Most users who abandon do it at the shipping step, usually right after the cost appears.",
    retrieved_at: "2026-10-16T13:10:00Z",
    confidence: 0.82,
  },
  {
    id: "c2",
    source: "fireflies",
    ref: "https://app.example-notes.com/view/customer-interview-07",
    title: "Customer interview 07 (transcript)",
    excerpt: "I didn't know what shipping would cost until the last screen, so I went back to compare.",
    retrieved_at: "2026-10-15T09:42:00Z",
    confidence: 0.35,
    confidence_note: "one interview, not corroborated",
    low_confidence: true,
  },
  {
    id: "c3",
    source: "notion",
    ref: "https://www.notion.so/example/Q4-goals-0000000000",
    title: "Q4 goals: activation and retention",
    excerpt: "G1: raise first-order completion from 61% to 70% by the end of Q4.",
    retrieved_at: "2026-10-14T16:05:00Z",
    // No score: the note shows instead. Its angle brackets are text, never markup.
    confidence: null,
    confidence_note: "owner decision (confirmed, locked) <G1>; not evidence-scored",
  },
  {
    id: "c4",
    source: "github",
    ref: "https://github.com/example-org/storefront/issues/412",
    title: "Address form loses state on back navigation",
    excerpt: "Navigating back from payment clears every field in the address form.",
    retrieved_at: "2026-10-16T11:30:00Z",
    item: "7d0c6f3e-2b4a-4e8f-9c1d-3a5b7e9f1c2d",
    confidence: 0.75,
  },
  {
    id: "c5",
    source: "gdocs",
    ref: "https://docs.google.com/document/d/example-funnel-export",
    title: "Funnel export, September",
    excerpt: "Cart → shipping 82%, shipping → payment 64%, payment → confirmation 91%.",
    retrieved_at: "2026-10-16T12:00:00Z",
  },
];

const CHECKOUT_V1: SectionSeed[] = [
  {
    key: "title",
    level: 1,
    heading: "Checkout redesign PRD",
    body: "This document proposes a redesign of the web checkout so that first-time buyers can finish an order without surprises. It is written for the product, design and storefront engineering teams.",
  },
  {
    key: "goal-trace",
    level: 2,
    heading: "1. Goal trace",
    body: "Serves **G1 (activation)**: raise first-order completion from 61% to 70% by the end of Q4 [c:c3]. Every change below is expected to move completion between the cart and the confirmation page.",
  },
  {
    key: "problem",
    level: 2,
    heading: "2. Problem",
    body: "Buyers leave checkout when the total changes late in the flow. Most abandonment happens at the shipping step, right after shipping cost appears [c:c1]. Interviewed buyers describe going back to compare totals and then not returning [c:c2].\n\nThe address form also loses its state on back navigation, which turns a quick comparison into retyping the whole address [c:c4].",
  },
  {
    key: "users",
    level: 2,
    heading: "3. Users and jobs",
    body: "- **First-time buyer:** wants to know the full price before committing any personal details.\n- **Returning buyer:** wants to reuse a saved address and pay in as few steps as possible.\n- **Support agent:** wants fewer tickets about unexpected shipping charges.",
  },
  {
    key: "scope",
    level: 2,
    heading: "4. Scope",
    body: "In scope: the cart summary, the shipping step and the order review page on web.\n\nOut of scope: payment providers, the mobile apps and promotional codes. These are tracked separately.",
  },
  {
    key: "s-5",
    level: 2,
    heading: "5. Proposed flow",
    body: "The flow keeps three steps but moves every cost the buyer will pay to the first screen.",
  },
  {
    key: "s-5-1",
    level: 3,
    heading: "5.1 Cart review",
    body: "Show an estimated total, including shipping for the buyer's region, directly in the cart. The estimate uses the cheapest available option and is labelled as an estimate until an address is entered.",
  },
  {
    key: "s-5-2",
    level: 3,
    heading: "5.2 Shipping step",
    body: "Replace the free-text shipping options with three clear choices: standard, express and pickup. Each option shows its price and delivery window before it is selected.\n\nThe address form keeps its values when the buyer navigates back and forth [c:c4].",
  },
  {
    key: "metrics",
    level: 2,
    heading: "6. Success metrics",
    body: "| Metric | Baseline | Target |\n| --- | --- | --- |\n| First-order completion | 61% | 70% |\n| Shipping → payment conversion | 64% | 75% |\n\nMeasured weekly on web traffic, comparing the new flow against the current one with a 50/50 split.",
  },
  {
    key: "risks",
    level: 2,
    heading: "7. Risks and open questions",
    body: "- Showing an estimate too early may anchor buyers on a price that later changes.\n- Pickup availability differs by region; we need a fallback when no pickup point is nearby.\n- Open question: do we keep the guest checkout path unchanged during the experiment?",
  },
  {
    key: "rollout",
    level: 2,
    heading: "8. Rollout",
    body: "Release behind a flag to 10% of web traffic for one week, then 50% for two weeks before a full rollout.",
  },
];

function revise(base: SectionSeed[], edits: Record<string, Partial<SectionSeed>>): SectionSeed[] {
  return base.map((s) => ({ ...s, ...edits[s.key] }));
}

const CHECKOUT_V2: SectionSeed[] = (() => {
  const s = revise(CHECKOUT_V1, {
    problem: {
      body: "Buyers leave checkout when the total changes late in the flow. In September only 64% of buyers who reached the shipping step continued to payment [c:c5], and most abandonment happens right after shipping cost appears [c:c1]. Interviewed buyers describe going back to compare totals and then not returning [c:c2].\n\nThe address form also loses its state on back navigation, which turns a quick comparison into retyping the whole address [c:c4].",
    },
    "s-5-2": {
      body: "Replace the free-text shipping options with three clear choices: standard, express and pickup. Each option shows its price and delivery window before it is selected, and the cheapest option is preselected.\n\nThe address form keeps its values when the buyer navigates back and forth [c:c4]. Today 36% of buyers drop between shipping and payment [c:c5]; this step is where we expect most of the gain.",
    },
    metrics: {
      body: "| Metric | Baseline | Target |\n| --- | --- | --- |\n| First-order completion | 61% | 70% |\n| Shipping → payment conversion | 64% | 75% |\n| Refund rate (guardrail) | 2.1% | ≤ 2.1% |\n\nMeasured weekly on web traffic, comparing the new flow against the current one with a 50/50 split. The experiment stops early if the refund-rate guardrail is breached for two consecutive weeks.",
    },
  }).filter((x) => x.key !== "rollout");
  const added: SectionSeed = {
    key: "s-5-3",
    level: 3,
    heading: "5.3 Saved addresses",
    body: "Returning buyers see their saved addresses as cards on the shipping step. Choosing a card fills the form and recalculates the shipping options in place.",
  };
  const at = s.findIndex((x) => x.key === "s-5-2") + 1;
  s.splice(at, 0, added);
  // Risks now come before the metrics section.
  const risks = s.splice(
    s.findIndex((x) => x.key === "risks"),
    1,
  )[0];
  s.splice(
    s.findIndex((x) => x.key === "metrics"),
    0,
    risks,
  );
  return s.map((x) =>
    x.key === "risks"
      ? { ...x, heading: "6. Risks and open questions" }
      : x.key === "metrics"
        ? { ...x, heading: "7. Success metrics" }
        : x,
  );
})();

const WORKSPACES_CITATIONS: CitationSeed[] = [
  {
    id: "w1",
    source: "slack",
    ref: "https://example.slack.com/archives/C0SALES/p1700000100",
    title: "#sales-feedback: shared projects",
    excerpt: "Teams keep asking whether two people can edit the same project without exporting it.",
    retrieved_at: "2026-10-12T10:00:00Z",
  },
  {
    id: "w2",
    source: "upload",
    ref: "https://files.example.com/research/workspace-survey.pdf",
    title: "Workspace survey results (n=214)",
    excerpt: "58% of respondents share work by sending exported files to colleagues.",
    retrieved_at: "2026-10-11T15:20:00Z",
  },
  {
    id: "w3",
    source: "web",
    ref: "https://www.example.org/guides/role-based-access",
    title: "Guide: role-based access basics",
    excerpt: "Start with a small, fixed set of roles; custom roles add support cost early.",
    retrieved_at: "2026-10-12T08:45:00Z",
  },
];

const WORKSPACES_V1: SectionSeed[] = [
  {
    key: "title",
    level: 1,
    heading: "Team workspaces PRD",
    body: "Team workspaces let several people work on the same projects with shared settings and billing.",
  },
  {
    key: "problem",
    level: 2,
    heading: "1. Problem",
    body: "People share work by exporting files and sending them around [c:w2]. Requests for shared editing come up in most sales conversations with teams [c:w1].",
  },
  {
    key: "roles",
    level: 2,
    heading: "2. Roles",
    body: "Three fixed roles: **owner**, **editor** and **viewer** [c:w3]. Custom roles are out of scope for the first release.",
  },
  {
    key: "scope",
    level: 2,
    heading: "3. Scope",
    body: "- Create a workspace and invite members by email.\n- Move existing projects into a workspace.\n- One invoice per workspace.",
  },
];

const WORKSPACES_V2 = revise(WORKSPACES_V1, {
  scope: {
    body: "- Create a workspace and invite members by email or link.\n- Move existing projects into a workspace.\n- One invoice per workspace, with seats billed monthly.",
  },
});

const ALERTS_V1: SectionSeed[] = [
  {
    key: "title",
    level: 1,
    heading: "Usage alerts PRD",
    body: "Usage alerts warn account admins before they reach a plan limit, so nobody is surprised by a blocked feature.",
  },
  {
    key: "behaviour",
    level: 2,
    heading: "1. Behaviour",
    body: "Send an email and an in-app notice at 80% and 100% of each metered limit. Admins can mute alerts per limit.",
  },
  {
    key: "metrics",
    level: 2,
    heading: "2. Success metrics",
    body: "Fewer support tickets about unexpected limits, measured over the first month after release.",
  },
];

// The Quillfield clinic set (as on /design): deposits is the B1 Publish frame's PRD, held
// by a critical blocker and an unsupported third-party operation; reminders is ready.
const DEPOSITS_V1: SectionSeed[] = [
  { key: "title", level: 1, heading: "Online deposits at booking", body: "Patients pay a small deposit when they book, so fewer slots go unused." },
  { key: "problem", level: 2, heading: "1. Problem", body: "One booking in nine ends as a no-show; the slot cannot be offered again that day." },
  { key: "solution", level: 2, heading: "2. Solution", body: "Take a deposit through the booking calendar; refund it when the patient cancels in time." },
  { key: "metrics", level: 2, heading: "3. Success metrics", body: "No-show rate under 5% within two months of launch." },
];
const DEPOSITS_V2: SectionSeed[] = [
  ...DEPOSITS_V1.slice(0, 3),
  { key: "risks", level: 2, heading: "3. Risks", body: "Same-day cancellations need a same-day refund, which the card processor may not support." },
  { ...DEPOSITS_V1[3], heading: "4. Success metrics" },
];
const DEPOSITS_V3: SectionSeed[] = DEPOSITS_V2.map((s) =>
  s.key === "metrics" ? { ...s, body: "No-show rate under 5% within two months of launch; refunds within one working day." } : s,
);
const REMINDERS_V1: SectionSeed[] = [
  { key: "title", level: 1, heading: "Visit reminders", body: "A text and an email the day before each visit, with one-tap confirm or rebook." },
  { key: "problem", level: 2, heading: "1. Problem", body: "Patients forget visits booked weeks ahead; front desks spend mornings on reminder calls." },
  { key: "solution", level: 2, heading: "2. Solution", body: "Send reminders 24 hours ahead; a reply of C confirms, R opens the rebook page." },
  { key: "metrics", level: 2, heading: "3. Success metrics", body: "Reminder calls down by half; confirmations from 60% of patients." },
];

// A PRD with a brief layer (O1f): the brief first, then "Full version" and the detail
// each feature row and milestone expands.
const CARTS_CITATIONS: CitationSeed[] = [
  {
    id: "c1",
    source: "web",
    ref: "https://example.com/research/cart-abandonment-survey",
    title: "Cart abandonment survey",
    excerpt: "Shoppers who switch devices restart their cart more often than not.",
    retrieved_at: "2026-10-15T10:00:00Z",
  },
  {
    id: "c2",
    source: "gdocs",
    ref: "https://docs.google.com/document/d/example-repeat-orders",
    title: "Repeat orders, Q3 review",
    excerpt: "Repeat orders within 30 days: 18% of first-time buyers.",
    retrieved_at: "2026-10-15T10:05:00Z",
  },
];

export const CARTS_BRIEF = [
  "summary",
  "goal-trace",
  "problem",
  "brief-items",
  "brief-roadmap",
  "non-goals",
  "top-risks",
  "decisions",
];

const CARTS_V1: SectionSeed[] = [
  { key: "title", level: 1, heading: "Saved carts PRD", body: "Returning shoppers keep their cart across devices." },
  {
    key: "summary",
    level: 2,
    heading: "Summary",
    body:
      "We will let signed-in shoppers save a cart and pick it up on any device. It serves G2 (retention). We ask you to approve the beta scope.\n\n" +
      "```notes\nOpen with how many carts are lost when a session ends.\n```",
  },
  { key: "goal-trace", level: 2, heading: "Goal trace", body: "- **G2 (retention)**: more repeat orders within 30 days." },
  {
    key: "problem",
    level: 2,
    heading: "Problem",
    body: "Shoppers build a cart on their phone, then lose it when they move to a laptop. Most start over; many give up.",
  },
  {
    key: "brief-items",
    level: 2,
    heading: "Features by milestone",
    body: [
      "| Milestone | Feature | Goal | Outcome |",
      "|---|---|---|---|",
      "| [Beta](#milestone-beta) | [Save cart](#feature-save-cart) | G2 | A cart survives the session |",
      "|  | [Cart on every device](#feature-sync) | G2 | The same cart on phone and laptop |",
      "| [General release](#milestone-ga) | [Reminder email](#feature-reminder) | G2 | Shoppers come back to finish |",
    ].join("\n"),
  },
  {
    key: "brief-roadmap",
    level: 2,
    heading: "Roadmap",
    body: "- [Beta](#milestone-beta): signed-in shoppers never lose a cart.\n- [General release](#milestone-ga): more saved carts turn into orders.",
  },
  { key: "non-goals", level: 2, heading: "Non-goals", body: "- Carts for guests without an account.\n- Sharing a cart with someone else." },
  {
    key: "top-risks",
    level: 2,
    heading: "Top risks",
    body: "- Old carts show stale prices: re-price when a cart opens. See [Risks](#risks).\n- Too many emails: one reminder per cart, never more.",
  },
  {
    key: "decisions",
    level: 2,
    heading: "Decisions needed",
    body: "- Approve the beta scope: owner the founder, needed by 2026-11-01.\n- Pick the reminder delay (24 or 72 hours): owner the growth lead, needed by 2026-11-15.",
  },
  { key: "full", level: 1, heading: "Full version", body: "" },
  { key: "feature-detail", level: 2, heading: "Feature detail", body: "One section per feature, in priority order." },
  {
    key: "feature-save-cart",
    level: 3,
    heading: "Save cart",
    body: "**Story:** as a signed-in shopper, I want my cart kept when I leave, so I can finish later.\n\n**Acceptance:** given a cart with items, when the session ends, then the cart is there at the next sign-in.",
  },
  {
    key: "feature-sync",
    level: 3,
    heading: "Cart on every device",
    body: "**Story:** as a shopper on two devices, I want one cart, so I never rebuild it.\n\n**Acceptance:** an item added on the phone appears on the laptop within five seconds.",
  },
  {
    key: "feature-reminder",
    level: 3,
    heading: "Reminder email",
    body: "**Story:** as a shopper who left a cart, I want one reminder, so I remember to finish.\n\n**Acceptance:** one email per cart, sent after the chosen delay, with a one-click opt-out.",
  },
  { key: "milestones", level: 2, heading: "Milestones", body: "Dates come from the tracker estimates." },
  {
    key: "milestone-beta",
    level: 3,
    heading: "Beta",
    body: "Scope: save cart and cart on every device, for signed-in shoppers. Exit: two weeks without a lost cart.",
  },
  { key: "milestone-ga", level: 3, heading: "General release", body: "Scope: the reminder email. Exit: opt-outs below 2%." },
  {
    key: "risks",
    level: 2,
    heading: "Risks and open questions",
    body: "- Stale prices: likely, medium impact; re-price when the cart opens.\n- Too many emails: possible, high impact; one reminder per cart.",
  },
  { key: "sources", level: 2, heading: "Sources and data points", body: "" },
  { key: "sources-list", level: 3, heading: "Sources", body: "- Cart abandonment survey [c:c1]\n- Repeat orders, Q3 review [c:c2]" },
];

const HORIZONS = [
  { key: "now", heading: "Now", body: "Committed work; dated milestones only here." },
  { key: "next", heading: "Next", body: "Planned, not dated." },
  { key: "later", heading: "Later", body: "Direction, not a commitment." },
];

/**
 * A roadmap draft built from a PRD version, the way the prd_to_roadmap flow writes one
 * (O4b): one item per PRD section on Now / Next / Later, each linking back to its PRD
 * section with a cross-document link (/documents/<slug>/v/<n>#<section>).
 */
export function roadmapFromPrd(prd: {
  slug: string;
  title: string;
  version: number;
  sections: { key: string; level: number; heading: string }[];
}): { title: string; sections: SectionSeed[]; brief: string[] } {
  const link = (key?: string) => `/documents/${prd.slug}/v/${prd.version}${key ? `#${key}` : ""}`;
  const items = prd.sections
    .filter((s) => s.level === 2 && s.key !== "sources")
    .map((s, i) => ({ key: `item-${s.key}`, title: s.heading.replace(/^[\d.]+\s+/, ""), from: s, horizon: HORIZONS[Math.min(i, 2)] }));
  const count = (h: string) => items.filter((i) => i.horizon.key === h).length;
  const title = `${prd.title.replace(/\s*PRD$/, "")} roadmap`;
  const sections: SectionSeed[] = [
    { key: "title", level: 1, heading: title, body: `Built from [${prd.title} v${prd.version}](${link()}).` },
    {
      key: "summary",
      level: 2,
      heading: "Summary",
      body: `The approved PRD's work on one page: ${count("now")} now, ${count("next")} next, ${count("later")} later.`,
    },
    {
      key: "brief-items",
      level: 2,
      heading: "Items by horizon",
      body: [
        "| Horizon | Item | PRD section |",
        "|---|---|---|",
        ...items.map((i) => `| ${i.horizon.heading} | [${i.title}](#${i.key}) | [${i.from.heading}](${link(i.from.key)}) |`),
      ].join("\n"),
    },
    { key: "full", level: 1, heading: "Full version", body: "" },
    ...HORIZONS.flatMap((h) => [
      { key: h.key, level: 2, heading: h.heading, body: h.body },
      ...items
        .filter((i) => i.horizon.key === h.key)
        .map((i, n) => ({
          key: i.key,
          level: 3,
          heading: i.title,
          // O4: the first Now item carries dated milestones, each on a schedule basis
          // (mock roadmap.ts seeds ENG-412 verified and ENG-413 withdrawn).
          body:
            h.key === "now" && n === 0
              ? `Beta by 2026-11-30 (ENG-412 estimate); GA by 2026-12-15 (ENG-413 estimate). From the PRD: [${i.from.heading}](${link(i.from.key)}).`
              : `From the PRD: [${i.from.heading}](${link(i.from.key)}).`,
        })),
    ]),
    { key: "sources", level: 2, heading: "Sources and data points", body: `- [${prd.title} v${prd.version}](${link()})` },
  ];
  return { title, sections, brief: ["summary", "brief-items"] };
}

const ALERTS_ROADMAP = roadmapFromPrd({ slug: "usage-alerts", title: "Usage alerts PRD", version: 1, sections: ALERTS_V1 });

const CARTS_V2: SectionSeed[] = CARTS_V1.map((s) =>
  s.key === "problem"
    ? { ...s, body: "Shoppers build a cart on their phone, then lose it when they move to a laptop. More than half start over." }
    : s,
);

// E1: the technical brief Oracle wrote from checkout-redesign v1 (version 1), then an edit
// (version 2) added "Rollout notes" (not in the spec template) and "Proposed architecture"
// (a template section a technical brief does not have): both read "Proposed · added in an
// edit", and so does the source the edit cited.
const REQUIREMENTS_NOTE =
  "_Decided in the approved PRD: these are product requirements, not engineering choices. Change them in the PRD, not here._";
const ADDED_IN_AN_EDIT = "Proposed · added in an edit";
const SPEC_ORACLE_CITATIONS: CitationSeed[] = [
  {
    id: "prd-checkout",
    source: "upload",
    ref: "/documents/checkout-redesign/v/1",
    title: "Checkout redesign PRD, version 1",
    excerpt: "Show the shipping cost on the cart, before the address step.",
    retrieved_at: "2026-10-17T09:00:00Z",
  },
];
const SPEC_ADDED_CITATIONS: CitationSeed[] = [
  {
    id: "quote-latency",
    source: "web",
    ref: "https://example.com/carrier-quote-latency",
    title: "Carrier quote latency, p95",
    excerpt: "Carrier rate lookups answer in 300 ms at p95.",
    retrieved_at: "2026-10-19T15:00:00Z",
    added: true,
    state_label: ADDED_IN_AN_EDIT,
  },
];
const SPEC_TITLE = (kind: string): SectionSeed => ({
  key: "spec",
  level: 1,
  heading: `Early shipping cost: ${kind}`,
  body: `${kind[0].toUpperCase()}${kind.slice(1)} for Early shipping cost, from the approved PRD Checkout redesign PRD (version 1) [c:prd-checkout]. Product requirements come from that PRD; the engineering approach is proposed until an engineering approver approves this version.`,
});
const SPEC_SUMMARY: SectionSeed = { key: "summary", level: 2, heading: "Summary", body: "Shoppers see the shipping cost on the cart page, before the address step." };
const SPEC_REQUIREMENTS: SectionSeed = {
  key: "requirements",
  level: 2,
  heading: "Product requirements",
  body: `${REQUIREMENTS_NOTE}\n\nFrom PRD [Checkout redesign PRD](/documents/checkout-redesign/v/1), version 1.\n\n- **req-shipping-cost: Show shipping cost on the cart** (requirement id \`5b0c…\`)\n  PRD section: [5.2 Shipping options](/documents/checkout-redesign/v/1#s-5-2)`,
};
const SPEC_ROLLOUT: SectionSeed = {
  key: "rollout-notes",
  level: 2,
  heading: "Rollout notes",
  body: "Ten percent of carts first, then everyone after a week without a rise in quote errors.\n\n![chart](https://example.com/chart.png)\n\n![stored](/uploads/rollout.png)\n\n![evil](/\\evil.com/p.png) ![other](/v1/me) ![up](/uploads/../v1/me) after the images.",
};
const SPEC_ARCHITECTURE: SectionSeed = {
  key: "architecture",
  level: 2,
  heading: "Proposed architecture",
  body: "The cart calls a new quote service; the service asks the carrier and caches the answer per postcode [c:quote-latency].",
};
const SPEC_APPROACH: SectionSeed = {
  key: "approach",
  level: 2,
  heading: "Proposed engineering approach",
  body: "_Proposed engineering approach, based on assumptions: no code capability map was available, so it is not checked against the code (see Assumptions)._\n\nA shipping quote service called from the cart, cached per postcode for ten minutes.",
};
const SPEC_OPEN: SectionSeed = { key: "open-decisions", level: 2, heading: "Open engineering decisions", body: "Which carrier rates to cache, and for how long." };
const SPEC_FULL: SectionSeed = { key: "full", level: 1, heading: "Full version", body: "" };
/** Oracle's acceptance criteria: the half from the PRD (decided), then the proposed half. */
const SPEC_ACCEPTANCE: SectionSeed = {
  key: "acceptance-criteria",
  level: 2,
  heading: "Acceptance criteria",
  body: "In the baseline (decided with the PRD):\n\n- req-shipping-cost: A shopper sees the shipping cost on the cart page.\n\nProposed by this spec (not product requirements until the PRD adopts them):\n\n- The quote refreshes when the cart changes.",
};
const SPEC_ASSUMPTIONS: SectionSeed = { key: "assumptions", level: 2, heading: "Assumptions", body: "The cart service can call an internal endpoint." };
const SPEC_SOURCES: SectionSeed = {
  key: "sources",
  level: 2,
  heading: "Sources and data points",
  body: "- Product requirements: PRD checkout-redesign version 1, approved 2026-10-17.\n- Code capability map: not available; the approach rests on the assumptions listed above.",
};
const SPEC_V1: SectionSeed[] = [
  SPEC_TITLE("technical brief"), SPEC_SUMMARY, SPEC_REQUIREMENTS, SPEC_APPROACH, SPEC_OPEN,
  SPEC_FULL, SPEC_ACCEPTANCE, SPEC_ASSUMPTIONS, SPEC_SOURCES,
];
const SPEC_V2: SectionSeed[] = [
  SPEC_TITLE("technical brief"), SPEC_SUMMARY, SPEC_REQUIREMENTS, SPEC_ROLLOUT, SPEC_APPROACH, SPEC_ARCHITECTURE, SPEC_OPEN,
  SPEC_FULL, SPEC_ACCEPTANCE, SPEC_ASSUMPTIONS, SPEC_SOURCES,
];
const SPEC_BRIEF_KEYS = ["summary", "requirements", "rollout-notes", "approach", "architecture", "open-decisions"];
// E1: a full engineering spec; "Launch checklist" is not in the template (added in an edit).
const FULL_SPEC_V1: SectionSeed[] = [
  SPEC_TITLE("engineering spec"), SPEC_SUMMARY, SPEC_REQUIREMENTS, SPEC_APPROACH, SPEC_OPEN,
  SPEC_FULL,
  SPEC_ACCEPTANCE,
  { key: "user-flows", level: 2, heading: "User flows", body: "1. The shopper opens the cart.\n2. The cart asks for a quote and shows it under the subtotal." },
  SPEC_ARCHITECTURE,
  { key: "apis-data", level: 2, heading: "APIs and data models", body: "`GET /quotes?postcode=…` returns the cheapest rate and its carrier." },
  { key: "failure-modes", level: 2, heading: "Failure modes", body: "When the carrier does not answer, the cart shows the flat rate." },
  { key: "launch-checklist", level: 2, heading: "Launch checklist", body: "- Quote errors under 0.5 percent for a week.\n- Support briefed on the new cart line." },
  SPEC_ASSUMPTIONS,
  SPEC_SOURCES,
];

// C1e: a Galatia-like PRD on its fifth draft, with two accepted changes staged for draft 6
// (F-38 Outbound check, raised on v5, and Goal trace, raised on v4), one declined, one still
// open and one addressed in v4 (comments seeded in ./server.ts, suggestions in ./llm-jobs.ts).
const OUTREACH_V1: SectionSeed[] = [
  {
    key: "title",
    level: 1,
    heading: "Clinic outreach PRD",
    body: "Clinic outreach calls patients who missed a visit and books them back in, from one queue per clinic.",
  },
  {
    key: "goal-trace",
    level: 2,
    heading: "Goal trace",
    body: "Serves G1 activation: more new patients reach a second visit.",
  },
  {
    key: "problem",
    level: 2,
    heading: "1. Problem",
    body: "40% of missed visits are never rebooked. Front desks call back when they have time, from paper lists.",
  },
  {
    key: "f-38",
    level: 2,
    heading: "F-38 Outbound check",
    body: "After each outbound call, the agent checks the patient's consent and records the outcome.",
  },
  {
    key: "metrics",
    level: 2,
    heading: "2. Metrics",
    body: "- Rebooked within 14 days: 22% today, 35% target.\n- Calls per rebooking: 3.1 today.",
  },
  {
    key: "sources",
    level: 2,
    heading: "Sources and data points",
    body: "- Missed-visit audit, 2024.",
  },
];
const OUTREACH_V3 = revise(OUTREACH_V1, {
  problem: { body: "40% of missed visits are never rebooked. Front desks call back when they have time, from paper lists, in every pilot clinic." },
});
const OUTREACH_V4 = revise(OUTREACH_V3, {
  problem: {
    body: "40% of missed visits are never rebooked. Front desks in the three pilot clinics (Harbour, Northgate, Riverside) call back when they have time, from paper lists.",
  },
});
const OUTREACH_V5 = revise(OUTREACH_V4, {
  metrics: { body: "- Rebooked within 14 days: 22% today, 35% target.\n- Calls per rebooking: 3.1 today, 2 target." },
});

export const DOCUMENTS: DocumentSeed[] = [
  {
    slug: "checkout-redesign",
    title: "Checkout redesign PRD",
    template: "oracle-default",
    template_version: "1",
    versions: [
      {
        number: 1,
        created_at: "2026-10-16T14:05:00Z",
        snapshot: "2026-10-16T14:00Z",
        sections: CHECKOUT_V1,
        citations: CHECKOUT_CITATIONS.filter((c) => c.id !== "c5"),
      },
      {
        number: 2,
        created_at: "2026-10-17T09:20:00Z",
        snapshot: "2026-10-17T09:00Z",
        sections: CHECKOUT_V2,
        // v2's writer read c1 from the mock's Product chat (its "Customer question" item).
        citations: CHECKOUT_CITATIONS.map((c) => (c.id === "c1" ? { ...c, item: seededItemId(PRODUCT_CHAT_ID, "m1") } : c)),
      },
    ],
  },
  {
    slug: "team-workspaces",
    title: "Team workspaces PRD",
    template: "oracle-default",
    template_version: "1",
    versions: [
      { number: 1, created_at: "2026-10-12T11:00:00Z", sections: WORKSPACES_V1, citations: WORKSPACES_CITATIONS },
      { number: 2, created_at: "2026-10-13T10:30:00Z", sections: WORKSPACES_V2, citations: WORKSPACES_CITATIONS },
    ],
  },
  {
    slug: "saved-carts",
    title: "Saved carts PRD",
    template: "oracle-default",
    template_version: "2",
    versions: [
      { number: 1, created_at: "2026-10-17T11:00:00Z", sections: CARTS_V1, citations: CARTS_CITATIONS, brief: CARTS_BRIEF },
      { number: 2, created_at: "2026-10-18T08:30:00Z", sections: CARTS_V2, citations: CARTS_CITATIONS, brief: CARTS_BRIEF },
    ],
  },
  {
    slug: "usage-alerts",
    title: "Usage alerts PRD",
    versions: [{ number: 1, created_at: "2026-10-02T08:00:00Z", sections: ALERTS_V1, citations: [] }],
  },
  // O4b: a roadmap built from the approved usage-alerts v1.
  {
    slug: "usage-alerts-roadmap",
    title: ALERTS_ROADMAP.title,
    kind: "roadmap",
    template: "now-next-later",
    template_version: "1",
    theme: "roadmap-board",
    versions: [
      {
        number: 1,
        created_at: "2026-10-04T09:00:00Z",
        sections: ALERTS_ROADMAP.sections,
        citations: [],
        brief: ALERTS_ROADMAP.brief,
        source: { slug: "usage-alerts", version: 1 },
      },
    ],
  },
  {
    slug: "online-deposits",
    title: "Online deposits at booking",
    template: "oracle-default",
    template_version: "1",
    versions: [
      { number: 1, created_at: "2026-10-14T09:00:00Z", sections: DEPOSITS_V1, citations: [], by: { id: "5e6b65ac-0d1f-4c2a-9b7e-3f8a1c2d4e01", name: "Approver" } },
      { number: 2, created_at: "2026-10-15T09:00:00Z", sections: DEPOSITS_V2, citations: [] },
      // A run's draft: imported for the person who started the run, named Oracle.
      { number: 3, created_at: "2026-10-16T09:00:00Z", sections: DEPOSITS_V3, citations: [], by: { id: "9c2f4b1d-7a3e-4f60-8d15-b2e9a0c7f312", name: "Oracle" } },
    ],
  },
  {
    slug: "clinic-outreach",
    title: "Clinic outreach PRD",
    template: "oracle-default",
    template_version: "1",
    versions: [
      { number: 1, created_at: "2026-10-06T10:00:00Z", sections: OUTREACH_V1, citations: [] },
      { number: 2, created_at: "2026-10-07T10:00:00Z", sections: OUTREACH_V1, citations: [] },
      { number: 3, created_at: "2026-10-08T10:00:00Z", sections: OUTREACH_V3, citations: [] },
      { number: 4, created_at: "2026-10-09T10:00:00Z", sections: OUTREACH_V4, citations: [] },
      { number: 5, created_at: "2026-10-10T10:00:00Z", sections: OUTREACH_V5, citations: [] },
    ],
  },
  {
    slug: "visit-reminders",
    title: "Visit reminders",
    template: "oracle-default",
    template_version: "1",
    versions: [{ number: 1, created_at: "2026-10-11T09:00:00Z", sections: REMINDERS_V1, citations: [] }],
  },
  // E1: a technical brief; version 2 is an edit that added sections and a source.
  {
    slug: "checkout-redesign-early-shipping-cost-spec",
    title: "Early shipping cost: technical brief",
    kind: "spec",
    depth: "brief",
    versions: [
      {
        number: 1,
        created_at: "2026-10-19T10:00:00Z",
        sections: SPEC_V1,
        citations: SPEC_ORACLE_CITATIONS,
        brief: ["summary", "requirements", "approach", "open-decisions"],
        source: { slug: "checkout-redesign", version: 1 },
      },
      {
        number: 2,
        created_at: "2026-10-20T09:00:00Z",
        sections: SPEC_V2,
        citations: [...SPEC_ORACLE_CITATIONS, ...SPEC_ADDED_CITATIONS],
        brief: SPEC_BRIEF_KEYS,
        source: { slug: "checkout-redesign", version: 1 },
      },
    ],
  },
  // E1: a full engineering spec with a section and a source added in an edit.
  {
    slug: "checkout-redesign-early-shipping-cost-engineering-spec",
    title: "Early shipping cost: engineering spec",
    kind: "spec",
    depth: "full",
    versions: [
      {
        number: 1,
        created_at: "2026-10-20T10:00:00Z",
        sections: FULL_SPEC_V1,
        citations: [...SPEC_ORACLE_CITATIONS, ...SPEC_ADDED_CITATIONS],
        brief: ["summary", "requirements", "approach", "open-decisions"],
        source: { slug: "checkout-redesign", version: 1 },
      },
    ],
  },
];

// Built from pieces so no credential-shaped literal sits in the source.
const MOCK_PASS = ["de", "mo"].join("");
export const MOCK_LOGIN = { email: "admin@example.com", password: MOCK_PASS };

/** Mock members, one per role; each signs in with the mock password. */
export const MOCK_MEMBERS = [
  // A3: nobody is the engineering lead in the default company (the "eng-review" scenario names one).
  { email: "admin@example.com", role: "owner", engineering_lead: false, created_at: "2026-09-01T09:00:00Z", last_sign_in_at: "2026-10-20T07:30:00Z" },
  { email: "approver@example.com", role: "approver", engineering_lead: false, created_at: "2026-09-02T09:00:00Z", last_sign_in_at: "2026-10-19T16:00:00Z" },
  { email: "commenter@example.com", role: "commenter", engineering_lead: false, created_at: "2026-09-03T09:00:00Z", last_sign_in_at: "2026-10-12T10:15:00Z" },
  { email: "viewer@example.com", role: "viewer", engineering_lead: false, created_at: "2026-09-04T09:00:00Z", last_sign_in_at: null },
] as const;

/** A member an owner removed (disabled, C2); their tokens were revoked with it. */
export const REMOVED_MEMBER = {
  email: "former.pm@example.com",
  role: "approver",
  engineering_lead: false,
  created_at: "2026-09-05T09:00:00Z",
  last_sign_in_at: "2026-10-17T21:50:00Z",
  disabled_at: "2026-10-18T09:00:00Z",
} as const;

/** A5: someone from the company's domains who signed in with Google without an invite. */
export const MOCK_ACCESS_REQUESTS = [
  { email: "new.person@example.com", note: "I lead support and need to read the PRD.", created_at: "2026-10-21T16:05:00Z", last_seen_at: "2026-10-21T18:40:00Z" },
] as const;

export const MOCK_INVITES = [{ email: "new.hire@example.com", role: "commenter", engineering_lead: false, created_at: "2026-10-15T09:00:00Z" }] as const;

/*
 * The "suggestions" scenario (MOCK_SCENARIO_KEY): a PRD whose open feedback is three Oracle
 * change requests on feature sections further down, none on the first section, plus one
 * item already addressed. The Inbox's feedback row leads here.
 */
const FLEET_FEATURES: [string, string, string][] = [
  ["f-31", "F-31 Route planner", "Dispatchers plan a day of stops on one map and drag stops between drivers."],
  ["f-32", "F-32 Live arrival times", "Each customer sees a live arrival window that moves with the driver."],
  ["f-33", "F-33 Proof of delivery", "Drivers take a photo and a signature at the door; both attach to the order."],
  ["f-34", "F-34 Failed delivery flow", "A driver marks a stop as failed with a reason; the customer picks a new slot."],
  ["f-35", "F-35 Driver shift summary", "At the end of a shift each driver sees stops done, distance and time on the road."],
  ["f-36", "F-36 Depot handover", "Returned parcels are scanned back in at the depot and leave the driver's list."],
];

const fleetSections = (problem: string): SectionSeed[] => [
  {
    key: "summary",
    level: 2,
    heading: "Summary",
    body: "The next version of the delivery app for small fleets: plan routes, keep customers informed, close every stop with proof.",
  },
  { key: "problem", level: 2, heading: "Problem", body: problem },
  { key: "features", level: 2, heading: "Features", body: "Six features, in delivery order." },
  ...FLEET_FEATURES.map(([key, heading, body]) => ({ key, level: 3, heading, body })),
  // #306 Named codes: milestones titled with their dates; three or more codes as a list.
  { key: "delivery-plan", level: 2, heading: "Delivery plan", body: "Two milestones; each ships the features listed under it." },
  {
    key: "m1",
    level: 3,
    heading: "M1 · Oct 19 – Nov 13",
    body: "Ships:\n\n- F-31 Route planner\n- F-32 Live arrival times\n- F-33 Proof of delivery",
  },
  {
    key: "m2",
    level: 3,
    heading: "M2 · Nov 16 – Dec 11",
    body: "Ships:\n\n- F-34 Failed delivery flow\n- F-35 Driver shift summary\n- F-36 Depot handover\n\nF-36 needs F-34 live first.",
  },
  {
    key: "metrics",
    level: 2,
    heading: "Metrics",
    body: "- First-attempt delivery rate up from 88% to 94%.\n- Support contacts per 100 deliveries down by a third.",
  },
];

export const FLEET_DOC: DocumentSeed = {
  slug: "fleet-next",
  title: "Fleet next version — PRD",
  template: "oracle-default",
  template_version: "1",
  versions: [
    {
      number: 1,
      created_at: "2026-10-17T09:00:00Z",
      sections: fleetSections("Customers do not know when a parcel will arrive, so many are out when the driver comes."),
      citations: [],
    },
    {
      number: 2,
      created_at: "2026-10-19T09:00:00Z",
      sections: fleetSections(
        "Customers do not know when a parcel will arrive, so many are out when the driver comes: 12% of first attempts fail today.",
      ),
      citations: [],
    },
  ],
};

/** Oracle's proposed text for the three open change requests: long on purpose, as in real drafts. */
export const FLEET_SUGGESTIONS: { key: string; summary: string; rationale: string; text: string }[] = [
  {
    key: "f-33",
    summary: "Say what happens when the customer is not home and nobody can sign.",
    rationale: "Proof of delivery has no path for a safe-place drop; two reviewers asked for one.",
    text: [
      "Drivers take a photo and a signature at the door; both attach to the order and show in the customer's tracking page within a minute.",
      "",
      "When nobody answers, the driver may leave the parcel in a safe place the customer named at checkout (porch, side gate, neighbour). The app asks for a photo that shows the parcel and the door number, and records the GPS position. A signature is not asked for.",
      "",
      "When the customer named no safe place, the parcel is not left: the stop goes to the failed delivery flow (F-34).",
      "",
      "Orders flagged as age-restricted or high value never use a safe place; the app hides the option.",
      "",
      "Dispatchers see every safe-place drop in the day's list with its photo, so a complaint can be checked in seconds.",
    ].join("\n"),
  },
  {
    key: "f-34",
    summary: "Limit how many times a customer can move a failed delivery.",
    rationale: "Without a limit, one order can bounce between slots for a week; ops asked for a cap.",
    text: [
      "A driver marks a stop as failed with one of five reasons: nobody home, wrong address, refused, access problem, damaged.",
      "",
      "The customer gets a message within five minutes with a link to pick a new slot in the next three days. The first new slot is free; a second one is offered once more; after that the parcel goes back to the depot and the customer collects it there.",
      "",
      "Wrong address and refused skip the new slot and go straight to customer support, who call within one working day.",
      "",
      "Each failed attempt is counted against the first-attempt delivery rate, so the metric matches what customers see.",
    ].join("\n"),
  },
  {
    key: "f-36",
    summary: "Depot handover needs a count check before the driver leaves.",
    rationale: "Scans alone miss parcels that never left the van; a count at handover catches them.",
    text: [
      "Returned parcels are scanned back in at the depot and leave the driver's list.",
      "",
      "Before the driver can end the shift, the app shows how many parcels should come back and how many were scanned. A mismatch blocks the end of the shift until a depot lead confirms it with a note.",
      "",
      "Parcels scanned at the depot go back into the next day's planning pool, at the top of the list, so they leave first the next morning.",
      "",
      "The depot lead sees open mismatches on the dashboard until each one is closed.",
    ].join("\n"),
  },
];

/*
 * H8 Board and investor drafts: the default company's two synthetic updates, for the
 * fictional "Example Co" (made-up numbers; "Project Larkspur" is a code name only these
 * updates use). Both are seen by owners and approvers only. The September investor update
 * is approved; the October board update is in review and its timeline writes one date no
 * verified schedule basis supports (2027-01-19), so it cannot be approved yet. The board
 * update presents as two slides (front matter `slides`). Seeded after DOCUMENTS (server.ts).
 */
export type UpdateSeed = DocumentSeed & {
  kind: "update";
  template: "investor-update" | "board-product";
  period: { from: string; to: string };
  status: "draft" | "in_review" | "approved";
  approved_at?: string;
};

export const UPDATE_SOURCES = (rows: string[], evidence: string[]): SectionSeed[] => [
  { key: "full", level: 1, heading: "Full version", body: "The detail behind the brief." },
  { key: "sources", level: 2, heading: "Sources and data points", body: "Every number above, with its value, as-of date and source." },
  {
    key: "sources-list",
    level: 3,
    heading: "Sources",
    body: "- g1: oracle, Goals in the baseline, retrieved 2026-10-20\n- t1: oracle, Product tracks and milestones, retrieved 2026-10-20",
  },
  { key: "sources-data", level: 3, heading: "Data points", body: rows.map((r) => `- ${r}`).join("\n") },
  { key: "sources-evidence", level: 3, heading: "Evidence by section", body: evidence.map((r) => `- ${r}`).join("\n") },
];

export const UPDATE_SEED_CITATIONS: CitationSeed[] = [
  {
    id: "g1",
    source: "oracle",
    ref: "oracle://baseline/goals",
    title: "Goals in the baseline",
    excerpt: "Confirmed goals with their targets and current values.",
    retrieved_at: "2026-10-20T08:00:00Z",
  },
  {
    id: "t1",
    source: "oracle",
    ref: "oracle://tracks",
    title: "Product tracks and milestones",
    excerpt: "Active tracks, their milestones and verified schedule bases.",
    retrieved_at: "2026-10-20T08:00:00Z",
  },
];

export const UPDATE_DOCUMENTS: UpdateSeed[] = [
  {
    slug: "investor-update-2026-09",
    title: "Investor update · September 2026",
    kind: "update",
    template: "investor-update",
    template_version: "1",
    theme: "one-page-brief",
    period: { from: "2026-09-01", to: "2026-09-30" },
    status: "approved",
    approved_at: "2026-10-03T16:00:00Z",
    versions: [
      {
        number: 1,
        created_at: "2026-10-02T09:00:00Z",
        brief: ["metrics", "asks", "highlights", "lowlights", "product"],
        citations: UPDATE_SEED_CITATIONS,
        sections: [
          { key: "title", level: 1, heading: "Investor update · September 2026", body: "Example Co's product update for September 2026." },
          {
            key: "metrics",
            level: 2,
            heading: "Metrics",
            body: [
              "| Goal | Target | Now | Distance to go | Change since last update |",
              "| --- | --- | --- | --- | --- |",
              "| Weekly active teams | 1,200 | 940 | 260 | +85 |",
              "| Trial to paid conversion | 12% | 9.4% | 2.6 pts | +0.8 pts |",
              "| Monthly churn | 2.0% | 2.6% | 0.6 pts | -0.3 pts |",
            ].join("\n"),
          },
          {
            key: "asks",
            level: 2,
            heading: "Asks",
            body: "Introductions to two finance leads at mid-size software companies who would pilot team billing.",
          },
          {
            key: "highlights",
            level: 2,
            heading: "Highlights",
            body: "- Project Larkspur, the onboarding checklist, shipped to every new team.\n- Usage alerts entered a private pilot with 9 teams.\n- Trial to paid conversion rose for the second month running.",
          },
          {
            key: "lowlights",
            level: 2,
            heading: "Lowlights",
            body: "- Churn among teams of fewer than five seats did not improve.\n- The pricing page test was inconclusive.",
          },
          {
            key: "product",
            level: 2,
            heading: "Product recap",
            body: "Shipped: the onboarding checklist.\n\nNext: usage alerts beta on 2026-11-30.",
          },
          ...UPDATE_SOURCES(
            ["Weekly active teams: 940, as of 2026-09-30, from g1", "Trial to paid conversion: 9.4%, as of 2026-09-30, from g1", "Monthly churn: 2.6%, as of 2026-09-30, from g1"],
            ["metrics: g1", "highlights: g1, t1", "lowlights: g1", "product: t1"],
          ),
        ],
      },
    ],
  },
  {
    slug: "board-update-2026-10",
    title: "Board update · October 2026",
    kind: "update",
    template: "board-product",
    template_version: "1",
    theme: "roadmap-board",
    period: { from: "2026-09-08", to: "2026-10-20" },
    status: "in_review",
    versions: [
      {
        number: 1,
        created_at: "2026-10-20T07:00:00Z",
        brief: ["headline", "goals", "timeline", "shipped", "lowlights", "asks"],
        citations: UPDATE_SEED_CITATIONS,
        sections: [
          { key: "title", level: 1, heading: "Board update · October 2026", body: "Example Co's product section for the board, October 2026." },
          {
            key: "headline",
            level: 2,
            heading: "Product in one line",
            body: "Usage alerts are ready for beta and Project Larkspur lifted activation; team billing is a month behind.",
          },
          {
            key: "goals",
            level: 2,
            heading: "Goals: where we are",
            body: [
              "| Goal | Target | Now | Distance to go | Trend since last board | Track |",
              "| --- | --- | --- | --- | --- | --- |",
              "| Weekly active teams | 1,200 | 1,010 | 190 | +160 | On track |",
              "| Trial to paid conversion | 12% | 10.1% | 1.9 pts | +1.5 pts | On track |",
              "| Monthly churn | 2.0% | 2.4% | 0.4 pts | -0.5 pts | Off track |",
            ].join("\n"),
          },
          {
            key: "timeline",
            level: 2,
            heading: "Timeline",
            body: "**Now**\n\n- Usage alerts beta: 2026-11-30\n- Team billing general availability: 2027-01-19\n\n**Next**\n\n- Seat-based plans\n\n**Later**\n\n- Annual invoicing",
          },
          { key: "shipped", level: 2, heading: "Shipped since last board", body: "- Onboarding checklist (Project Larkspur)\n- Usage alerts for pilot teams" },
          {
            key: "lowlights",
            level: 2,
            heading: "What slipped or did not work",
            body: "- Team billing slipped a month: the invoicing partner's sandbox came late.\n- The pricing page test did not move conversion.",
          },
          { key: "asks", level: 2, heading: "Decisions we need from the board", body: "Owner to fill: the decisions you need from the board this meeting." },
          { key: "full", level: 1, heading: "Full version", body: "The detail behind the brief." },
          { key: "outcomes", level: 2, heading: "Predicted versus actual", body: "- Onboarding checklist: predicted +5 weekly active teams a week; measured +6." },
          { key: "risks", level: 2, heading: "Risks and blockers", body: "- Invoicing partner dependency for team billing; reviewed at the next planning meeting." },
          { key: "decisions", level: 2, heading: "Decisions made", body: "- Usage alerts launch to every plan, not only paid plans." },
          ...UPDATE_SOURCES(
            ["Weekly active teams: 1,010, as of 2026-10-20, from g1", "Trial to paid conversion: 10.1%, as of 2026-10-20, from g1", "Monthly churn: 2.4%, as of 2026-10-20, from g1"],
            ["goals: g1", "timeline: t1", "shipped: t1", "lowlights: t1"],
          ).slice(1),
        ],
      },
    ],
  },
];
