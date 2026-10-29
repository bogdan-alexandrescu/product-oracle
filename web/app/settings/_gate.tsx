"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, type ReactNode } from "react";

import { Empty, LinkButton, PageHeader, PageSkeleton, Panel } from "@/components/ds";
import { useMe } from "@/lib/me";
import { SETTINGS_WRITES, settingsTabOf, useSettingsTabs } from "@/lib/settings-tabs";

/**
 * #370: a Settings page renders only for a role that can read it. A deep link to a tab the
 * role does not have says so, instead of a form that would fail.
 */
export function SettingsGate({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { tabs, ready } = useSettingsTabs();
  const { can, capsError, me, loading } = useMe();
  const router = useRouter();
  // qa-settings-1: signed out, on to sign-in and back here after (as /home and /account do).
  const signedOut = !loading && !me;
  useEffect(() => {
    if (signedOut) router.replace(`/login?next=${encodeURIComponent(pathname)}`);
  }, [signedOut, router, pathname]);
  const tab = settingsTabOf(pathname);
  if (signedOut) return <Loading />;
  const write = SETTINGS_WRITES[pathname];
  if (!tab || (tabs.includes(tab) && (!write || can(write)))) return children;
  // A failed read says so in the shell, with Retry (#370 fixes 4); no Loading forever.
  if (capsError) return null;
  // qa-shell-10: while the tabs load, the page's shapes, not a bare Loading line.
  if (!ready) return <PageSkeleton bare />;
  return (
    <>
      <PageHeader title={tab.label} />
      <Panel testId="not-for-role" bodyClassName="flex flex-col items-center gap-3 pb-8">
        <Empty icon="lock">Not available for your role</Empty>
        <p className="text-[15px] text-text2">Ask an owner if you need it.</p>
        {tabs[0] && (
          <LinkButton href={tabs[0].href} variant="ghost">
            Open Settings
          </LinkButton>
        )}
      </Panel>
    </>
  );
}
