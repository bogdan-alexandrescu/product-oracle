"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { ScrollStrip } from "@/components/ds";

import { useRequestsState } from "./_components/RequestsState";

/*
 * One level of tabs for Requests (qa-work-37): the queue's Themes is a tab here, not a second
 * row, and the requests nobody has decided yet are "To decide", so "New" is only the state
 * chip and the New request button.
 */
const ITEMS = [
  { label: "All requests", href: "/requests", testId: "requests-tab-all", exact: true },
  { label: "To decide", href: "/requests/to-decide", testId: "requests-tab-new", exact: true },
  { label: "Themes", href: "/requests/themes", testId: "requests-tab-themes", exact: true },
  { label: "Interviews", href: "/requests/interviews", testId: "requests-tab-interviews", exact: false },
];

/**
 * Requests' tabs. On a wider screen PageHeader draws them under the title row; on a phone the
 * layout draws them first, at the top of every Requests page, above the header's status and
 * stacked actions (qa-shell-33), so `where` hides each copy where the other one shows.
 */
// qa-docs-88: under the title the header's copy keeps 16 px from it (the page's gap), not 8.
export function RequestsNav({ where }: { where: "header" | "top" }) {
  const pathname = usePathname();
  // The Themes tab counts the themes in use (not archived), as the queue's Themes tab did.
  const themes = useRequestsState().themes.data?.filter((t) => !t.archived).length || null;
  // qa-work-44: an interview's own page has one way back, its "← Interviews", not the tabs too.
  if (/^\/requests\/interviews\/[^/]+/.test(pathname ?? "")) return null;
  return (
    <nav
      aria-label="Requests"
      data-testid={where === "top" ? "requests-nav-top" : "requests-nav"}
      className={`rounded-panel border border-line bg-surface px-2 py-1.5 shadow-panel ${where === "top" ? "hidden max-[600px]:block" : "mt-2 max-[600px]:hidden"}`}
    >
      <ScrollStrip itemsName="tabs" className="min-h-9" stripClassName="items-center gap-1">
        {ITEMS.map((it) => {
          const on = pathname === it.href || (!it.exact && pathname.startsWith(`${it.href}/`));
          return (
            <Link
              key={it.href}
              href={it.href}
              data-testid={it.testId}
              aria-current={on ? "page" : undefined}
              className={`flex h-8 flex-none items-center gap-1.5 rounded-lg px-3 text-[15px] font-medium whitespace-nowrap max-[600px]:h-11 ${
                on ? "bg-accent text-on-accent" : "text-text hover:bg-surface2"
              }`}
            >
              {it.label}
              {it.testId === "requests-tab-themes" && themes != null && (
                // The space keeps "Themes 3" two words to a screen reader; the flex gap draws it.
                <>
                  {" "}
                  <b data-testid="requests-tab-themes-count" className={`tnum font-semibold ${on ? "text-on-accent" : "text-text2"}`}>
                    {themes}
                  </b>
                </>
              )}
            </Link>
          );
        })}
      </ScrollStrip>
    </nav>
  );
}
