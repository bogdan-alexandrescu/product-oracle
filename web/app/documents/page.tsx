"use client";

import Link from "next/link";

import { DocStatusBadge, ErrorNote, Loading } from "@/components/ui";
import { api, unwrap } from "@/lib/api/client";
import { formatDateTime } from "@/lib/format";
import { useQuery } from "@/lib/use-query";

export default function DocumentsPage() {
  const q = useQuery("documents", () => unwrap(api.GET("/v1/documents")));
  const documents = [...(q.data ?? [])].sort((a, b) => b.updated_at.localeCompare(a.updated_at));

  return (
    <div className="mx-auto max-w-4xl px-6 py-8">
      <div className="mb-6 flex flex-wrap items-center gap-2">
        <h1 className="mr-auto text-2xl font-semibold tracking-tight text-neutral-900">Documents</h1>
        <Link
          href="/documents/new?kind=prd"
          className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-neutral-700"
        >
          New PRD
        </Link>
        <Link
          href="/documents/new?kind=roadmap"
          className="rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-sm font-medium text-neutral-800 hover:bg-neutral-50"
        >
          New roadmap
        </Link>
      </div>
      {q.error && <ErrorNote>{q.error}</ErrorNote>}
      {q.loading && <Loading />}
      {q.data && documents.length === 0 && (
        <p className="text-neutral-600">
          No documents yet. Start one with New PRD or New roadmap, import a draft with <code>POST /v1/documents/&#123;doc&#125;/versions</code> or{" "}
          <code>oracle push draft.md</code>.
        </p>
      )}
      {documents.length > 0 && (
        <div className="overflow-hidden rounded-lg border border-neutral-200 bg-white">
        <table className="w-full text-sm">
          <thead className="bg-neutral-50 text-left text-xs text-neutral-500">
            <tr>
              <th className="px-4 py-2 font-medium">Document</th>
              <th className="px-4 py-2 font-medium">Status</th>
              <th className="px-4 py-2 font-medium">Latest</th>
              <th className="px-4 py-2 font-medium">Updated</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-neutral-200">
            {documents.map((d) => (
              <tr key={d.id} className="hover:bg-neutral-50">
                <td className="px-4 py-3">
                  <Link href={`/documents/${d.slug}`} className="font-medium text-neutral-900 hover:underline">
                    {d.title}
                  </Link>
                  <div className="font-mono text-[11px] text-neutral-400">{d.slug}</div>
                </td>
                <td className="px-4 py-3">
                  <DocStatusBadge status={d.status} />
                </td>
                <td className="px-4 py-3 text-neutral-700">
                  {d.latest_version != null ? (
                    <Link href={`/documents/${d.slug}/v/${d.latest_version}`} className="hover:underline">
                      v{d.latest_version}
                    </Link>
                  ) : (
                    "—"
                  )}
                </td>
                <td className="px-4 py-3 text-neutral-500">{formatDateTime(d.updated_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      )}
    </div>
  );
}
