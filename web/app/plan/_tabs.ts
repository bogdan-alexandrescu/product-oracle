/**
 * Plan's tabs (F1 owns the strip; c7: Plan is the integrated view, roadmap documents live
 * inside it). Later specs add one entry each, in this order, once their page lands: Dates
 * (/plan/dates, F3), Outcomes (/plan/outcomes, H3), Launches and Changelog (/plan/launches,
 * /plan/changelog, H6). An entry whose page has not landed is absent.
 */
export type PlanTab = {
  key: string;
  /** The strip's label: short, so the tabs fit (or nearly) a phone's strip. */
  label: string;
  /** The full name where `label` shortens it: the link's accessible name and tooltip. */
  name?: string;
  href: string;
  testId: string;
};

export const PLAN_TABS: PlanTab[] = [
  { key: "plan", label: "Plan", href: "/plan", testId: "plan-tab-plan" },
  { key: "documents", label: "Documents", name: "Roadmap documents", href: "/plan/documents", testId: "plan-tab-documents" },
  { key: "dates", label: "Dates", href: "/plan/dates", testId: "plan-tab-dates" },
  { key: "outcomes", label: "Outcomes", href: "/plan/outcomes", testId: "plan-tab-outcomes" },
  // qa-plan-23: the alignment reports (/plan/reports and a report) show the strip, so they have their tab.
  { key: "reports", label: "Reports", href: "/plan/reports", testId: "plan-tab-reports" },
];

/** In the mock build only: tests register extra entries here (a JSON list of PlanTab). */
export const MOCK_PLAN_TABS_KEY = "po-mock-plan-tabs";

/** Whether `pathname` is inside `tab` (the Plan tab is /plan itself). */
export function isOpen(tab: PlanTab, pathname: string): boolean {
  if (tab.href === "/plan") return pathname === "/plan";
  return pathname === tab.href || pathname.startsWith(`${tab.href}/`);
}
