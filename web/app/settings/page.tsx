"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

import { Loading } from "@/components/ui";
import { useSettingsTabs } from "@/lib/settings-tabs";

/** Settings opens on the first tab the signed-in role can read (#370). */
export default function SettingsPage() {
  const router = useRouter();
  const { tabs, ready } = useSettingsTabs();
  const first = tabs[0]?.href;
  useEffect(() => {
    if (ready) router.replace(first ?? "/home");
  }, [ready, first, router]);
  return <Loading />;
}
