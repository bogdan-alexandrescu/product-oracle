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

/** Plan's tab strip, under the page title (PageHeader draws it, see the plan layout). */
export function PlanNav() {
  const pathname = usePathname();
  const raw = useSyncExternalStore(noSubscribe, registeredRaw, () => "[]");
  // A registered entry whose page has since landed is not listed twice.
  const extra = useMemo(() => parse(raw).filter((t) => !PLAN_TABS.some((x) => x.key === t.key)), [raw]);
  return (
    <nav aria-label="Plan" data-testid="plan-tabs" className="rounded-panel border border-line bg-surface px-2 py-1.5 shadow-panel">
      <ScrollStrip className="min-h-9" stripClassName="items-center gap-1">
        {[...PLAN_TABS, ...extra].map((t) => {
          const on = isOpen(t, pathname);
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
