"use client";

import Link from "next/link";
import { useState } from "react";

import { Badge, ErrorNote, Loading, StatusBadge, VerdictBadge } from "@/components/ui";
import { api, unwrap, type FeedbackItem, type FeedbackStatus, type VersionSummary } from "@/lib/api/client";
import { STATUS_LABEL } from "@/lib/format";
import { useQuery } from "@/lib/use-query";

const STATUSES = Object.keys(STATUS_LABEL) as FeedbackStatus[];

function FeedbackRow({ item, doc, current }: { item: FeedbackItem; doc: string; current: number }) {
  const href = `/documents/${doc}/v/${item.raised_on_version}${item.section_key ? `#s-${item.section_key}` : ""}`;
  return (
    <li className="rounded-md border border-neutral-200 bg-white px-3 py-2 text-sm" data-testid="feedback-item">
      <div className="flex flex-wrap items-center gap-1.5">
        <StatusBadge status={item.status} />
        {item.verdict ? <VerdictBadge verdict={item.verdict} /> : <Badge>{item.kind === "comment" ? "Comment" : "General"}</Badge>}
        <span className="ml-auto text-xs text-neutral-500">
          raised on v{item.raised_on_version}
          {item.addressed_in_version != null && ` · addressed in v${item.addressed_in_version}`}
        </span>
      </div>
      <p className="mt-1.5 text-neutral-900">{item.summary}</p>
      {item.anchor && (
        <p className="mt-1 line-clamp-2 border-l-2 border-amber-300 pl-2 text-xs text-neutral-600">{item.anchor.exact}</p>
      )}
      {item.resolution_note && (
        <p className="mt-1 text-xs text-neutral-700">
          <span className="font-medium">Resolution:</span> {item.resolution_note}
        </p>
      )}
      {item.section_key && (
        <Link
          href={href}
          className="mt-1 inline-block font-mono text-[11px] text-neutral-500 underline-offset-2 hover:text-neutral-900 hover:underline"
        >
          #{item.section_key}
          {item.raised_on_version !== current && ` (v${item.raised_on_version})`}
        </Link>
      )}
    </li>
  );
}

/** Every comment and section verdict on the document, filterable by status and version. */
export function FeedbackPanel({
  doc,
  current,
  versions,
  refreshKey,
}: {
  doc: string;
  current: number;
  versions: VersionSummary[];
  refreshKey: number;
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

  return (
    <div className="flex flex-col gap-3">
      <div className="flex gap-2">
        <label className="flex flex-1 flex-col gap-1 text-xs text-neutral-600">
          Status
          <select
            aria-label="Filter by status"
            value={status}
            onChange={(e) => setStatus(e.target.value as FeedbackStatus | "")}
            className="rounded-md border border-neutral-300 bg-white px-2 py-1 text-sm text-neutral-900"
          >
            <option value="">All statuses</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {STATUS_LABEL[s]}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-1 flex-col gap-1 text-xs text-neutral-600">
          Raised on
          <select
            aria-label="Filter by version"
            value={version}
            onChange={(e) => setVersion(e.target.value ? Number(e.target.value) : "")}
            className="rounded-md border border-neutral-300 bg-white px-2 py-1 text-sm text-neutral-900"
          >
            <option value="">All versions</option>
            {versions.map((v) => (
              <option key={v.number} value={v.number}>
                v{v.number}
              </option>
            ))}
          </select>
        </label>
      </div>
      {q.error && <ErrorNote>{q.error}</ErrorNote>}
      {q.loading && !q.data && <Loading />}
      {q.data && q.data.length === 0 && <p className="text-sm text-neutral-500">No feedback matches these filters.</p>}
      {q.data && q.data.length > 0 && (
        <>
          <p className="text-xs text-neutral-500">
            {q.data.length} item{q.data.length === 1 ? "" : "s"}
          </p>
          <ol className="flex flex-col gap-2" aria-label="Feedback items">
            {q.data.map((f) => (
              <FeedbackRow key={f.id} item={f} doc={doc} current={current} />
            ))}
          </ol>
        </>
      )}
    </div>
  );
}

/** How this version handled feedback raised on earlier versions. */
export function ResolutionPanel({ doc, n, refreshKey }: { doc: string; n: number; refreshKey: number }) {
  const q = useQuery(`${doc}|${n}|${refreshKey}`, () =>
    unwrap(api.GET("/v1/documents/{doc}/versions/{n}/resolution-report", { params: { path: { doc, n } } })),
  );
  if (q.error) return <ErrorNote>{q.error}</ErrorNote>;
  if (!q.data) return <Loading />;
  if (q.data.items.length === 0) {
    return <p className="text-sm text-neutral-500">No feedback was raised on earlier versions.</p>;
  }
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-1.5">
        {Object.entries(q.data.counts).map(([s, count]) => (
          <span key={s} className="text-xs text-neutral-600">
            <StatusBadge status={s as FeedbackStatus} /> {count}
          </span>
        ))}
      </div>
      <ol className="flex flex-col gap-2">
        {q.data.items.map((f) => (
          <FeedbackRow key={f.id} item={f} doc={doc} current={n} />
        ))}
      </ol>
    </div>
  );
}
