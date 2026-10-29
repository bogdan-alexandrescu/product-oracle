"use client";

import Link from "next/link";

import { OnePager as Paper } from "@/components/simple/OnePager";
import { SimplePage } from "@/components/simple/SimplePage";
import { Loading } from "@/components/ui";
import { api, unwrap } from "@/lib/api/client";
import { useQuery } from "@/lib/use-query";

/**
 * A PRD's one-pager (#723): S5's page ("A · Paper", components/simple/OnePager), the route the
 * One-pagers list, Home and the mode switch open. Another kind of document (a roadmap, a
 * strategy) has no one-pager: it says so and links the document in Detailed (#725 review).
 */
export function OnePager({ slug }: { slug: string }) {
  const q = useQuery(`simple|one-pager|${slug}`, () => unwrap(api.GET("/v1/documents/{doc}", { params: { path: { doc: slug } } })));
  const notPrd = !!q.data && q.data.kind !== "prd";
  // The one-pager's own read is the authority when the document's is refused or missing: it
  // shows the page, or says itself why not (qa-simple-prd-12: this is the one address).
  if ((q.data && !notPrd) || q.error) return <Paper doc={slug} />;
  const title = notPrd ? "One-pager" : (q.data?.title ?? "One-pager");
  return (
    <SimplePage title={title}>
      {!q.data && !q.error && <Loading />}
      {notPrd && (
        <div className="simple-card" data-testid="one-pager-not-found">
          <p>No one-pager here: one-pagers are for PRDs, and {q.data?.title ?? "this document"} is not one.</p>
          <p>
            <Link href={`/documents/${slug}`} className="font-semibold text-accent-ink hover:underline">
              Open the detailed view
            </Link>
          </p>
        </div>
      )}
    </SimplePage>
  );
}
