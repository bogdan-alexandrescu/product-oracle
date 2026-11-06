"use client";

import Link from "next/link";

import { Button, Notice } from "@/components/ds";
import { api, unwrap, type Schemas } from "@/lib/api/client";
import { useQuery } from "@/lib/use-query";

import { prdItemRef, wantedRow } from "./_lib";

type SimpleItem = Schemas["SimpleRoadmapItem"];

/** Where an item off the Plan lives, as one line: "F-06 Team invite nudges is not on the Plan yet: it is in Guided setup's draft". */
export function missingLine(i: SimpleItem): string {
  const name = i.code ? `${i.code} ${i.title}` : i.title;
  const where = i.draft ? (i.prd ? `in ${i.prd.title}'s draft` : "in a draft") : `on the ${i.roadmap.title}`;
  return `${name} is not on the Plan yet: it is ${where}`;
}

/**
 * plan-open-from-simple: /plan?item=<key> (or a report's "<prd>:<key>") names an item the Plan
 * does not show (only a draft not approved yet holds it, say). One line at the top says where it
 * is, with a link to its card on the company roadmap (Simple's), never another item in its place.
 * Simple's item is the one in the link's roadmap (&roadmap=<slug>), never another roadmap's, and
 * its PRD, as the Plan's row. When Approved only hides it (Approved + drafts shows it), the line
 * says so and its one action shows the drafts.
 */
export function MissingItem({
  wanted,
  prdId,
  roadmap,
  scope,
  onShowDrafts,
}: {
  wanted: string;
  prdId: string | null;
  roadmap: string | null;
  scope: "all" | "approved";
  onShowDrafts: () => void;
}) {
  const q = useQuery("plan|simple-roadmap", () => unwrap(api.GET("/v1/simple/roadmap")));
  const withDrafts = useQuery(`plan|missing-item|${scope}`, () =>
    scope === "approved" ? unwrap(api.GET("/v1/plan", { params: { query: { scope: "all" } } })) : Promise.resolve(null),
  );
  if ((q.loading && !q.data) || (withDrafts.loading && !withDrafts.data)) return null;
  const ref = prdItemRef(wanted);
  const keyed = (q.data?.items ?? []).filter((i) => (ref ? i.key === ref.key && i.prd?.slug === ref.prd : i.key === wanted));
  const same = roadmap == null ? keyed : keyed.filter((i) => i.roadmap.slug === roadmap);
  const found = same.find((i) => i.prd?.id === prdId) ?? same[0];
  const draftRow = withDrafts.data ? wantedRow(withDrafts.data.items, wanted, prdId, roadmap) : undefined;
  if (draftRow) {
    const name = found ? (found.code ? `${found.code} ${found.title}` : found.title) : draftRow.title;
    return (
      <Notice testId="plan-missing-item" action={<Button onClick={onShowDrafts}>Show drafts</Button>}>
        {name} is only in a draft, and the Plan shows Approved only
      </Notice>
    );
  }
  if (!found) {
    return <Notice testId="plan-missing-item">The item you opened is not on the Plan.</Notice>;
  }
  return (
    <Notice
      testId="plan-missing-item"
      action={
        <Link href={`/simple/roadmap?item=${encodeURIComponent(found.id)}`} className="font-semibold underline underline-offset-2">
          Open it on the roadmap
        </Link>
      }
    >
      {missingLine(found)}
    </Notice>
  );
}
