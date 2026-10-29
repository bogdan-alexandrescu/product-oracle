"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { type FormEvent, Suspense, useState, useSyncExternalStore } from "react";

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
  Sheet,
  Split,
  toast,
} from "@/components/ds";
import { INPUT, Loading } from "@/components/ui";
import { api, type Schemas, unwrap } from "@/lib/api/client";
import { formatDateTime, plural } from "@/lib/format";
import { useMe } from "@/lib/me";
import { errorMessage, useAuthRedirect, useQuery } from "@/lib/use-query";

import {
  CompanyInspector,
  companyRowKey,
  companyRows,
  CompanyTable,
  CountsOnlyTip,
  type CompanyRow,
} from "./_components/company-coverage";
import { ConfidenceBadge, confidenceFactors, ITEM_KINDS, itemKind, itemKinds, KIND_LABEL, pct } from "./_components/confidence";
import { CoverageInspector, CoverageTable, CoverageTabs, NoSources, type CoverageTab } from "./_components/coverage";

type Results = Schemas["SearchResults"];
type Hit = Schemas["SearchHit"];
/** How a sync that did not finish went, said as Settings > Sources says it on the source's row. */
type SyncNotice = { sourceId: string; tone: "pass" | "warn"; text: string };


/** ts_headline marks matches with <mark>; render them as React nodes, never as HTML. */
function Snippet({ text, className = "", full = false }: { text: string; className?: string; full?: boolean }) {
  const parts = text.split(/<mark>(.*?)<\/mark>/g);
  return (
    <p className={`text-sm text-text2 ${className}`} title={full ? parts.join("") : undefined}>
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
      eyebrow={`${itemKind(item.kind)} · selected`}
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
        { label: "Confidence", value: pct(item.confidence.value) },
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
        <InspectorRow value={itemKind(item.kind)}>Kind</InspectorRow>
        {item.author && <InspectorRow value={item.author}>Author</InspectorRow>}
        {item.fetched_at && <InspectorRow value={formatDateTime(item.fetched_at)}>Fetched</InspectorRow>}
      </InspectorSection>
    </Inspector>
  );
}

const PHONE = "(max-width: 600px)";

function subscribePhone(onChange: () => void) {
  const mq = window.matchMedia(PHONE);
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}

/** True at phone width; false on the server. */
function useIsPhone(): boolean {
  return useSyncExternalStore(
    subscribePhone,
    () => window.matchMedia(PHONE).matches,
    () => false,
  );
}

export default function SourcesPage() {
  return (
    <Suspense fallback={<Loading label="Loading sources…" />}>
      <SourcesSearchPage />
    </Suspense>
  );
}

/**
 * Sources: Coverage until a search runs (A2), then Results. The URL keeps the coverage
 * state: ?source=<id> selects a source, ?tab=company opens the owners' Company tab; a
 * search stays client state.
 */
function SourcesSearchPage() {
  const router = useRouter();
  const params = useSearchParams();
  const { can, capsReady, capsError } = useMe();
  // #370: the Company coverage tab, for whoever may read the company's coverage (its
  // handler checks the role: an owner).
  const owner = can("get_company_source_coverage", false);
  // qa-work-2: syncing and editing a source follow the capabilities; a viewer reads only.
  const canSync = can("sync_source");
  const isPhone = useIsPhone();
  const tab: CoverageTab = owner && params.get("tab") === "company" ? "company" : "mine";
  const wanted = params.get("source");

  const sources = useQuery("sources", () => unwrap(api.GET("/v1/sources")));
  // The connection each source reads (a Fireflies one shows its endpoint).
  const kinds = useQuery("source-kinds", () => unwrap(api.GET("/v1/sources/kinds")));
  const coverage = useQuery("coverage", () => unwrap(api.GET("/v1/sources/coverage")));
  const rows = coverage.data?.sources;
  const current = rows?.find((r) => r.source_id === wanted) ?? rows?.[0];
  const currentId = current?.source_id ?? null;
  const detail = useQuery(`coverage:${currentId ?? ""}`, () =>
    currentId
      ? unwrap(api.GET("/v1/sources/{source_id}/coverage", { params: { path: { source_id: currentId } } }))
      : Promise.resolve(undefined),
  );
  const companyOn = owner && tab === "company";
  const company = useQuery(companyOn ? "coverage-company" : "coverage-company-off", () =>
    companyOn ? unwrap(api.GET("/v1/sources/coverage/company")) : Promise.resolve(undefined),
  );
  const [companyPick, setCompanyPick] = useState<string | null>(null);

  const [q, setQ] = useState("");
  const [kind, setKind] = useState("");
  const [source, setSource] = useState("");
  const [results, setResults] = useState<Results | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncNotice, setSyncNotice] = useState<SyncNotice | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const onAuth = useAuthRedirect();
  const names = new Map((sources.data ?? []).map((s) => [s.id, s.name]));
  const currentConnection = (sources.data ?? []).find((s) => s.id === currentId)?.connection_id;
  const endpoint = currentConnection ? kinds.data?.flatMap((k) => k.connections).find((c) => c.id === currentConnection)?.endpoint_url : null;

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

  const go = (query: string) => router.replace(query ? `/sources?${query}` : "/sources", { scroll: false });
  const selectSource = (id: string) => go(`source=${id}`);
  const selectTab = (t: CoverageTab) => {
    setCompanyPick(null);
    go(t === "company" ? "tab=company" : currentId ? `source=${currentId}` : "");
  };

  async function syncNow() {
    if (!currentId) return;
    setSyncing(true);
    setError(null);
    setSyncNotice(null);
    try {
      const name = current?.name ?? "The source";
      toast({ message: `Sync started: ${name}` });
      const result = await unwrap(api.POST("/v1/sources/{source_id}/sync", { params: { path: { source_id: currentId } } }));
      await Promise.all([coverage.reload(), detail.reload()]);
      // qa-work-2: say how the sync went; a sync that did not finish says why.
      // fix-work review: a rate-limited or superseded sync reads as on Settings > Sources.
      if (result.outcome === "completed") toast({ message: `${name} synced` });
      else if (result.outcome === "rate_limited")
        setSyncNotice({ sourceId: currentId, tone: "pass", text: "Rate limited: the next sync resumes where this one stopped." });
      else if (result.outcome === "superseded")
        setSyncNotice({
          sourceId: currentId,
          tone: "warn",
          text: "Not synced: this source was edited while it synced. Sync again to use the new selection.",
        });
      else setError(result.error ?? result.source.last_error ?? `${name} did not finish syncing.`);
    } catch (err) {
      if (!onAuth(err)) setError(errorMessage(err));
    } finally {
      setSyncing(false);
    }
  }

  async function loadMore() {
    const have = detail.data;
    if (!currentId || !have) return;
    setLoadingMore(true);
    try {
      const more = await unwrap(
        api.GET("/v1/sources/{source_id}/coverage", {
          params: { path: { source_id: currentId }, query: { offset: have.used_in.length } },
        }),
      );
      detail.setData((d) => (d ? { ...d, used_in: [...d.used_in, ...more.used_in], used_in_total: more.used_in_total } : d));
    } catch (err) {
      if (!onAuth(err)) setError(errorMessage(err));
    } finally {
      setLoadingMore(false);
    }
  }

  const hits = results?.hits ?? [];
  // The first hit is selected until another is picked, as on every master/detail screen.
  const selIndex = Math.max(0, hits.findIndex((h) => h.item.id === picked));
  const selected = hits[selIndex];
  const field = `${INPUT} h-10`;

  // Company: the first source row is selected on a wide screen; on a phone a row opens a sheet.
  const cRows = companyRows(company.data).filter((r): r is CompanyRow & { kind: NonNullable<CompanyRow["kind"]> } => r.kind !== null);
  const cPicked = cRows.find((r) => companyRowKey(r) === companyPick) ?? (isPhone ? undefined : cRows[0]);

  let inspector = null;
  if (results) {
    inspector = selected && (
      <HitInspector
        key={selected.item.id}
        hit={selected}
        rank={selIndex + 1}
        of={hits.length}
        sourceName={names.get(selected.item.source_id) ?? "source"}
      />
    );
  } else if (tab === "mine" && current) {
    inspector = (
      <CoverageInspector
        key={current.source_id}
        summary={current}
        detail={detail.data ?? undefined}
        busy={syncing}
        canSync={canSync}
        capsReady={capsReady}
        notice={syncNotice?.sourceId === current.source_id ? syncNotice : null}
        onSync={() => void syncNow()}
        onLoadMore={() => void loadMore()}
        loadingMore={loadingMore}
        endpoint={endpoint}
      />
    );
  } else if (tab === "company" && cPicked && !isPhone) {
    inspector = <CompanyInspector row={cPicked} />;
  }

  return (
    <Page>
      <PageHeader
        title="Sources"
        info={
          <InfoTip label="Ranking" align="start" side="bottom">
            Search what your sources pulled in. Results are ranked by relevance weighted by confidence.
          </InfoTip>
        }
        status={
          <>
            {results && (
              <Chip kind="acc" data-testid="hit-count">
                {plural(hits.length, "hit")}
              </Chip>
            )}
          </>
        }
      />

      <Split inspector={inspector}>
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
                  {itemKinds(k)}
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

        {results ? (
          <Panel
            title="Results"
            count={hits.length}
            tools={
              <Button variant="ghost" icon="sources" onClick={() => setResults(null)}>
                Coverage
              </Button>
            }
          >
            {!busy && hits.length === 0 && <Empty>Nothing in your sources matches “{results.query}”.</Empty>}
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
                          title={title}
                        >
                          {title}
                        </button>
                        {(() => {
                          const where = `${KIND_LABEL[hit.item.source_kind]} · ${names.get(hit.item.source_id) ?? "source"} · ${itemKind(hit.item.kind)}`;
                          return (
                            <span className="max-w-[40%] flex-none truncate text-sm text-text2 max-[600px]:hidden" title={where}>
                              {where}
                            </span>
                          );
                        })()}
                        <span className="flex-none" onClick={(e) => e.stopPropagation()}>
                          <ConfidenceBadge confidence={hit.item.confidence} />
                        </span>
                      </div>
                      <Snippet text={hit.snippet} className="mt-0.5 truncate" full />
                    </li>
                  );
                })}
              </ol>
            )}
          </Panel>
        ) : (
          <Panel
            title="Coverage"
            testId="coverage-panel"
            // Train N: the Company tab follows the capabilities; busy until they answer.
            busy={!capsReady && !capsError}
            tools={
              owner ? (
                <>
                  <CoverageTabs value={tab} onChange={selectTab} />
                  <CountsOnlyTip />
                </>
              ) : undefined
            }
          >
            {coverage.error && <Notice tone="error">{coverage.error}</Notice>}
            {tab === "company" ? (
              <>
                {company.error && <Notice tone="error">{company.error}</Notice>}
                <CompanyTable
                  data={company.data ?? undefined}
                  loading={company.loading}
                  selected={cPicked ? companyRowKey(cPicked) : null}
                  onSelect={setCompanyPick}
                />
              </>
            ) : rows && rows.length === 0 ? (
              <NoSources />
            ) : (
              <CoverageTable rows={rows} loading={coverage.loading} selected={currentId} onSelect={selectSource} />
            )}
          </Panel>
        )}
      </Split>
      {tab === "company" && isPhone && cPicked && !results && (
        <Sheet open title="Company · coverage" onClose={() => setCompanyPick(null)} testId="company-sheet">
          <CompanyInspector row={cPicked} />
        </Sheet>
      )}
    </Page>
  );
}
