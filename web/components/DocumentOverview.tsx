"use client";

import Link from "next/link";

import { BuildRoadmapButton, SourceLink } from "@/components/BuildRoadmap";
import { DocToolbar } from "@/components/DocToolbar";
import { JobsPanel } from "@/components/JobsPanel";
import { Badge, ErrorNote, Loading } from "@/components/ui";
import { api, unwrap } from "@/lib/api/client";
import { formatDateTime } from "@/lib/format";
import { useQuery } from "@/lib/use-query";

export function DocumentOverview({ doc }: { doc: string }) {
  const q = useQuery(`doc|${doc}`, () => unwrap(api.GET("/v1/documents/{doc}", { params: { path: { doc } } })));
  const d = q.data;
  const versions = [...(d?.versions ?? [])].reverse();
  return (
    <div>
      <DocToolbar doc={d}>
        {d?.kind === "prd" && <BuildRoadmapButton prd={d} />}
        {d?.latest_version != null && (
          <Link
            href={`/documents/${doc}/v/${d.latest_version}`}
            className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-neutral-700"
          >
            Open latest (v{d.latest_version})
          </Link>
        )}
      </DocToolbar>
      <div className="mx-auto max-w-4xl px-6 py-8">
        {q.error && <ErrorNote>{q.error}</ErrorNote>}
        {!d && !q.error && <Loading />}
        {d && (
          <>
            <h1 className="text-2xl font-semibold tracking-tight text-neutral-900">{d.title}</h1>
            <p className="mt-1 text-sm text-neutral-500">
              <span className="font-mono">{d.slug}</span>
              {d.template && ` · template ${d.template}${d.template_version ? ` v${d.template_version}` : ""}`}
              {d.theme && ` · theme ${d.theme}`}
              {` · updated ${formatDateTime(d.updated_at)}`}
            </p>
            {d.source && (
              <p className="mt-1 text-sm text-neutral-600">
                <SourceLink source={d.source} />
              </p>
            )}
            <h2 className="mt-8 mb-3 text-sm font-semibold text-neutral-700">Versions</h2>
            {versions.length === 0 ? (
              <p className="text-sm text-neutral-600">No versions imported yet.</p>
            ) : (
              <ul className="divide-y divide-neutral-200 rounded-lg border border-neutral-200 bg-white">
                {versions.map((v) => (
                  <li key={v.id} className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm">
                    <Link
                      href={`/documents/${doc}/v/${v.number}`}
                      className="font-medium text-neutral-900 hover:underline"
                    >
                      Version {v.number}
                    </Link>
                    <span className="text-neutral-500">{formatDateTime(v.created_at)}</span>
                    {v.approved_at && <Badge tone="green">Approved</Badge>}
                    {v.source && (
                      <span className="text-neutral-500">
                        <SourceLink source={v.source} />
                      </span>
                    )}
                    {v.warnings.length > 0 && (
                      <Badge tone="amber" title={v.warnings.map((w) => w.message).join("\n")}>
                        {v.warnings.length} warning{v.warnings.length > 1 ? "s" : ""}
                      </Badge>
                    )}
                    {v.number > 1 && (
                      <Link
                        href={`/documents/${doc}/diff?from=${v.number - 1}&to=${v.number}`}
                        className="ml-auto text-neutral-600 underline-offset-2 hover:text-neutral-900 hover:underline"
                      >
                        Diff from v{v.number - 1}
                      </Link>
                    )}
                  </li>
                ))}
              </ul>
            )}
            <h2 className="mt-8 mb-3 text-sm font-semibold text-neutral-700">Jobs</h2>
            <JobsPanel doc={doc} />
          </>
        )}
      </div>
    </div>
  );
}
