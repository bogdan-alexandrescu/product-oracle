"use client";

import Link from "next/link";

import { SuggestionCard } from "@/components/SuggestionCard";
import { Chip, Empty } from "@/components/ds";
import { FeedbackStatusChip, Quote, VerdictChip } from "@/components/review/parts";
import { ErrorNote, Loading } from "@/components/ui";
import { api, unwrap, type FeedbackItem, type FeedbackStatus } from "@/lib/api/client";
import { sectionHref } from "@/lib/section-link";
import { useQuery } from "@/lib/use-query";

/** One row of the resolution report: how an earlier item was handled. */
function FeedbackRow({ item, doc, current }: { item: FeedbackItem; doc: string; current: number }) {
  const href = sectionHref(doc, item.raised_on_version, item.section_key);
  return (
    <li className="border-b border-line py-3 last:border-b-0" data-testid="feedback-item">
      <div className="flex flex-wrap items-center gap-1.5">
        <FeedbackStatusChip status={item.status} />
        {item.verdict ? <VerdictChip verdict={item.verdict} /> : <Chip kind="line">{item.kind === "comment" ? "Comment" : "General"}</Chip>}
        <span className="tnum ml-auto text-[13px] text-text2">
          raised on v{item.raised_on_version}
          {item.addressed_in_version != null && ` · addressed in v${item.addressed_in_version}`}
        </span>
      </div>
      <p className="mt-1.5 text-[15px] leading-[22px] text-text">{item.summary}</p>
      {item.anchor && <Quote>{item.anchor.exact}</Quote>}
      {item.resolution_note && (
        <p className="mt-1 text-sm leading-5 text-text2">
          <span className="font-semibold text-text">Resolution:</span> {item.resolution_note}
        </p>
      )}
      {item.section_key && (
        <Link href={href} className="mt-1 inline-block font-mono text-[13px] text-accent-ink hover:underline">
          #{item.section_key}
          {item.raised_on_version !== current && ` (v${item.raised_on_version})`}
        </Link>
      )}
      {item.suggestion && <SuggestionCard key={`${item.suggestion.id}|${item.suggestion.updated_at}`} suggestion={item.suggestion} />}
    </li>
  );
}

/** How this version handled feedback raised on earlier versions; `sectionKeys` keeps only those sections' items. */
export function ResolutionPanel({
  doc,
  n,
  refreshKey,
  sectionKeys,
}: {
  doc: string;
  n: number;
  refreshKey: number;
  sectionKeys?: ReadonlySet<string> | null;
}) {
  const q = useQuery(`${doc}|${n}|${refreshKey}`, () =>
    unwrap(api.GET("/v1/documents/{doc}/versions/{n}/resolution-report", { params: { path: { doc, n } } })),
  );
  if (q.error) return <ErrorNote>{q.error}</ErrorNote>;
  if (!q.data) return <Loading />;
  const items = sectionKeys
    ? q.data.items.filter((f) => !!f.section_key && sectionKeys.has(f.section_key))
    : q.data.items;
  if (items.length === 0) {
    return <Empty>No earlier feedback</Empty>;
  }
  const counts = sectionKeys
    ? items.reduce<Record<string, number>>((m, f) => ({ ...m, [f.status]: (m[f.status] ?? 0) + 1 }), {})
    : q.data.counts;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-3">
        {Object.entries(counts).map(([s, count]) => (
          <span key={s} className="tnum inline-flex items-center gap-1.5 text-sm font-bold">
            <FeedbackStatusChip status={s as FeedbackStatus} /> {count}
          </span>
        ))}
      </div>
      <ol className="flex flex-col">
        {items.map((f) => (
          <FeedbackRow key={f.id} item={f} doc={doc} current={n} />
        ))}
      </ol>
    </div>
  );
}
