"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { ScrollStrip } from "@/components/ds";
import { useMe } from "@/lib/me";

import { COMPANY_TABS, type CompanyTab } from "./_tabs";

/** The tabs the signed-in member may see, in registry order. */
export function visibleTabs(can: ReturnType<typeof useMe>["can"]): CompanyTab[] {
  return COMPANY_TABS.filter((t) => !t.read || can(t.read, true));
}

/**
 * Company's tabs: a strip under the page title (PageHeader draws it, see the layout). On a
 * phone the tabs scroll sideways inside their strip; the page never does.
 */
export function CompanyNav() {
  const pathname = usePathname();
  const { can } = useMe();
  return (
    <nav aria-label="Company" data-testid="company-nav" className="rounded-panel border border-line bg-surface px-2 py-1.5 shadow-panel">
      <ScrollStrip className="min-h-9" stripClassName="items-center gap-1">
        {visibleTabs(can).map((t) => {
          const on = pathname === t.href || pathname.startsWith(`${t.href}/`);
          return (
            <Link
              key={t.key}
              href={t.href}
              data-testid={t.testId}
              aria-current={on ? "page" : undefined}
              className={`flex h-8 flex-none items-center rounded-lg px-3 text-[15px] font-medium whitespace-nowrap ${
                on ? "bg-accent text-on-accent" : "text-text hover:bg-surface2"
              }`}
            >
              {t.label}
            </Link>
          );
        })}
      </ScrollStrip>
    </nav>
  );
}
