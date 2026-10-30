"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

import { SELECT_FIELD } from "@/app/settings/_components/fields";
import { LinkButton, ScrollStrip } from "@/components/ds";
import { useSettingsTabs } from "@/lib/settings-tabs";

/**
 * Settings' own sections: a strip under the page title (PageHeader draws it, see the
 * settings layout). Evidence search (/sources) lives under Sources. Opened from Home's Set
 * up checklist (?from=setup), it ends with the way back to Home; another tab drops it.
 * Only the tabs the signed-in role can read show (#370). qa-settings-11: from 1024 px the 13
 * tabs sit in tighter type so they fit one row beside the rail and the Ask strip at 1366 px
 * (narrower, they wrap: every tab in full view). qa-settings-41: on a phone a select lists
 * every Settings page instead of a strip that shows two or three.
 */
export function SettingsNav() {
  const pathname = usePathname();
  const fromSetup = useSearchParams().get("from") === "setup";
  const router = useRouter();
  const { tabs } = useSettingsTabs();
  const isOn = (href: string) =>
    pathname === href ||
    pathname.startsWith(`${href}/`) ||
    (href === "/settings/sources" && (pathname === "/sources" || pathname.startsWith("/sources/")));
  const current = tabs.find((it) => isOn(it.href));
  return (
    <nav
      aria-label="Settings"
      data-testid="settings-nav"
      className="rounded-panel border border-line bg-surface px-2 py-1.5 shadow-panel"
    >
      <div className="hidden flex-wrap items-center gap-2 max-[600px]:flex">
        {/* The label does not wrap the select: its options' words would join its name. */}
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <label htmlFor="settings-nav-select" className="flex-none text-[13px] font-semibold text-text2">
            Settings page
          </label>
          <select
            id="settings-nav-select"
            data-testid="settings-nav-select"
            value={current?.href ?? ""}
            onChange={(e) => e.target.value && router.push(e.target.value)}
            className={SELECT_FIELD}
          >
            {!current && <option value="">Choose a page</option>}
            {tabs.map((it) => (
              <option key={it.href} value={it.href}>
                {it.label}
              </option>
            ))}
          </select>
        </div>
        {fromSetup && (
          <LinkButton href="/home" variant="ghost" icon="home" className="flex-none">
            Back to Home
          </LinkButton>
        )}
      </div>
      <ScrollStrip itemsName="tabs" className="min-h-9 max-[600px]:hidden" stripClassName="items-center gap-1 lg:flex-wrap lg:gap-0.5">
        {tabs.map((it) => {
          const on = isOn(it.href);
          return (
            <Link
              key={it.href}
              href={it.href}
              data-testid={it.testId}
              aria-current={on ? "page" : undefined}
              className={`flex h-8 flex-none items-center rounded-lg px-3 text-[15px] font-medium whitespace-nowrap lg:px-2 lg:text-[14px] ${
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
