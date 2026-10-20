"use client";

import { type FormEvent, useState } from "react";

import {
  Button,
  Chip,
  Empty,
  InfoTip,
  Inspector,
  InspectorRow,
  InspectorSection,
  LinkButton,
  Notice,
  Page,
  PageHeader,
  Panel,
  Ring,
  Split,
} from "@/components/ds";
import { INPUT, Loading } from "@/components/ui";
import { api, type Schemas, unwrap } from "@/lib/api/client";
import { formatDateTime } from "@/lib/format";
import { errorMessage, useAuthRedirect, useQuery } from "@/lib/use-query";

import { ConfidenceBadge, confidenceFactors, KIND_LABEL, pct } from "./_components/confidence";

type Results = Schemas["SearchResults"];
type Hit = Schemas["SearchHit"];

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

const kindName = (k: string) => k.replace("_", " ");

/** ts_headline marks matches with <mark>; render them as React nodes, never as HTML. */
function Snippet({ text, className = "" }: { text: string; className?: string }) {
  const parts = text.split(/<mark>(.*?)<\/mark>/g);
  return (
    <p className={`text-sm text-text2 ${className}`}>
      {parts.map((part, i) =>
        i % 2 ? (
          <mark key={i} className="rounded bg-warn-bg px-0.5 font-semibold text-text">
            {part}
          </mark>
        ) : (
          part
        ),
      )}
    </p>
  );
}

/** The selected hit: confidence, rank, the full match and its factors. */
function HitInspector({ hit, rank, of, sourceName }: { hit: Hit; rank: number; of: number; sourceName: string }) {
  const { item } = hit;
  return (
    <Inspector
      testId="hit-inspector"
      label="Selected result"
      eyebrow={`${kindName(item.kind)} · selected`}
      title={item.title || item.external_id}
      chips={
        <>
          <Chip hero>{KIND_LABEL[item.source_kind]}</Chip>
          <Chip hero>{sourceName}</Chip>
        </>
      }
      action={
        item.url ? (
          <LinkButton variant="hero" href={item.url} target="_blank" rel="noreferrer">
            Open
          </LinkButton>
        ) : undefined
      }
      stats={[
        { label: "Confidence", figure: <Ring value={item.confidence.value * 100} size={44} /> },
        { label: "Rank", value: rank, of },
        { label: "Relevance", value: hit.relevance.toFixed(2) },
      ]}
    >
      <InspectorSection label="Match">
        <Snippet text={hit.snippet} className="leading-[22px] break-words" />
      </InspectorSection>
      <InspectorSection
        label={
          <>
            Factors
            <InfoTip label="Confidence" align="start">
              Confidence is the weighted mean of these factors; it sets how much this item counts in search ranking
              and outputs.
            </InfoTip>
          </>
        }
      >
        {confidenceFactors(item.confidence).map((f) => (
          <InspectorRow
            key={f.key}
            value={
              <>
                {f.value.toFixed(2)} <span className="ml-1 font-normal text-text2">{pct(f.share)}</span>
              </>
            }
          >
            {f.label}
          </InspectorRow>
        ))}
      </InspectorSection>
      <InspectorSection label="Item">
        <InspectorRow value={kindName(item.kind)}>Kind</InspectorRow>
        {item.author && <InspectorRow value={item.author}>Author</InspectorRow>}
        {item.fetched_at && <InspectorRow value={formatDateTime(item.fetched_at)}>Fetched</InspectorRow>}
      </InspectorSection>
    </Inspector>
  );
}

export default function SourcesSearchPage() {
  const sources = useQuery("sources", () => unwrap(api.GET("/v1/sources")));
  const [q, setQ] = useState("");
  const [kind, setKind] = useState("");
  const [source, setSource] = useState("");
  const [results, setResults] = useState<Results | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
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
      setPicked(null);
    } catch (err) {
      if (!onAuth(err)) setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const hits = results?.hits ?? [];
  // The first hit is selected until another is picked, as on every master/detail screen.
  const selIndex = Math.max(0, hits.findIndex((h) => h.item.id === picked));
  const selected = hits[selIndex];
  const field = `${INPUT} h-10`;

  return (
    <Page>
      <PageHeader
        title="Sources"
        status={
          <>
            {results && (
              <Chip kind="acc" data-testid="hit-count">
                {hits.length} {hits.length === 1 ? "hit" : "hits"}
              </Chip>
            )}
            <InfoTip label="Ranking" align="start" side="bottom">
              Search what your sources pulled in. Results are ranked by relevance weighted by confidence.
            </InfoTip>
          </>
        }
        action={
          <LinkButton href="/settings/sources" icon="settings" title="Settings › Sources">
            Manage
          </LinkButton>
        }
      />

      <Split
        inspector={
          selected && (
            <HitInspector
              key={selected.item.id}
              hit={selected}
              rank={selIndex + 1}
              of={hits.length}
              sourceName={names.get(selected.item.source_id) ?? "source"}
            />
          )
        }
      >
        <form
          onSubmit={run}
          role="search"
          className="flex flex-wrap items-end gap-2.5 rounded-panel border border-line bg-surface p-3 shadow-panel"
        >
          <label className="flex min-w-0 flex-[1_1_16rem] flex-col gap-1 text-[13px] font-semibold text-text2">
            Search
            <input
              type="search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="e.g. onboarding checklist -pricing"
              className={`${field} font-normal placeholder:text-text2`}
            />
          </label>
          <label className="flex min-w-0 flex-[1_1_9rem] flex-col gap-1 text-[13px] font-semibold text-text2">
            Kind
            <select value={kind} onChange={(e) => setKind(e.target.value)} className={`${field} font-normal`}>
              <option value="">Any kind</option>
              {ITEM_KINDS.map((k) => (
                <option key={k} value={k}>
                  {kindName(k)}
                </option>
              ))}
            </select>
          </label>
          <label className="flex min-w-0 flex-[1_1_9rem] flex-col gap-1 text-[13px] font-semibold text-text2">
            Source
            <select value={source} onChange={(e) => setSource(e.target.value)} className={`${field} font-normal`}>
              <option value="">All my sources</option>
              {(sources.data ?? []).map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
          <Button type="submit" variant="primary" icon="search" disabled={busy || !q.trim()}>
            Search
          </Button>
        </form>

        {error && <Notice tone="error">{error}</Notice>}
        {busy && <Loading label="Searching…" />}

        <Panel title="Results" count={results ? hits.length : undefined}>
          {!results && <Empty>No search yet</Empty>}
          {results && !busy && hits.length === 0 && <Empty>Nothing in your sources matches “{results.query}”.</Empty>}
          {hits.length > 0 && (
            <ol aria-label="Search results">
              {hits.map((hit) => {
                const on = hit === selected;
                const title = hit.item.title || hit.item.external_id;
                return (
                  <li
                    key={hit.item.id}
                    data-testid="search-hit"
                    onClick={() => setPicked(hit.item.id)}
                    className={`cursor-pointer border-t border-line px-4 py-2.5 first:border-t-0 max-[600px]:px-3 ${
                      on ? "bg-accent-soft shadow-[inset_4px_0_0_var(--accent)]" : "hover:bg-surface2"
                    }`}
                  >
                    <div className="flex min-w-0 items-center gap-3">
                      <button
                        type="button"
                        aria-pressed={on}
                        onClick={() => setPicked(hit.item.id)}
                        className="min-w-0 flex-1 truncate text-left font-semibold"
                      >
                        {title}
                      </button>
                      <span className="max-w-[40%] flex-none truncate text-sm text-text2 max-[600px]:hidden">
                        {KIND_LABEL[hit.item.source_kind]} · {names.get(hit.item.source_id) ?? "source"} ·{" "}
                        {kindName(hit.item.kind)}
                      </span>
                      <span className="flex-none" onClick={(e) => e.stopPropagation()}>
                        <ConfidenceBadge confidence={hit.item.confidence} />
                      </span>
                    </div>
                    <Snippet text={hit.snippet} className="mt-0.5 truncate" />
                  </li>
                );
              })}
            </ol>
          )}
        </Panel>
      </Split>
    </Page>
  );
}
