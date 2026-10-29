"use client";

import Link from "next/link";

import { DocStatusChip } from "@/app/documents/_components/DocStatusChip";
import { Chip } from "@/components/ds";
import { dmy } from "@/components/simple/PrdTimeline";
import { SimpleEmpty, SimplePage, SimpleSection } from "@/components/simple/SimplePage";
import { Loading } from "@/components/ui";
import { api, unwrap, type Schemas } from "@/lib/api/client";
import { useCompanyZone, dayIn } from "@/lib/dates";
import { useQuery } from "@/lib/use-query";

/**
 * qa-simple-prd-9: a PRD's status as its one-pager heads it: the approved version, and when a
 * newer draft is in progress, both ("Approved v3 · draft in progress").
 */
function PrdStatus({ d }: { d: Schemas["DocumentSummary"] }) {
  if (d.approved_version && d.status !== "approved")
    return (
      <Chip kind="pass" dot data-status="approved">
        Approved v{d.approved_version} · {d.status === "in_review" ? "changes in review" : "draft in progress"}
      </Chip>
    );
  return <DocStatusChip status={d.status} dot />;
}

/** One-pagers (#723 S1): the PRDs I may read (the API lists only those), each opening its one-pager. */
export default function OnePagers() {
  const q = useQuery("simple|one-pagers", () => unwrap(api.GET("/v1/documents", { params: { query: { kind: "prd" } } })));
  const zone = useCompanyZone();
  return (
    // qa-simple-prd-11: a PRD with a plan leads with its plan, so the lead names both.
    <SimplePage title="One-pagers" lead="Every PRD on one page: its plan and timeline, or its problem, bets, outcomes, what we will not do and risks.">
      <SimpleSection title="PRDs" testId="simple-one-pagers">
        {q.error ? (
          <p className="simple-small">{q.error}</p>
        ) : !q.data ? (
          <Loading />
        ) : q.data.length === 0 ? (
          // qa-simple-prd-41: what a one-pager comes from, and where to start one.
          <SimpleEmpty testId="simple-one-pagers-empty">
            No PRDs yet. A one-pager is made from a PRD: start one in{" "}
            <Link href="/documents" className="font-semibold text-accent-ink underline">Detailed › PRDs</Link>, and its one-pager shows here.
          </SimpleEmpty>
        ) : (
          // qa-simple-prd-42: the status sits beside its title, rows are ruled, each says when it changed.
          <ul className="flex flex-col">
            {q.data.map((d) => (
              <li key={d.id} data-testid="one-pager-row" className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line py-3 last:border-b-0 hover:bg-bg/50">
                <Link href={`/simple/one-pagers/${d.slug}`} className="min-w-0 font-semibold break-words hover:underline">
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
