"use client";

import Link from "next/link";
import { useState } from "react";

import { DocToolbar } from "@/components/DocToolbar";
import { VersionSwitcher } from "@/components/VersionSwitcher";
import { Badge, ErrorNote, Loading } from "@/components/ui";
import { api, unwrap, type SectionDiff } from "@/lib/api/client";
import { useQuery } from "@/lib/use-query";

const STATUS: Record<SectionDiff["status"], { label: string; tone: "green" | "red" | "amber" | "neutral" }> = {
  added: { label: "Added", tone: "green" },
  removed: { label: "Removed", tone: "red" },
  changed: { label: "Changed", tone: "amber" },
  unchanged: { label: "Unchanged", tone: "neutral" },
};

function Words({ words }: { words: NonNullable<SectionDiff["words"]> }) {
  return (
    <p className="text-[15px] leading-7 whitespace-pre-wrap text-neutral-800" data-testid="word-diff">
      {words.map((w, i) =>
        w.op === "insert" ? (
          <ins key={i} className="diff-ins">
            {w.text}
          </ins>
        ) : w.op === "delete" ? (
          <del key={i} className="diff-del">
            {w.text}
          </del>
        ) : (
          <span key={i}>{w.text}</span>
        ),
      )}
    </p>
  );
}

function DiffSection({ d, doc, to }: { d: SectionDiff; doc: string; to: number }) {
  const heading = d.to_heading ?? d.from_heading ?? d.section_key;
  const renamed = d.from_heading && d.to_heading && d.from_heading !== d.to_heading;
  return (
    <li
      data-testid="diff-section"
      data-status={d.status}
      className={`rounded-lg border bg-white ${d.status === "unchanged" && !d.moved ? "border-neutral-200" : "border-neutral-300"}`}
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-neutral-100 px-4 py-2.5">
        <h2 className={`font-medium ${d.status === "removed" ? "text-neutral-500 line-through" : "text-neutral-900"}`}>
          {heading}
        </h2>
        <Badge tone={STATUS[d.status].tone}>{STATUS[d.status].label}</Badge>
        {d.moved && (
          <Badge tone="blue" title={`Position ${(d.from_ordinal ?? 0) + 1} → ${(d.to_ordinal ?? 0) + 1}`}>
            Moved
          </Badge>
        )}
        <span className="ml-auto font-mono text-[11px] text-neutral-400">#{d.section_key}</span>
        {d.status !== "removed" && (
          <Link
            href={`/documents/${doc}/v/${to}#s-${d.section_key}`}
            className="text-xs text-neutral-500 underline-offset-2 hover:text-neutral-900 hover:underline"
          >
            View
          </Link>
        )}
      </div>
      {(renamed || (d.words && d.words.length > 0)) && (
        <div className="px-4 py-3">
          {renamed && (
            <p className="mb-2 text-xs text-neutral-500">
              Renamed from <span className="font-medium text-neutral-700">“{d.from_heading}”</span>
            </p>
          )}
          {d.words && d.words.length > 0 && <Words words={d.words} />}
        </div>
      )}
    </li>
  );
}

export function DiffView({ doc, from, to }: { doc: string; from?: number; to?: number }) {
  const [showUnchanged, setShowUnchanged] = useState(false);
  const docQ = useQuery(`doc|${doc}`, () => unwrap(api.GET("/v1/documents/{doc}", { params: { path: { doc } } })));
  const versions = docQ.data?.versions ?? [];
  const latest = versions.at(-1)?.number;
  const toN = to ?? latest;
  const fromN = from ?? (toN != null ? Math.max(1, toN - 1) : undefined);
  const ready = fromN != null && toN != null;

  const diffQ = useQuery(`diff|${doc}|${fromN}|${toN}`, async () =>
    ready
      ? unwrap(api.GET("/v1/documents/{doc}/diff", { params: { path: { doc }, query: { from: fromN, to: toN } } }))
      : undefined,
  );

  const sections = diffQ.data?.sections ?? [];
  const counts = {
    changed: sections.filter((s) => s.status === "changed").length,
    added: sections.filter((s) => s.status === "added").length,
    removed: sections.filter((s) => s.status === "removed").length,
    moved: sections.filter((s) => s.moved).length,
    unchanged: sections.filter((s) => s.status === "unchanged" && !s.moved).length,
  };
  const shown = sections.filter((s) => showUnchanged || s.status !== "unchanged" || s.moved);
  const href = (f: number, t: number) => `/documents/${doc}/diff?from=${f}&to=${t}`;

  return (
    <div>
      <DocToolbar doc={docQ.data}>
        {ready && versions.length > 0 && (
          <>
            <VersionSwitcher doc={doc} versions={versions} current={fromN} label="From" hrefFor={(f) => href(f, toN)} />
            <span className="text-neutral-400">→</span>
            <VersionSwitcher doc={doc} versions={versions} current={toN} label="To" hrefFor={(t) => href(fromN, t)} />
            <Link
              href={`/documents/${doc}/v/${toN}`}
              className="text-sm text-neutral-700 underline-offset-2 hover:text-neutral-950 hover:underline"
            >
              Open v{toN}
            </Link>
          </>
        )}
      </DocToolbar>
      <div className="mx-auto max-w-4xl px-6 py-6">
        <h1 className="mb-1 text-xl font-semibold text-neutral-900">
          {ready ? `Changes from v${fromN} to v${toN}` : "Compare versions"}
        </h1>
        {(docQ.error || diffQ.error) && <ErrorNote>{docQ.error || diffQ.error}</ErrorNote>}
        {docQ.data && versions.length < 2 && (
          <p className="text-sm text-neutral-600">This document has only one version, so there is nothing to compare yet.</p>
        )}
        {ready && fromN === toN && <p className="text-sm text-neutral-600">Pick two different versions to compare.</p>}
        {ready && !diffQ.data && !diffQ.error && <Loading label="Computing diff…" />}
        {diffQ.data && (
          <>
            <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-neutral-600" data-testid="diff-summary">
              <span>{counts.changed} changed</span>
              <span>{counts.added} added</span>
              <span>{counts.removed} removed</span>
              <span>{counts.moved} moved</span>
              <span>{counts.unchanged} unchanged</span>
              <label className="ml-auto flex items-center gap-2">
                <input type="checkbox" checked={showUnchanged} onChange={(e) => setShowUnchanged(e.target.checked)} />
                Show unchanged sections
              </label>
            </div>
            <ol className="flex flex-col gap-3">
              {shown.map((d) => (
                <DiffSection key={`${d.status}-${d.section_key}`} d={d} doc={doc} to={toN!} />
              ))}
            </ol>
            {shown.length === 0 && <p className="text-sm text-neutral-600">No differences between these versions.</p>}
          </>
        )}
      </div>
    </div>
  );
}
