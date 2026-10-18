"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { useMe } from "@/lib/me";

/** A link, or (with `soon`) a disabled entry for a later release. */
type Item = { label: string; testId: string } & ({ href: string; soon?: undefined } | { soon: string; href?: undefined });

const MAIN: Item[] = [
  { label: "Baseline", href: "/baseline", testId: "nav-baseline" },
  { label: "Runs", href: "/runs", testId: "nav-runs" },
  { label: "PRDs", href: "/documents", testId: "nav-prds" },
  { label: "Priorities", href: "/priorities", testId: "nav-priorities" },
  { label: "Roadmap", testId: "nav-roadmap", soon: "v1.1" },
  { label: "Inbox", href: "/inbox", testId: "nav-inbox" },
];

const SETTINGS: Item[] = [
  { label: "Members", href: "/settings/members", testId: "nav-members" },
  { label: "Connections", href: "/settings/connections", testId: "nav-connections" },
  { label: "Sources", href: "/settings/sources", testId: "nav-sources" },
  { label: "Templates", href: "/settings/templates", testId: "nav-templates" },
  { label: "Themes", href: "/settings/themes", testId: "nav-themes" },
];

function isActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

/** Left navigation of the signed-in Oracle. Hidden on /login and when signed out. */
export function AppNav() {
  const pathname = usePathname();
  const { me } = useMe();
  if (!me || pathname === "/login" || pathname.startsWith("/login/")) return null;

  const row = (item: Item) => {
    const base = "flex items-center justify-between rounded-md px-2.5 py-1.5";
    if (!item.href) {
      return (
        <li key={item.testId}>
          <span
            aria-disabled="true"
            data-testid={item.testId}
            title={`Coming in ${item.soon}`}
            className={`${base} cursor-not-allowed text-neutral-400`}
          >
            {item.label}
            <span className="rounded border border-neutral-200 px-1 text-[10px] text-neutral-400">{item.soon}</span>
          </span>
        </li>
      );
    }
    const active = isActive(pathname, item.href);
    return (
      <li key={item.testId}>
        <Link
          href={item.href}
          data-testid={item.testId}
          aria-current={active ? "page" : undefined}
          className={`${base} ${
            active
              ? "bg-neutral-100 font-medium text-neutral-900"
              : "text-neutral-600 hover:bg-neutral-50 hover:text-neutral-900"
          }`}
        >
          {item.label}
        </Link>
      </li>
    );
  };

  return (
    <aside className="w-52 shrink-0 border-r border-neutral-200 bg-white">
      <nav aria-label="Oracle" data-testid="app-nav" className="sticky top-0 px-3 py-4 text-sm">
        <ul className="flex flex-col gap-0.5">{MAIN.map(row)}</ul>
        <p className="mt-6 mb-1 px-2.5 text-xs font-medium text-neutral-500" id="app-nav-settings">
          Settings
        </p>
        <ul className="flex flex-col gap-0.5" aria-labelledby="app-nav-settings" data-testid="nav-settings">
          {SETTINGS.map(row)}
        </ul>
      </nav>
    </aside>
  );
}
