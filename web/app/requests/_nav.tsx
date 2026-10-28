"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { ScrollStrip } from "@/components/ds";

/*
 * One level of tabs for Requests (qa-work-37): the queue's Themes is a tab here, not a second
 * row, and the requests nobody has decided yet are "To decide", so "New" is only the state
 * chip and the New request button.
 */
const ITEMS = [
  { label: "All requests", href: "/requests", testId: "requests-tab-all", exact: true },
  { label: "To decide", href: "/requests/new", testId: "requests-tab-new", exact: true },
  { label: "Themes", href: "/requests/themes", testId: "requests-tab-themes", exact: true },
  { label: "Interviews", href: "/requests/interviews", testId: "requests-tab-interviews", exact: false },
];

/**
 * Requests' tabs. On a wider screen PageHeader draws them under the title row; on a phone the
 * layout draws them first, at the top of every Requests page, above the header's status and
 * stacked actions (qa-shell-33), so `where` hides each copy where the other one shows.
 */
export function RequestsNav({ where }: { where: "header" | "top" }) {
  const pathname = usePathname();
  return (
    <nav
      aria-label="Requests"
      data-testid={where === "top" ? "requests-nav-top" : "requests-nav"}
      className={`rounded-panel border border-line bg-surface px-2 py-1.5 shadow-panel ${where === "top" ? "hidden max-[600px]:block" : "max-[600px]:hidden"}`}
    >
      <ScrollStrip className="min-h-9" stripClassName="items-center gap-1">
        {ITEMS.map((it) => {
          const on = pathname === it.href || (!it.exact && pathname.startsWith(`${it.href}/`));
          return (
            <Link
              key={it.href}
              href={it.href}
              data-testid={it.testId}
              aria-current={on ? "page" : undefined}
              className={`flex h-8 flex-none items-center rounded-lg px-3 text-[15px] font-medium whitespace-nowrap max-[600px]:h-11 ${
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
