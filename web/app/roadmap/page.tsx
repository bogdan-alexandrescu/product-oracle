"use client";

import Link from "next/link";

import { BuildRoadmapButton, SourceLink } from "@/components/BuildRoadmap";
import { DocStatusBadge, ErrorNote, Loading } from "@/components/ui";
import { api, unwrap } from "@/lib/api/client";
import { formatDateTime } from "@/lib/format";
import { hasRole, useMe } from "@/lib/me";
import { useQuery } from "@/lib/use-query";

/**
 * Roadmaps (O4b): each opens in the document view, so brief / full, Present, review and
 * the exports work as for a PRD. Approved PRDs below can each build a roadmap.
 */
export default function RoadmapPage() {
  const q = useQuery("documents|roadmap", () => unwrap(api.GET("/v1/documents", { params: { query: { kind: "roadmap" } } })));
  const prds = useQuery("documents|prd", () => unwrap(api.GET("/v1/documents", { params: { query: { kind: "prd" } } })));
  const { role } = useMe();
  const roadmaps = [...(q.data ?? [])].sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  const approved = (prds.data ?? []).filter((d) => d.approved_version != null);

  return (
    <div className="mx-auto max-w-5xl px-6 py-8">
      <div className="mb-6 flex flex-wrap items-center gap-2">
        <h1 className="mr-auto text-2xl font-semibold tracking-tight text-neutral-900">Roadmap</h1>
        <Link
          href="/documents/new?kind=roadmap"
          className="rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-sm font-medium text-neutral-800 hover:bg-neutral-50"
        >
          New roadmap
        </Link>
      </div>
      {q.error && <ErrorNote>{q.error}</ErrorNote>}
      {q.loading && <Loading />}
      {q.data && roadmaps.length === 0 && (
        <p className="text-neutral-600">
          No roadmaps yet. Build one from an approved PRD below, or start one with New roadmap.
        </p>
      )}
      {roadmaps.length > 0 && (
        <div className="overflow-hidden rounded-lg border border-neutral-200 bg-white">
          <table className="w-full text-sm" data-testid="roadmaps-table">
            <thead className="bg-neutral-50 text-left text-xs text-neutral-500">
              <tr>
                <th className="px-4 py-2 font-medium">Roadmap</th>
                <th className="px-4 py-2 font-medium">Status</th>
                <th className="px-4 py-2 font-medium">Latest</th>
                <th className="px-4 py-2 font-medium">Template and theme</th>
                <th className="px-4 py-2 font-medium">Source PRD</th>
                <th className="px-4 py-2 font-medium">Updated</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-200">
              {roadmaps.map((d) => (
                <tr key={d.id} className="hover:bg-neutral-50" data-testid="roadmap-row">
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
                  <td className="px-4 py-3 font-mono text-xs text-neutral-600">
                    {d.template ?? "—"}
                    {d.theme && <div>{d.theme}</div>}
                  </td>
                  <td className="px-4 py-3 text-neutral-700">{d.source ? <SourceLink source={d.source} /> : "—"}</td>
                  <td className="px-4 py-3 text-neutral-500">{formatDateTime(d.updated_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h2 className="mt-10 mb-1 text-sm font-semibold text-neutral-700">Build from an approved PRD</h2>
      <p className="mb-3 text-sm text-neutral-600">
        A run turns the PRD&apos;s approved version into roadmap items and a roadmap draft for review.
        {!hasRole(role, "approver") && " Approvers and owners start these runs."}
      </p>
      {prds.error && <ErrorNote>{prds.error}</ErrorNote>}
      {prds.loading && <Loading />}
      {prds.data && approved.length === 0 && (
        <p className="text-sm text-neutral-600">No approved PRDs yet. Approve a PRD version to build its roadmap.</p>
      )}
      {approved.length > 0 && (
        <ul className="divide-y divide-neutral-200 rounded-lg border border-neutral-200 bg-white" data-testid="approved-prds">
          {approved.map((d) => {
            const built = roadmaps.filter((r) => r.source?.slug === d.slug);
            return (
              <li key={d.id} className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm" data-testid="approved-prd">
                <Link href={`/documents/${d.slug}/v/${d.approved_version}`} className="font-medium text-neutral-900 hover:underline">
                  {d.title}
                </Link>
                <span className="text-neutral-500">v{d.approved_version} approved</span>
                {built.length > 0 && (
                  <span className="text-neutral-500">
                    · roadmap{" "}
                    {built.map((r, i) => (
                      <span key={r.id}>
                        {i > 0 && ", "}
                        <Link href={`/documents/${r.slug}`} className="underline-offset-2 hover:underline">
                          {r.title}
                        </Link>
                      </span>
                    ))}
                  </span>
                )}
                <span className="ml-auto">
                  <BuildRoadmapButton prd={d} size="sm" />
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
