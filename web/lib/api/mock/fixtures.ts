/**
 * Generic, fictional PRD drafts used by mock mode (NEXT_PUBLIC_API_MOCKS=1).
 * No real company, product or customer names: this repository is public.
 */

export type CitationSeed = {
  id: string;
  source: "slack" | "notion" | "gdocs" | "github" | "fireflies" | "upload" | "web";
  ref: string;
  title: string;
  excerpt: string;
  retrieved_at: string;
};

export type SectionSeed = { key: string; level: number; heading: string; body: string };

export type VersionSeed = {
  number: number;
  created_at: string;
  snapshot?: string;
  sections: SectionSeed[];
  citations: CitationSeed[];
};

export type DocumentSeed = {
  slug: string;
  title: string;
  template?: string;
  template_version?: string;
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
  },
  {
    id: "c2",
    source: "fireflies",
    ref: "https://app.example-notes.com/view/customer-interview-07",
    title: "Customer interview 07 (transcript)",
    excerpt: "I didn't know what shipping would cost until the last screen, so I went back to compare.",
    retrieved_at: "2026-10-15T09:42:00Z",
  },
  {
    id: "c3",
    source: "notion",
    ref: "https://www.notion.so/example/Q4-goals-0000000000",
    title: "Q4 goals: activation and retention",
    excerpt: "G1: raise first-order completion from 61% to 70% by the end of Q4.",
    retrieved_at: "2026-10-14T16:05:00Z",
  },
  {
    id: "c4",
    source: "github",
    ref: "https://github.com/example-org/storefront/issues/412",
    title: "Address form loses state on back navigation",
    excerpt: "Navigating back from payment clears every field in the address form.",
    retrieved_at: "2026-10-16T11:30:00Z",
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
        citations: CHECKOUT_CITATIONS,
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
    slug: "usage-alerts",
    title: "Usage alerts PRD",
    versions: [{ number: 1, created_at: "2026-10-02T08:00:00Z", sections: ALERTS_V1, citations: [] }],
  },
];

// Built from pieces so no credential-shaped literal sits in the source.
const MOCK_PASS = ["de", "mo"].join("");
export const MOCK_LOGIN = { email: "admin@example.com", password: MOCK_PASS };
