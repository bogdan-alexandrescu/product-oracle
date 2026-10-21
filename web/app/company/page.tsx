"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

import { PageHeader } from "@/components/ds";
import { useMe } from "@/lib/me";

import { visibleTabs } from "./_nav";

/** /company opens the first tab the member may see (Strategy). */
export default function CompanyPage() {
  const router = useRouter();
  const { role, loading } = useMe();
  useEffect(() => {
    if (loading) return;
    const first = visibleTabs(role)[0];
    if (first) router.replace(first.href);
  }, [role, loading, router]);
  return <PageHeader title="Company" />;
}
