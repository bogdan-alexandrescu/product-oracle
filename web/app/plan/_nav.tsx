"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useMemo, useSyncExternalStore } from "react";

import { ScrollStrip } from "@/components/ds";
import { MOCK_MODE } from "@/lib/api/client";

import { isOpen, MOCK_PLAN_TABS_KEY, PLAN_TABS, type PlanTab } from "./_tabs";

/** Entries a test registered in the mock build (never in a real build), as stored. */
function registeredRaw(): string {
  if (!MOCK_MODE) return "[]";
  try {
    return localStorage.getItem(MOCK_PLAN_TABS_KEY) ?? "[]";
  } catch {
    return "[]";
  }
}

function parse(raw: string): PlanTab[] {
  try {
    const list = JSON.parse(raw);
    return Array.isArray(list) ? (list as PlanTab[]) : [];
  } catch {
    return [];
  }
}

const noSubscribe = () => () => {};

/**
 * The Plan's page-wide links (qa-plan-12): the same three, in the same place, on every Plan
 * tab, at the end of the tab strip. A tab's own action stays in its header.
 */
const PAGE_LINKS = [
  { href: "/plan/reports/latest", label: "Alignment report", testId: "plan-alignment-link" },
  { href: "/roadmap/launches", label: "Launches", testId: "roadmap-launches-link" },
  { href: "/roadmap/changelog", label: "Changelog", testId: "roadmap-changelog-link" },
];

/**
 * Plan's tab strip, under the page title (PageHeader draws it, see the plan layout). The tabs
 * wrap rather than scroll (qa-plan-4): on a phone all five show, with no arrows over them.
 */
export function PlanNav() {
  const pathname = usePathname();
  const raw = useSyncExternalStore(noSubscribe, registeredRaw, () => "[]");
  // A registered entry whose page has since landed is not listed twice.
  const extra = useMemo(() => parse(raw).filter((t) => !PLAN_TABS.some((x) => x.key === t.key)), [raw]);
  return (
    <div
      data-testid="plan-bar"
      className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-panel border border-line bg-surface px-2 py-1.5 shadow-panel"
    >
      <nav aria-label="Plan" data-testid="plan-tabs" className="min-w-0 flex-auto">
        <ScrollStrip wrap className="min-h-9" stripClassName="items-center gap-1">
          {[...PLAN_TABS, ...extra].map((t) => {
            const on = isOpen(t, pathname);
            return (
              <Link
                key={t.key}
                href={t.href}
                data-testid={t.testId}
                aria-label={t.name}
                title={t.name}
                aria-current={on ? "page" : undefined}
                className={`flex h-8 flex-none items-center rounded-lg px-3 text-[15px] font-medium whitespace-nowrap max-[600px]:px-2.5 ${
                  on ? "bg-accent text-on-accent" : "text-text hover:bg-surface2"
                }`}
              >
                {t.label}
              </Link>
            );
          })}
        </ScrollStrip>
      </nav>
      <nav
        aria-label="Plan links"
        data-testid="plan-links"
        className="ml-auto flex flex-wrap items-center gap-1 max-[600px]:ml-0 max-[600px]:w-full max-[600px]:border-t max-[600px]:border-line max-[600px]:pt-1"
      >
        {PAGE_LINKS.map((l) => (
          <Link
            key={l.href}
            href={l.href}
            data-testid={l.testId}
            className="flex h-8 flex-none items-center rounded-lg px-2.5 text-sm font-semibold whitespace-nowrap text-accent-ink hover:bg-surface2"
          >
            {l.label}
          </Link>
        ))}
      </nav>
    </div>
  );
}
