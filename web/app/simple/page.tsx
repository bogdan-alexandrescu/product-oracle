"use client";

import Link from "next/link";
import type { ReactNode } from "react";

import { SimpleEmpty, SimplePage, SimpleSection } from "@/components/simple/SimplePage";
import { Loading } from "@/components/ui";
import { api, unwrap } from "@/lib/api/client";
import { formatDateTime } from "@/lib/format";
import { useQuery } from "@/lib/use-query";
import { loadInbox } from "@/lib/waiting";

type Waiting = { key: string; title: string; detail: string; href: string };

/** What waits on me, in Simple's words: the Inbox's decision rows I decide and the checkpoints I may decide. */
function useWaiting() {
  return useQuery("simple|waiting", async (): Promise<Waiting[]> => {
    const inbox = await loadInbox();
    const decisions = inbox.decisions
      .filter((d) => d.counts)
      .map((d) => ({
        key: `d-${d.id}`,
        title: d.title,
        detail: d.reason === "review_due" ? "Review due" : "Needs your decision",
        href: `/company/decisions?d=${d.number}`,
      }));
    const checkpoints = inbox.checkpoints
      .filter((c) => c.status === "pending" && c.can_decide !== false)
      .map((c) => ({
        key: `c-${c.id}`,
        title: c.segment_title ?? c.flow_title,
        detail: c.approve_label ?? "Waiting for your review",
        href: c.review_link ?? `/runs/${c.run_id}`,
      }));
    return [...decisions, ...checkpoints];
  });
}

function Part<T>({ q, empty, emptyId, children }: { q: { data: T[] | undefined; error: string | null }; empty: string; emptyId: string; children: (rows: T[]) => ReactNode }) {
  if (q.error) return <p className="simple-small">{q.error}</p>;
  if (!q.data) return <Loading />;
  if (q.data.length === 0) return <SimpleEmpty testId={emptyId}>{empty}</SimpleEmpty>;
  return <>{children(q.data)}</>;
}

/**
 * Simple's Home (#723 S1): decisions waiting for me, the next meeting (H2 rituals) and this
 * quarter's plan (the Plan's Now items) as a strip, each with its empty state. Proposals on my
 * items and what changed since my last visit arrive with later parts of Simple.
 */
export default function SimpleHome() {
  const waiting = useWaiting();
  const meeting = useQuery("simple|next-meeting", async () => {
    const rituals = await unwrap(api.GET("/v1/rituals"));
    const next = rituals
      .filter((r) => r.status === "active" && r.next_due_at)
      .sort((a, b) => a.next_due_at!.localeCompare(b.next_due_at!))[0];
    return next ? [next] : [];
  });
  const quarter = useQuery("simple|quarter", async () => {
    const plan = await unwrap(api.GET("/v1/plan"));
    return plan.items.filter((i) => i.horizon === "now").sort((a, b) => a.position - b.position);
  });

  return (
    <SimplePage title="Home">
      <SimpleSection title="Waiting for you" testId="simple-waiting">
        <Part q={waiting} empty="Nothing waits on you." emptyId="simple-waiting-empty">
          {(rows) => (
            <ul className="flex flex-col gap-3">
              {rows.map((w) => (
                <li key={w.key} data-testid="simple-waiting-item" className="flex flex-col">
                  <Link href={w.href} className="font-semibold hover:underline">
                    {w.title}
                  </Link>
                  <span className="simple-small">{w.detail}</span>
                </li>
              ))}
            </ul>
          )}
        </Part>
      </SimpleSection>

      <SimpleSection title="Next meeting" testId="simple-meeting">
        <Part q={meeting} empty="No meeting scheduled." emptyId="simple-meeting-empty">
          {([r]) => (
            <p data-testid="simple-meeting-next" className="flex flex-col">
              <Link href="/simple/meetings" className="font-semibold hover:underline">
                {r.title}
              </Link>
              <span className="simple-small tnum">{formatDateTime(r.next_due_at!)}</span>
            </p>
          )}
        </Part>
      </SimpleSection>

      <SimpleSection
        title="This quarter"
        testId="simple-quarter"
        action={
          <Link href="/simple/roadmap" className="simple-small font-semibold hover:underline">
            Roadmap
          </Link>
        }
      >
        <Part q={quarter} empty="Nothing planned for this quarter yet." emptyId="simple-quarter-empty">
          {(items) => (
            <ol className="-mx-1 flex gap-3 overflow-x-auto px-1 pb-1" aria-label="This quarter's items">
              {items.map((i) => (
                <li key={i.id} data-testid="simple-quarter-item" className="flex w-60 flex-none flex-col gap-1 rounded-[var(--simple-card-radius)] bg-surface2 p-4">
                  <span className="font-semibold">{i.title}</span>
                  {i.prd ? (
                    <Link href={`/simple/one-pagers/${i.prd.slug}`} className="simple-small truncate hover:underline">
                      {i.prd.title}
                    </Link>
                  ) : (
                    i.outcome && <span className="simple-small line-clamp-2">{i.outcome}</span>
                  )}
                </li>
              ))}
            </ol>
          )}
        </Part>
      </SimpleSection>
    </SimplePage>
  );
}
