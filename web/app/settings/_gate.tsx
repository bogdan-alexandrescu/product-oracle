"use client";

import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

import { Icon, LinkButton, PageHeader, Panel } from "@/components/ds";
import { Loading } from "@/components/ui";
import { useMe } from "@/lib/me";
import { SETTINGS_WRITES, settingsTabOf, useSettingsTabs } from "@/lib/settings-tabs";

/** Where a locked Settings page sends the person back to. */
export type GateBack = { href: string; label: string };

/**
 * #370: a Settings page renders only for a role that can read it. A deep link to a tab the
 * role does not have says so, instead of a form that would fail. qa-settings-30: compact,
 * with a way back. `back` overrides it; by default a page that only makes something (New
 * template) goes back to its own tab when the role reads that, else to the first tab the
 * role can read.
 */
export function SettingsGate({ children, back }: { children: ReactNode; back?: GateBack }) {
  const pathname = usePathname();
  const { tabs, ready } = useSettingsTabs();
  const { can, capsError } = useMe();
  const tab = settingsTabOf(pathname);
  const write = SETTINGS_WRITES[pathname];
  const readable = !!tab && tabs.includes(tab);
  if (!tab || (readable && (!write || can(write)))) return children;
  // A failed read says so in the shell, with Retry (#370 fixes 4); no Loading forever.
  if (capsError) return null;
  if (!ready) return <Loading />;
  const way: GateBack | null =
    back ?? (readable ? { href: tab.href, label: `Back to ${tab.label}` } : tabs[0] ? { href: tabs[0].href, label: "Open Settings" } : null);
  return (
    <>
      <PageHeader title={tab.label} />
      <Panel testId="not-for-role" bodyClassName="flex flex-wrap items-center gap-3 px-4 py-3">
        <span aria-hidden className="grid size-9 flex-none place-items-center rounded-full bg-accent-soft text-accent-ink">
          <Icon name="lock" size={18} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[15px] font-semibold text-text">Not available for your role</p>
          <p className="text-sm text-text2">Ask an owner if you need it.</p>
        </div>
        {way && (
          <LinkButton href={way.href} variant="secondary">
            {way.label}
          </LinkButton>
        )}
      </Panel>
    </>
  );
}
