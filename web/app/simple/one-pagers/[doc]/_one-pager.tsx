"use client";

import Link from "next/link";

import { SimplePage } from "@/components/simple/SimplePage";
import { ErrorNote, Loading } from "@/components/ui";
import { api, unwrap } from "@/lib/api/client";
import { useQuery } from "@/lib/use-query";

/** A PRD's one-pager (#723): a placeholder until S5 builds it, with the PRD in Studio. */
export function OnePager({ slug }: { slug: string }) {
  const q = useQuery(`simple|one-pager|${slug}`, () => unwrap(api.GET("/v1/documents/{doc}", { params: { path: { doc: slug } } })));
  const title = q.data?.title ?? "One-pager";
  return (
    <SimplePage title={title}>
      {q.error && <ErrorNote>{q.error}</ErrorNote>}
      {!q.data && !q.error && <Loading />}
      <div className="simple-card" data-testid="one-pager-placeholder">
        <p>This PRD&apos;s one-pager arrives with S5: its problem, bets, outcomes, what we will not do, risks and timeline on one page.</p>
        <p>
          <Link href={`/documents/${slug}`} className="font-semibold text-accent-ink hover:underline">
            Open the PRD in Studio
          </Link>
        </p>
      </div>
    </SimplePage>
  );
}
