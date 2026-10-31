"use client";

import Link from "next/link";

import { PrdStatus } from "@/components/simple/PrdStatus";
import { dmy } from "@/components/simple/PrdTimeline";
import { SimpleEmpty, SimplePage, SimpleSection } from "@/components/simple/SimplePage";
import { Loading } from "@/components/ui";
import { api, unwrap } from "@/lib/api/client";
import { useCompanyZone, dayIn } from "@/lib/dates";
import { useQuery } from "@/lib/use-query";

/** One-pagers (#723 S1): the PRDs I may read (the API lists only those), each opening its one-pager. */
export default function OnePagers() {
  const q = useQuery("simple|one-pagers", () => unwrap(api.GET("/v1/documents", { params: { query: { kind: "prd" } } })));
  const zone = useCompanyZone();
  // qa-simple-prd-p3-30: newest first, by when each last changed (and the list says so).
  const rows = q.data ? [...q.data].sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at)) : null;
  return (
    // qa4-simple-prd-25: a help line, saying what a person can do here.
    <SimplePage title="One-pagers" lead="Open a PRD to read it on one page, change its wording or start a review.">
      <SimpleSection
        title="PRDs"
        testId="simple-one-pagers"
        action={rows && rows.length > 1 ? <span className="simple-small" data-testid="one-pagers-order">Newest first</span> : undefined}
      >
        {q.error ? (
          <p className="simple-small">{q.error}</p>
        ) : !rows ? (
          <Loading />
        ) : rows.length === 0 ? (
          // qa-simple-prd-41: what a one-pager comes from, and where to start one.
          <SimpleEmpty testId="simple-one-pagers-empty">
            No PRDs yet. A one-pager is made from a PRD: start one in{" "}
            <Link href="/documents" className="font-semibold text-accent-ink underline">Detailed › PRDs</Link>, and its one-pager shows here.
          </SimpleEmpty>
        ) : (
          // qa-simple-prd-42: the status sits beside its title, rows are ruled, each says when it changed.
          // qa-simple-prd-p3-29: the whole row opens the one-pager, as its hover says: the title's
          // link stretches over the row (one link still, its name the title).
          <ul className="flex flex-col">
            {rows.map((d) => (
              <li key={d.id} data-testid="one-pager-row" className="relative flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line py-3 last:border-b-0 hover:bg-bg/50">
                <Link href={`/simple/one-pagers/${d.slug}`} className="min-w-0 font-semibold break-words after:absolute after:inset-0 after:content-[''] hover:underline">
                  {d.title}
                </Link>
                <PrdStatus d={d} />
                <span className="simple-small ml-auto">Updated {dmy(dayIn(d.updated_at, zone))}</span>
              </li>
            ))}
          </ul>
        )}
      </SimpleSection>
    </SimplePage>
  );
}
