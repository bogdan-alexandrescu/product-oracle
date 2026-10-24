import type { Operation } from "@/lib/me";

/**
 * The Company tabs (H1 owns the shell; owner 2026-10-21 "New pages"). Later specs add their
 * tab here and build no shell of their own; when all have landed the order is
 * Strategy · Decisions · Rituals · Updates · Metrics · Market. A tab with a `read` the signed-in role cannot call
 * (#370: the capabilities, as Settings' tabs) is not drawn.
 */
export type CompanyTab = { key: string; label: string; href: string; testId: string; read?: Operation };

export const COMPANY_TABS: CompanyTab[] = [
  { key: "strategy", label: "Strategy", href: "/company/strategy", testId: "company-tab-strategy" },
  { key: "decisions", label: "Decisions", href: "/company/decisions", testId: "company-tab-decisions" },
  // H2 Cadence engine: everyone sees the rituals and their pre-reads; owners edit them.
  { key: "rituals", label: "Rituals", href: "/company/rituals", testId: "company-tab-rituals" },
  // H8 Board and investor drafts: owners and approvers see updates (owner 2026-10-21, "Update view"):
  // whoever may start the drafts an update is made from.
  { key: "updates", label: "Updates", href: "/company/updates", testId: "company-tab-updates", read: "start_draft" },
  // H5 Metrics review (owner 2026-10-23, Q2 "New pages"): everyone reads the weekly metrics.
  { key: "metrics", label: "Metrics", href: "/company/metrics", testId: "company-tab-metrics", read: "list_metrics" },
  // H7 Competitive digest (owner 2026-10-23, "New pages"): everyone reads the market; approvers and owners change it.
  { key: "market", label: "Market", href: "/company/market", testId: "company-tab-market", read: "list_competitors" },
];
