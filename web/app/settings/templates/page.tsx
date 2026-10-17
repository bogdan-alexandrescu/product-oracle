"use client";

import Link from "next/link";
import { useState } from "react";

import { Badge, ErrorNote, Loading } from "@/components/ui";
import { api, unwrap, type Schemas } from "@/lib/api/client";
import { formatDate } from "@/lib/format";
import { useQuery } from "@/lib/use-query";

type TemplateSummary = Schemas["TemplateSummary"];

const KINDS = [
  { kind: "prd", title: "PRD templates" },
  { kind: "roadmap", title: "Roadmap templates" },
] as const;

function TemplateTable({ templates }: { templates: TemplateSummary[] }) {
  return (
    <div className="overflow-hidden rounded-lg border border-neutral-200 bg-white">
      <table className="w-full text-sm">
        <thead className="bg-neutral-50 text-left text-xs text-neutral-500">
          <tr>
            <th className="px-4 py-2 font-medium">Template</th>
            <th className="px-4 py-2 font-medium">Suggested theme</th>
            <th className="px-4 py-2 font-medium">Latest</th>
            <th className="px-4 py-2 font-medium">Added</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-neutral-200">
          {templates.map((t) => (
            <tr key={t.key} data-testid={`template-row-${t.key}`} className={t.archived_at ? "bg-neutral-50 text-neutral-500" : "hover:bg-neutral-50"}>
              <td className="px-4 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Link href={`/settings/templates/${t.key}`} className="font-medium text-neutral-900 hover:underline">
                    {t.name}
                  </Link>
                  {t.builtin && <Badge>Built-in</Badge>}
                  {t.archived_at && <Badge tone="amber">Archived</Badge>}
                </div>
                <div className="font-mono text-[11px] text-neutral-400">{t.key}</div>
                {t.description && <p className="mt-1 text-xs text-neutral-600">{t.description}</p>}
              </td>
              <td className="px-4 py-3 font-mono text-xs text-neutral-600">{t.suggested_theme ?? "—"}</td>
              <td className="px-4 py-3 text-neutral-700">v{t.latest_version}</td>
              <td className="px-4 py-3 text-neutral-500">{formatDate(t.created_at)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function TemplatesPage() {
  const [showArchived, setShowArchived] = useState(false);
  const q = useQuery(`templates|${showArchived}`, () =>
    unwrap(api.GET("/v1/templates", { params: { query: { include_archived: showArchived } } })),
  );

  return (
    <div className="mx-auto max-w-5xl px-6 py-8">
      <div className="mb-1 flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold tracking-tight text-neutral-900">Templates</h1>
        <Link
          href="/settings/templates/new"
          className="ml-auto rounded-md bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-neutral-700"
        >
          New template
        </Link>
      </div>
      <p className="mb-4 text-sm text-neutral-600">
        The skeletons new PRDs and roadmaps start from. Every saved change to a template is a new version; documents keep
        the version they started from.
      </p>
      <label className="mb-6 inline-flex items-center gap-2 text-sm text-neutral-700">
        <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
        Show archived
      </label>

      {q.error && <ErrorNote>{q.error}</ErrorNote>}
      {q.loading && <Loading />}
      {q.data &&
        KINDS.map(({ kind, title }) => {
          const list = q.data!.filter((t) => t.kind === kind).sort((a, b) => a.name.localeCompare(b.name));
          return (
            <section key={kind} className="mb-8" aria-labelledby={`templates-${kind}`} data-testid={`templates-${kind}`}>
              <h2 id={`templates-${kind}`} className="mb-3 text-sm font-semibold text-neutral-700">
                {title} <span className="font-normal text-neutral-400">({list.length})</span>
              </h2>
              {list.length === 0 ? (
                <p className="text-sm text-neutral-600">No {kind === "prd" ? "PRD" : "roadmap"} templates.</p>
              ) : (
                <TemplateTable templates={list} />
              )}
            </section>
          );
        })}
    </div>
  );
}
