"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

import { PageHeader } from "@/components/ds";
import { useMe } from "@/lib/me";

import { visibleTabs } from "./_nav";

/** /company opens the first tab the member may see (Strategy). */
export default function CompanyPage() {
  const router = useRouter();
  const { can, capsReady } = useMe();
  useEffect(() => {
    if (!capsReady) return;
    const first = visibleTabs(can)[0];
    if (first) router.replace(first.href);
  }, [can, capsReady, router]);
  return <PageHeader title="Company" />;
}
