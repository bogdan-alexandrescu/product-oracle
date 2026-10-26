"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

import { ErrorNote, Loading } from "@/components/ui";
import { api, unwrap } from "@/lib/api/client";
import { useQuery } from "@/lib/use-query";

/**
 * The Plan header's Alignment report (F6 AC14): opens the newest report, or the list when
 * there is none yet. The header links here rather than to an id it loads itself, so a click
 * before that load lands on the latest report, not the list.
 */
export default function LatestReportPage() {
  const router = useRouter();
  const q = useQuery("alignment-reports|latest", () => unwrap(api.GET("/v1/alignment-reports", { params: { query: { limit: 1 } } })));
  const latest = q.data?.[0]?.id;
  const none = q.data != null && latest == null;
  useEffect(() => {
    if (latest) router.replace(`/plan/reports/${latest}`);
    else if (none) router.replace("/plan/reports");
  }, [router, latest, none]);
  return <div className="px-6 py-8">{q.error ? <ErrorNote>{q.error}</ErrorNote> : <Loading />}</div>;
}
