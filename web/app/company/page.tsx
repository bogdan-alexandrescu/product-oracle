"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

import { Loading } from "@/components/ui";
import { useMe } from "@/lib/me";

import { visibleTabs } from "./_nav";

/**
 * /company opens the first tab the member may see (Strategy). It draws no title of its own
 * (qa-shell-26): the tab it opens has the one H1 "Company".
 */
export default function CompanyPage() {
  const router = useRouter();
  const { can, capsReady } = useMe();
  useEffect(() => {
    if (!capsReady) return;
    const first = visibleTabs(can)[0];
    if (first) router.replace(first.href);
  }, [can, capsReady, router]);
  return <Loading />;
}
