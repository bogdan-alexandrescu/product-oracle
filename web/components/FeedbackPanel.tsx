"use client";

import Link from "next/link";
import { useState } from "react";

import { SuggestionCard } from "@/components/SuggestionCard";
import { FeedbackStateChip } from "@/components/review/FeedbackState";
import { Chip, Empty } from "@/components/ds";
import { FeedbackStatusChip, Quote, SELECT, VerdictChip } from "@/components/review/parts";
import { ErrorNote, Loading } from "@/components/ui";
import { api, unwrap, type FeedbackItem, type FeedbackStatus, type VersionSummary } from "@/lib/api/client";
import { STATUS_LABEL } from "@/lib/format";
import { hasRole, useMe } from "@/lib/me";
import { useQuery } from "@/lib/use-query";

const STATUSES = Object.keys(STATUS_LABEL) as FeedbackStatus[];

function FeedbackRow({
  item,
  doc,
  current,
  onChanged,
}: {
  item: FeedbackItem;
  doc: string;
  current: number;
  onChanged?: () => void;
}) {
  const { role } = useMe();
  const href = `/documents/${doc}/v/${item.raised_on_version}${item.section_key ? `#s-${item.section_key}` : ""}`;
  return (
    <li className="border-b border-line py-3 last:border-b-0" data-testid="feedback-item">
      <div className="flex flex-wrap items-center gap-1.5">
        <FeedbackStateChip item={item} />
        {item.verdict ? <VerdictChip verdict={item.verdict} /> : <Chip kind="line">{item.kind === "comment" ? "Comment" : "General"}</Chip>}
        <span className="tnum ml-auto text-[13px] text-text2">
          raised on v{item.raised_on_version}
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
      {item.suggestion && (
        <SuggestionCard
          key={`${item.suggestion.id}|${item.suggestion.updated_at}`}
          suggestion={item.suggestion}
          canDecide={hasRole(role, "approver") && !!onChanged}
          onChanged={() => onChanged?.()}
        />
      )}
    </li>
  );
}

/**
 * Every comment and section verdict on the document, filterable by status and version;
 * `sectionKeys` keeps only the items raised on those sections (the open one).
 */
export function FeedbackPanel({
  doc,
  current,
  versions,
  refreshKey,
  sectionKeys,
}: {
  doc: string;
  current: number;
  versions: VersionSummary[];
  refreshKey: number;
  sectionKeys?: ReadonlySet<string> | null;
}) {
  const [status, setStatus] = useState<FeedbackStatus | "">("");
  const [version, setVersion] = useState<number | "">("");
  const q = useQuery(`${doc}|${status}|${version}|${refreshKey}`, () =>
    unwrap(
      api.GET("/v1/documents/{doc}/feedback", {
        params: {
          path: { doc },
          query: { ...(status ? { status } : {}), ...(version !== "" ? { version } : {}) },
        },
      }),
    ),
  );
  const items = q.data && sectionKeys ? q.data.filter((f) => !!f.section_key && sectionKeys.has(f.section_key)) : q.data;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex min-w-0 flex-1">
          <span className="sr-only">Status</span>
          <select
            aria-label="Filter by status"
            value={status}
            onChange={(e) => setStatus(e.target.value as FeedbackStatus | "")}
            className={`${SELECT} w-full`}
          >
            <option value="">All statuses</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {STATUS_LABEL[s]}
              </option>
            ))}
          </select>
        </label>
        <label className="flex min-w-0 flex-1">
          <span className="sr-only">Raised on</span>
          <select
            aria-label="Filter by version"
            value={version}
            onChange={(e) => setVersion(e.target.value ? Number(e.target.value) : "")}
            className={`${SELECT} w-full`}
          >
            <option value="">All versions</option>
            {versions.map((v) => (
              <option key={v.number} value={v.number}>
                Raised on v{v.number}
              </option>
            ))}
          </select>
        </label>
        {items && (
          <span className="tnum flex-none text-[13px] font-semibold text-text2">
            {items.length} item{items.length === 1 ? "" : "s"}
          </span>
        )}
      </div>
      {q.error && <ErrorNote>{q.error}</ErrorNote>}
      {q.loading && !q.data && <Loading />}
      {items && items.length === 0 && <Empty>No feedback</Empty>}
      {items && items.length > 0 && (
        <ol className="flex flex-col" aria-label="Feedback items">
          {items.map((f) => (
            <FeedbackRow key={f.id} item={f} doc={doc} current={current} onChanged={() => void q.reload()} />
          ))}
        </ol>
      )}
    </div>
  );
}

/** How this version handled feedback raised on earlier versions; `sectionKeys` as in FeedbackPanel. */
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
