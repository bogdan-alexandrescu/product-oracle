/**
 * Plan's tabs (F1 owns the strip; c7: Plan is the integrated view, roadmap documents live
 * inside it). Later specs add one entry each, in this order, once their page lands: Dates
 * (/plan/dates, F3), Outcomes (/plan/outcomes, H3), Launches and Changelog (/plan/launches,
 * /plan/changelog, H6). An entry whose page has not landed is absent.
 */
export type PlanTab = { key: string; label: string; href: string; testId: string };

export const PLAN_TABS: PlanTab[] = [
  { key: "plan", label: "Plan", href: "/plan", testId: "plan-tab-plan" },
  { key: "documents", label: "Roadmap documents", href: "/plan/documents", testId: "plan-tab-documents" },
  { key: "outcomes", label: "Outcomes", href: "/plan/outcomes", testId: "plan-tab-outcomes" },
];

/** In the mock build only: tests register extra entries here (a JSON list of PlanTab). */
export const MOCK_PLAN_TABS_KEY = "po-mock-plan-tabs";

/** Whether `pathname` is inside `tab` (the Plan tab is /plan itself). */
export function isOpen(tab: PlanTab, pathname: string): boolean {
  if (tab.href === "/plan") return pathname === "/plan";
  return pathname === tab.href || pathname.startsWith(`${tab.href}/`);
}
