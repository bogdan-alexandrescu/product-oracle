import Link from "next/link";

/**
 * The crumb back to the Plan (qa-plan-22) on the pages its links open that have no Plan tab:
 * Changelog and Launches, on their title row (PageHeader backInline, qa-plan-11). A real link,
 * named "Back to Plan", 24 px tall at least (qa-plan-65).
 */
export function PlanCrumb() {
  return (
    <Link
      href="/plan"
      aria-label="Back to Plan"
      data-testid="plan-crumb"
      className="inline-flex min-h-6 items-center rounded-sm hover:text-text hover:underline"
    >
      ‹ Plan
    </Link>
  );
}
