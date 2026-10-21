"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";

import { LinkButton, ScrollStrip } from "@/components/ds";

const ITEMS = [
  { label: "Members", href: "/settings/members", testId: "nav-members" },
  { label: "Company", href: "/settings/company", testId: "nav-company" },
  { label: "Connections", href: "/settings/connections", testId: "nav-connections" },
  { label: "Claude accounts", href: "/settings/claude-accounts", testId: "nav-claude-accounts" },
  { label: "Sources", href: "/settings/sources", testId: "nav-sources" },
  { label: "Notifications", href: "/settings/notifications", testId: "nav-notifications" },
  { label: "Templates", href: "/settings/templates", testId: "nav-templates" },
  { label: "Themes", href: "/settings/themes", testId: "nav-themes" },
  { label: "Autonomy", href: "/settings/autonomy", testId: "nav-autonomy" },
];

/**
 * Settings' own sections: a strip under the page title (PageHeader draws it, see the
 * settings layout). Evidence search (/sources) lives under Sources. Opened from Home's Set
 * up checklist (?from=setup), it ends with the way back to Home; another tab drops it.
 */
export function SettingsNav() {
  const pathname = usePathname();
  const fromSetup = useSearchParams().get("from") === "setup";
  return (
    <nav
      aria-label="Settings"
      data-testid="settings-nav"
      className="rounded-panel border border-line bg-surface px-2 py-1.5 shadow-panel"
    >
      <ScrollStrip className="min-h-9" stripClassName="items-center gap-1">
        {ITEMS.map((it) => {
          const on =
            pathname === it.href ||
            pathname.startsWith(`${it.href}/`) ||
            (it.href === "/settings/sources" && (pathname === "/sources" || pathname.startsWith("/sources/")));
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
        {fromSetup && (
          <LinkButton href="/home" variant="ghost" icon="home" className="ml-auto flex-none" data-testid="nav-back-home">
            Back to Home
          </LinkButton>
        )}
      </ScrollStrip>
    </nav>
  );
}
