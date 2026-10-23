"use client";

import { useMe, type Operation } from "@/lib/me";

/**
 * Settings' tabs, each with the API read its page needs (#370): a tab shows when the
 * signed-in role can call it. Which role that is lives in the API's route roles alone.
 */
export const SETTINGS_TABS: { label: string; href: string; testId: string; read: Operation }[] = [
  { label: "Members", href: "/settings/members", testId: "nav-members", read: "list_people" },
  { label: "Company", href: "/settings/company", testId: "nav-company", read: "get_setting_endpoint" },
  { label: "API tokens", href: "/settings/api-tokens", testId: "nav-api-tokens", read: "list_api_tokens" },
  { label: "Connections", href: "/settings/connections", testId: "nav-connections", read: "list_connections" },
  { label: "Claude accounts", href: "/settings/claude-accounts", testId: "nav-claude-accounts", read: "list_claude_accounts" },
  { label: "Sources", href: "/settings/sources", testId: "nav-sources", read: "list_sources" },
  { label: "Notifications", href: "/settings/notifications", testId: "nav-notifications", read: "list_company_integrations" },
  { label: "Templates", href: "/settings/templates", testId: "nav-templates", read: "list_templates" },
  { label: "Themes", href: "/settings/themes", testId: "nav-themes", read: "list_themes" },
  { label: "Autonomy", href: "/settings/autonomy", testId: "nav-autonomy", read: "get_autonomy" },
  // #482: owners alone delete and restore, so only they see Trash (#370).
  { label: "Trash", href: "/settings/trash", testId: "nav-trash", read: "list_trash" },
];

/** Settings pages that only make something: they need that operation, not just the read. */
export const SETTINGS_WRITES: Record<string, Operation> = {
  "/settings/templates/new": "create_template",
  "/settings/themes/new": "create_theme",
};

/** The tab a Settings path belongs to, if any. */
export function settingsTabOf(pathname: string) {
  return SETTINGS_TABS.find((t) => pathname === t.href || pathname.startsWith(`${t.href}/`));
}

/** The Settings tabs the signed-in role can read; `ready` once capabilities have loaded. */
export function useSettingsTabs() {
  const { can, capsReady } = useMe();
  return { tabs: SETTINGS_TABS.filter((t) => can(t.read)), ready: capsReady };
}
