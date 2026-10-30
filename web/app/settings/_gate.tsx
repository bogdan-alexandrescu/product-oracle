"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, type ReactNode } from "react";

import { Empty, LinkButton, PageHeader, PageSkeleton, Panel } from "@/components/ds";
import { api, unwrap, type Schemas } from "@/lib/api/client";
import { useMe } from "@/lib/me";
import { useQuery } from "@/lib/use-query";
import { SETTINGS_WRITES, settingsTabOf, useSettingsTabs } from "@/lib/settings-tabs";

/** Where a role turned away from a page finds what it can have instead (qa-settings-37). */
const ELSEWHERE: Record<string, { text: string; href: string; label: string }> = {
  "/settings/api-tokens": {
    text: "Owners see every token here. Your own API tokens are on My account.",
    href: "/account",
    label: "Open My account",
  },
};

/**
 * #370: a Settings page renders only for a role that can read it. A deep link to a tab the
 * role does not have says so, instead of a form that would fail.
 */
export function SettingsGate({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { tabs, ready } = useSettingsTabs();
  const { can, capsError, me, loading } = useMe();
  const router = useRouter();
  const tab = settingsTabOf(pathname);
  const write = SETTINGS_WRITES[pathname];
  const turnedAway = !!me && !!tab && !(tabs.includes(tab) && (!write || can(write)));
  // qa-settings-37: who to ask, by name (every member reads the people list).
  const peopleQ = useQuery(turnedAway ? "people|owners" : "", () =>
    turnedAway ? unwrap(api.GET("/v1/people", { params: { query: { limit: 500 } } })) : Promise.resolve([] as Schemas["PersonOut"][]),
  );
  const owners = (peopleQ.data ?? []).filter((p) => p.role === "owner").map((p) => p.name);
  const askOwner = owners.length ? `Ask an owner (${owners.join(" or ")}) if you need it.` : "Ask an owner if you need it.";
  // qa-settings-1: signed out, on to sign-in and back here after (as /home and /account do).
  const signedOut = !loading && !me;
  useEffect(() => {
    if (signedOut) router.replace(`/login?next=${encodeURIComponent(pathname)}`);
  }, [signedOut, router, pathname]);
  if (signedOut) return <PageSkeleton bare />;
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
        <p className="text-[15px] text-text2">{ELSEWHERE[pathname]?.text ?? askOwner}</p>
        {ELSEWHERE[pathname] ? (
          <LinkButton href={ELSEWHERE[pathname].href} variant="secondary">
            {ELSEWHERE[pathname].label}
          </LinkButton>
        ) : tabs[0] && (
          <LinkButton href={tabs[0].href} variant="ghost">
            Open {tabs[0].label}
          </LinkButton>
        )}
      </Panel>
    </>
  );
}
