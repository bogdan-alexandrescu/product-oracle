"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { ScrollStrip } from "@/components/ds";

const ITEMS = [
  { label: "Requests", href: "/requests", testId: "requests-tab-all", exact: true },
  { label: "New", href: "/requests/new", testId: "requests-tab-new", exact: true },
  { label: "Interviews", href: "/requests/interviews", testId: "requests-tab-interviews", exact: false },
];

/** Requests' own tabs: a strip under the page title (PageHeader draws it, see the layout). */
export function RequestsNav() {
  const pathname = usePathname();
  return (
    <nav aria-label="Requests" data-testid="requests-nav" className="rounded-panel border border-line bg-surface px-2 py-1.5 shadow-panel">
      <ScrollStrip className="min-h-9" stripClassName="items-center gap-1">
        {ITEMS.map((it) => {
          const on = pathname === it.href || (!it.exact && pathname.startsWith(`${it.href}/`));
          return (
            <Link
              key={it.href}
              href={it.href}
              data-testid={it.testId}
              aria-current={on ? "page" : undefined}
              className={`flex h-8 flex-none items-center rounded-lg px-3 text-[15px] font-medium whitespace-nowrap ${
                on ? "bg-accent text-on-accent" : "text-text hover:bg-surface2"
              }`}
            >
              {it.label}
            </Link>
          );
        })}
      </ScrollStrip>
    </nav>
  );
}
