"use client";

import { Panel } from "@/components/ds";
import { foldWaiting, useWaitingList, WaitingRow } from "@/components/simple/WaitingItems";

/**
 * simple-home-qa-nov14 (missing feature a): the broken links Home counts and sends to the Inbox,
 * one row per item as Decisions folds them, each fixed in place with Fix the link. Their own panel,
 * outside "Needs you", as Home's and Decisions' counts already hold them.
 */
export function BrokenLinks() {
  // simple-call-budget: the rail's Decisions count reads the same list a moment before; this
  // takes that answer (stale-ok), so moving to the Inbox reads it no more.
  const { data } = useWaitingList({ staleOk: true });
  const links = (data?.items ?? []).filter((i) => i.kind === "broken_link");
  if (!links.length) return null;
  const rows = foldWaiting(links);
  return (
    <div className="mt-3">
      <Panel title="Broken links" count={links.length} testId="inbox-broken-links">
        <ul className="px-4">
          {rows.map((r) => (
            <WaitingRow key={r.key} item={r.item} links={r.links} />
          ))}
        </ul>
      </Panel>
    </div>
  );
}
