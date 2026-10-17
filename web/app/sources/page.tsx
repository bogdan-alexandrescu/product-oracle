"use client";

import Link from "next/link";
import { type FormEvent, useState } from "react";

import { Button, ErrorNote, Loading } from "@/components/ui";
import { api, type Schemas, unwrap } from "@/lib/api/client";
import { formatDateTime } from "@/lib/format";
import { errorMessage, useAuthRedirect, useQuery } from "@/lib/use-query";

import { ConfidenceBadge, KIND_LABEL } from "./_components/confidence";

type Results = Schemas["SearchResults"];

const ITEM_KINDS = [
  "file",
  "page",
  "doc",
  "message",
  "thread",
  "transcript",
  "issue",
  "pull_request",
  "release",
  "milestone",
  "readme",
] as const;

/** ts_headline marks matches with <mark>; render them as React nodes, never as HTML. */
function Snippet({ text }: { text: string }) {
  const parts = text.split(/<mark>(.*?)<\/mark>/g);
  return (
    <p className="mt-1 text-sm text-neutral-700">
      {parts.map((part, i) =>
        i % 2 ? (
          <mark key={i} className="rounded bg-amber-100 px-0.5 text-neutral-900">
            {part}
          </mark>
        ) : (
          part
        ),
      )}
    </p>
  );
}

export default function SourcesSearchPage() {
  const sources = useQuery("sources", () => unwrap(api.GET("/v1/sources")));
  const [q, setQ] = useState("");
  const [kind, setKind] = useState("");
  const [source, setSource] = useState("");
  const [results, setResults] = useState<Results | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const onAuth = useAuthRedirect();
  const names = new Map((sources.data ?? []).map((s) => [s.id, s.name]));

  async function run(e: FormEvent) {
    e.preventDefault();
    if (!q.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const query: { q: string; kinds?: string[]; source?: string } = { q: q.trim() };
      if (kind) query.kinds = [kind];
      if (source) query.source = source;
      setResults(await unwrap(api.GET("/v1/search", { params: { query } })));
    } catch (err) {
      if (!onAuth(err)) setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-4xl px-6 py-8">
      <h1 className="mb-2 text-2xl font-semibold tracking-tight text-neutral-900">Sources</h1>
      <p className="mb-6 text-sm text-neutral-600">
        Search what your sources pulled in. Results are ranked by relevance weighted by confidence. Manage your
        sources in{" "}
        <Link href="/settings/sources" className="underline">
          Settings › Sources
        </Link>
        .
      </p>

      <form onSubmit={run} className="mb-6 flex flex-wrap items-end gap-2" role="search">
        <label className="flex min-w-64 flex-1 flex-col text-xs text-neutral-600">
          Search
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder='e.g. onboarding checklist -pricing'
            className="mt-1 rounded-md border border-neutral-300 px-3 py-1.5 text-sm text-neutral-900"
          />
        </label>
        <label className="flex flex-col text-xs text-neutral-600">
          Kind
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value)}
            className="mt-1 rounded-md border border-neutral-300 px-2 py-1.5 text-sm"
          >
            <option value="">Any kind</option>
            {ITEM_KINDS.map((k) => (
              <option key={k} value={k}>
                {k.replace("_", " ")}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col text-xs text-neutral-600">
          Source
          <select
            value={source}
            onChange={(e) => setSource(e.target.value)}
            className="mt-1 rounded-md border border-neutral-300 px-2 py-1.5 text-sm"
          >
            <option value="">All my sources</option>
            {(sources.data ?? []).map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        <Button type="submit" variant="primary" disabled={busy || !q.trim()}>
          Search
        </Button>
      </form>

      {error && <ErrorNote>{error}</ErrorNote>}
      {busy && <Loading label="Searching…" />}
      {results && !busy && results.hits.length === 0 && (
        <p className="text-neutral-600">Nothing in your sources matches “{results.query}”.</p>
      )}
      {results && results.hits.length > 0 && (
        <ol className="space-y-3" aria-label="Search results">
          {results.hits.map((hit) => (
            <li key={hit.item.id} className="rounded-lg border border-neutral-200 bg-white px-4 py-3" data-testid="search-hit">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  {hit.item.url ? (
                    <a href={hit.item.url} target="_blank" rel="noreferrer" className="font-medium text-neutral-900 hover:underline">
                      {hit.item.title || hit.item.external_id}
                    </a>
                  ) : (
                    <span className="font-medium text-neutral-900">{hit.item.title || hit.item.external_id}</span>
                  )}
                  <div className="text-xs text-neutral-500">
                    {KIND_LABEL[hit.item.source_kind]} · {names.get(hit.item.source_id) ?? "source"} ·{" "}
                    {hit.item.kind.replace("_", " ")}
                    {hit.item.fetched_at && <> · fetched {formatDateTime(hit.item.fetched_at)}</>}
                  </div>
                </div>
                <ConfidenceBadge confidence={hit.item.confidence} />
              </div>
              <Snippet text={hit.snippet} />
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
