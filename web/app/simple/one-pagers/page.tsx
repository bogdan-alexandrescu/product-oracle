"use client";

import Link from "next/link";

import { DocStatusChip } from "@/app/documents/_components/DocStatusChip";
import { SimpleEmpty, SimplePage, SimpleSection } from "@/components/simple/SimplePage";
import { Loading } from "@/components/ui";
import { api, unwrap } from "@/lib/api/client";
import { useQuery } from "@/lib/use-query";

/** One-pagers (#723 S1): the PRDs I may read (the API lists only those), each opening its one-pager. */
export default function OnePagers() {
  const q = useQuery("simple|one-pagers", () => unwrap(api.GET("/v1/documents", { params: { query: { kind: "prd" } } })));
  return (
    <SimplePage title="One-pagers" lead="Every PRD on one page: its problem, bets, outcomes, what we will not do, risks and timeline.">
      <SimpleSection title="PRDs" testId="simple-one-pagers">
        {q.error ? (
          <p className="simple-small">{q.error}</p>
        ) : !q.data ? (
          <Loading />
        ) : q.data.length === 0 ? (
          <SimpleEmpty testId="simple-one-pagers-empty">No PRDs yet.</SimpleEmpty>
        ) : (
          <ul className="flex flex-col gap-3">
            {q.data.map((d) => (
              <li key={d.id} className="flex flex-wrap items-center justify-between gap-2">
                <Link href={`/simple/one-pagers/${d.slug}`} className="min-w-0 font-semibold break-words hover:underline">
                  {d.title}
                </Link>
                <DocStatusChip status={d.status} dot />
              </li>
            ))}
          </ul>
        )}
      </SimpleSection>
    </SimplePage>
  );
}
