import type { Role } from "@/lib/me";

/**
 * The Company tabs (H1 owns the shell; owner 2026-10-21 "New pages"). Later specs add their
 * tab here and build no shell of their own; when all have landed the order is
 * Strategy · Decisions · Rituals · Updates. A tab whose `minRole` the viewer lacks is not drawn.
 */
export type CompanyTab = { key: string; label: string; href: string; testId: string; minRole?: Role };

export const COMPANY_TABS: CompanyTab[] = [
  { key: "strategy", label: "Strategy", href: "/company/strategy", testId: "company-tab-strategy" },
  { key: "decisions", label: "Decisions", href: "/company/decisions", testId: "company-tab-decisions" },
  // H2 Cadence engine adds { key: "rituals", label: "Rituals", href: "/company/rituals", ... }
  // H8 Board and investor drafts: owners and approvers see updates (owner 2026-10-21, "Update view").
  { key: "updates", label: "Updates", href: "/company/updates", testId: "company-tab-updates", minRole: "approver" },
];
