"use client";

import Link from "next/link";
import { useState } from "react";

import { Badge, ErrorNote, Loading } from "@/components/ui";
import { api, unwrap, type Schemas } from "@/lib/api/client";
import { formatDate } from "@/lib/format";
import { useQuery } from "@/lib/use-query";

const KIND_LABEL: Record<Schemas["ThemeOut"]["kind"], string> = { prd: "PRD", roadmap: "Roadmap", any: "Any document" };
const SWATCHES = ["background", "text", "heading", "muted", "accent", "rule", "surface"];

export default function ThemesPage() {
  const [showArchived, setShowArchived] = useState(false);
  const q = useQuery(`themes|${showArchived}`, () =>
    unwrap(api.GET("/v1/themes", { params: { query: { include_archived: showArchived } } })),
  );
  const themes = [...(q.data ?? [])].sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));

  return (
    <div className="mx-auto max-w-5xl px-6 py-8">
      <div className="mb-1 flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold tracking-tight text-neutral-900">Themes</h1>
        <Link
          href="/settings/themes/new"
          className="ml-auto rounded-md bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-neutral-700"
        >
          New theme
        </Link>
      </div>
      <p className="mb-4 text-sm text-neutral-600">
        How exported PRDs and roadmaps look: fonts, colours, spacing, page and layout features. Text colours must be
        readable on the background (WCAG AA).
      </p>
      <label className="mb-6 inline-flex items-center gap-2 text-sm text-neutral-700">
        <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
        Show archived
      </label>

      {q.error && <ErrorNote>{q.error}</ErrorNote>}
      {q.loading && <Loading />}
      {q.data && themes.length === 0 && <p className="text-sm text-neutral-600">No themes yet.</p>}
      {themes.length > 0 && (
        <div className="overflow-hidden rounded-lg border border-neutral-200 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-neutral-50 text-left text-xs text-neutral-500">
              <tr>
                <th className="px-4 py-2 font-medium">Theme</th>
                <th className="px-4 py-2 font-medium">For</th>
                <th className="px-4 py-2 font-medium">Colours</th>
                <th className="px-4 py-2 font-medium">Updated</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-200">
              {themes.map((t) => (
                <tr key={t.key} data-testid={`theme-row-${t.key}`} className={t.archived_at ? "bg-neutral-50 text-neutral-500" : "hover:bg-neutral-50"}>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <Link href={`/settings/themes/${t.key}`} className="font-medium text-neutral-900 hover:underline">
                        {t.name}
                      </Link>
                      {t.builtin && <Badge>Built-in</Badge>}
                      {t.archived_at && <Badge tone="amber">Archived</Badge>}
                    </div>
                    <div className="font-mono text-[11px] text-neutral-400">{t.key}</div>
                    {t.description && <p className="mt-1 text-xs text-neutral-600">{t.description}</p>}
                  </td>
                  <td className="px-4 py-3 text-neutral-700">{KIND_LABEL[t.kind]}</td>
                  <td className="px-4 py-3">
                    <div className="flex">
                      {SWATCHES.map((name) => (
                        <span
                          key={name}
                          title={`${name} ${t.tokens.colors?.[name] ?? ""}`}
                          className="-ml-1 h-5 w-5 rounded-full border border-neutral-300 first:ml-0"
                          style={{ background: t.tokens.colors?.[name] }}
                        />
                      ))}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-neutral-500">{formatDate(t.updated_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
