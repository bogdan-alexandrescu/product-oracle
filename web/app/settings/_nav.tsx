"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const ITEMS = [
  { label: "Members", href: "/settings/members", testId: "nav-members" },
  { label: "Connections", href: "/settings/connections", testId: "nav-connections" },
  { label: "Claude accounts", href: "/settings/claude-accounts", testId: "nav-claude-accounts" },
  { label: "Sources", href: "/settings/sources", testId: "nav-sources" },
  { label: "Templates", href: "/settings/templates", testId: "nav-templates" },
  { label: "Themes", href: "/settings/themes", testId: "nav-themes" },
];

/** Settings' own sections, a strip under the page header (like the PRD sections strip). */
export function SettingsNav() {
  const pathname = usePathname();
  return (
    <nav
      aria-label="Settings"
      data-testid="settings-nav"
      className="mb-4 flex min-h-12 items-center gap-1 overflow-x-auto rounded-panel border border-line bg-surface px-2 py-1.5 shadow-panel"
    >
      {ITEMS.map((it) => {
        const on = pathname === it.href || pathname.startsWith(`${it.href}/`);
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
    </nav>
  );
}
