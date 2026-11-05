"use client";

import Link from "next/link";

import { Notice } from "@/components/ds";
import { api, unwrap, type Schemas } from "@/lib/api/client";
import { useQuery } from "@/lib/use-query";

import { prdItemRef } from "./_lib";

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
 * Simple's item is the one in the link's roadmap (&roadmap=<slug>) and PRD, as the Plan's row.
 */
export function MissingItem({ wanted, prdId, roadmap }: { wanted: string; prdId: string | null; roadmap: string | null }) {
  const q = useQuery("plan|simple-roadmap", () => unwrap(api.GET("/v1/simple/roadmap")));
  if (q.loading && !q.data) return null;
  const ref = prdItemRef(wanted);
  const keyed = (q.data?.items ?? []).filter((i) => (ref ? i.key === ref.key && i.prd?.slug === ref.prd : i.key === wanted));
  const inRoadmap = keyed.filter((i) => i.roadmap.slug === roadmap);
  const same = inRoadmap.length ? inRoadmap : keyed;
  const found = same.find((i) => i.prd?.id === prdId) ?? same[0];
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
