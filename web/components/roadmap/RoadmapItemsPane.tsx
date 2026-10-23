"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useMemo, useState, type FormEvent } from "react";

import { Button, Chip, FilterChips, InfoTip, InspectorSection, Panel, Sheet, Split, type Column } from "@/components/ds";
import { ItemInspector } from "@/components/review/ItemInspector";
import { ItemsTable } from "@/components/review/ItemsTable";
import { ErrorNote, Loading } from "@/components/ui";
import { api, unwrap, type Schemas } from "@/lib/api/client";
import { sectionHref } from "@/lib/section-link";
import { errorMessage, useQuery } from "@/lib/use-query";

import { baseName, CompareBar } from "./CompareBar";
import { HORIZONS, horizonLabel, needsAttention, sectionFor, toItemRow, type ItemRow } from "./item-row";
import { CHANGED, changeChips, changeLine, useItemsDiff, type Compare, type ItemChange } from "./useItemsDiff";

type Filter = "all" | "changed" | "attention";
type Item = Schemas["RoadmapItemOut"];

/**
 * A roadmap version's Items tab (E2): its items as rows grouped by horizon, a summary line,
 * All / Needs attention, and the selected item's inspector beside the table (in a sheet on a
 * phone). E3: compared with the previous version or the approved plan, with a Changed filter
 * (the default when there is something to compare with), a change column, dropped items as
 * struck rows, and What changed and History in the inspector; `?compare=` and `?filter=`
 * keep the view in the URL. Everyone who reads the document reads it; approvers and owners also act on a stale
 * item (Mark under review, Still valid…). Nothing else is edited here.
 */
export function RoadmapItemsPane({
  doc,
  n,
  sections,
  canDecide,
}: {
  doc: string;
  n: number;
  /** The version's sections: "Open in document" links to the one naming the item. */
  sections: readonly { section_key: string; heading: string }[];
  canDecide: boolean;
}) {
  const itemsQ = useQuery(`roadmap-items|${doc}|${n}`, () =>
    unwrap(api.GET("/v1/roadmaps/{doc}/items", { params: { path: { doc }, query: { version: n, view: "full" } } })),
  );
  const source = itemsQ.data?.source;
  // The PRD version's headings, for "§ heading".
  const prdQ = useQuery(`roadmap-items-prd|${source?.slug ?? ""}|${source?.version ?? ""}`, () =>
    source?.slug && source.version != null
      ? unwrap(api.GET("/v1/documents/{doc}/versions/{n}", { params: { path: { doc: source.slug, n: source.version } } })).catch(() => null)
      : Promise.resolve(null),
  );
  // The PRD's schedule bases: a dated milestone's references.
  const basesQ = useQuery(`roadmap-items-bases|${source?.slug ?? ""}`, () =>
    source?.slug
      ? unwrap(api.GET("/v1/schedule-bases", { params: { query: { prd: source.slug } } })).catch(() => [])
      : Promise.resolve([]),
  );

  const items = useMemo(() => itemsQ.data?.items ?? [], [itemsQ.data]);
  const headings = useMemo(() => new Map((prdQ.data?.sections ?? []).map((s) => [s.section_key, s.heading])), [prdQ.data]);
  const rows = useMemo(() => items.map((i) => toItemRow(i, headings)), [items, headings]);
  const attention = rows.filter(needsAttention).length;

  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const compare: Compare = params.get("compare") === "approved" ? "approved" : "previous";
  const { diff, byKey, ghosts } = useItemsDiff(doc, n, compare);
  const compared = !!diff?.base;
  const changed = diff?.summary ? [...CHANGED].reduce((sum, k) => sum + (diff.summary?.[k] ?? 0), 0) : 0;
  const asked = params.get("filter");
  // Opening a version with something to compare with shows its changes first.
  const filter: Filter = asked === "attention" || asked === "all" ? asked : compared ? "changed" : "all";
  const setUrl = (key: string, value: string) => {
    const next = new URLSearchParams(params.toString());
    next.set(key, value);
    router.replace(`${pathname}?${next.toString()}`, { scroll: false });
  };
  const setFilter = (f: Filter) => setUrl("filter", f);
  const setCompare = (c: Compare) => setUrl("compare", c);
  const shownRows = useMemo(() => (compared ? [...rows, ...ghosts] : rows), [compared, rows, ghosts]);

  const [selected, setSelected] = useState<string | null>(null);
  const [sheet, setSheet] = useState(false);
  const row = shownRows.find((r) => r.key === selected) ?? null;
  const item = items.find((i) => i.item_key === selected);
  const historyQ = useQuery(`roadmap-item-history|${source?.slug ?? ""}|${row && !row.ghost ? row.key : ""}`, () =>
    source?.slug && row && !row.ghost
      ? unwrap(api.GET("/v1/roadmap-items/history", { params: { query: { prd: source.slug, item_key: row.key } } })).catch(() => null)
      : Promise.resolve(null),
  );

  const onSelect = useCallback((key: string) => {
    setSelected(key);
    if (window.matchMedia("(max-width: 639px)").matches) setSheet(true);
  }, []);

  const filterFn =
    filter === "attention"
      ? (r: ItemRow) => !r.ghost && needsAttention(r)
      : filter === "changed"
        ? (r: ItemRow) => CHANGED.has(byKey.get(r.key)?.change ?? "unchanged")
        : undefined;
  const titles = useMemo(() => new Map(shownRows.map((r) => [r.key, r.title])), [shownRows]);
  const changeColumn: Column<ItemRow>[] = compared
    ? [{ key: "change", header: "Change", width: "190px", phone: "meta", cell: (r) => <ChangeChips change={byKey.get(r.key)} /> }]
    : [];
  const decorate = (r: ItemRow) =>
    r.ghost ? { "data-testid": "roadmap-item-ghost", "data-change": "dropped" } : { "data-change": byKey.get(r.key)?.change };
  const onChanged = (next: Item[]) => itemsQ.setData((prev) => (prev ? { ...prev, items: next } : prev));

  if (itemsQ.error) return <ErrorNote>{itemsQ.error}</ErrorNote>;
  if (!itemsQ.data) return <Loading label="Loading items…" />;

  if (rows.length === 0) {
    return (
      <Panel testId="roadmap-items-empty">
        <div className="flex flex-col items-center gap-3 px-4 py-12 text-center">
          <p className="flex items-center gap-1.5 text-[15px] font-semibold text-text2">
            No items for this version
            <InfoTip label="roadmap items" side="bottom">
              Items come from the roadmap run&apos;s items file. A version imported without one keeps the previous
              version&apos;s items that its text still names.
            </InfoTip>
          </p>
          <Link href={`/documents/${doc}/v/${n}`} className="font-semibold text-accent-ink underline-offset-2 hover:underline">
            Open the document
          </Link>
        </div>
      </Panel>
    );
  }

  const count = (h: string) => rows.filter((r) => r.horizon === h).length;
  const docKey = row ? sectionFor(row, sections) : null;
  const change = row ? byKey.get(row.key) : undefined;
  const since = diff && compared ? baseName(diff, compare) : "";
  const inspector = (r: ItemRow) => (
    <ItemInspector
      row={r}
      item={r.ghost ? undefined : item}
      total={rows.length}
      rows={rows}
      bases={basesQ.data ?? undefined}
      documentHref={docKey ? sectionHref(doc, n, docKey) : null}
      freshnessActions={
        canDecide && (r.freshness === "potentially_stale" || r.freshness === "under_review") ? (
          <StalenessActions key={`${r.key}|${r.freshness}`} doc={doc} n={n} row={r} onChanged={onChanged} />
        ) : undefined
      }
    >
      {change && (
        <InspectorSection label={`What changed since ${since}`} testId="item-what-changed">
          <ul className="flex flex-col gap-1 text-[15px]">
            {change.change === "added" && <li>New since {since}</li>}
            {change.change === "dropped" && <li>Dropped since {since}</li>}
            {change.change === "unchanged" && !change.notes.length && <li>No change</li>}
            {change.fields.map((f) => (
              <li key={f.field}>{changeLine(f, titles)}</li>
            ))}
            {change.notes.map((f) => (
              <li key={`note-${f.field}`} className="text-text2">
                {changeLine(f, titles)}
              </li>
            ))}
          </ul>
        </InspectorSection>
      )}
      {!r.ghost && !!historyQ.data?.entries.length && (
        <InspectorSection label="History" testId="item-history">
          <ol className="flex flex-col gap-1 text-[15px]">
            {historyQ.data.entries.map((e) => (
              <li key={e.ref}>
                {e.present
                  ? `${e.label} · ${horizonLabel(e.horizon ?? "")}${e.approved ? " · approved" : ""}`
                  : `${e.label} · dropped`}
              </li>
            ))}
          </ol>
        </InspectorSection>
      )}
    </ItemInspector>
  );

  return (
    <div data-testid="roadmap-items-pane">
      <Split inspector={row ? <div className="max-[639px]:hidden">{inspector(row)}</div> : undefined}>
        {diff && <CompareBar diff={diff} compare={compare} onCompare={setCompare} />}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <p data-testid="items-summary" className="tnum text-sm text-text2">
            <b className="font-semibold text-text">
              {rows.length} item{rows.length === 1 ? "" : "s"}
            </b>
            {HORIZONS.map((h) => ` · ${count(h.value)} ${h.label}`).join("")}
          </p>
          <FilterChips<Filter>
            label="Items"
            testId="items-filter"
            value={filter}
            onChange={setFilter}
            items={[
              { value: "all", label: "All", count: rows.length },
              ...(compared ? [{ value: "changed" as const, label: "Changed", count: changed, testId: "filter-changed" }] : []),
              { value: "attention", label: "Needs attention", count: attention },
            ]}
          />
        </div>
        <Panel>
          <ItemsTable
            rows={shownRows}
            selected={selected}
            onSelect={onSelect}
            filter={filterFn}
            extraColumns={changeColumn}
            rowDecorations={decorate}
          />
        </Panel>
      </Split>
      <Sheet open={sheet && !!row} title={row?.title ?? "Item"} onClose={() => setSheet(false)} testId="sheet-item">
        {row && inspector(row)}
      </Sheet>
    </div>
  );
}

/** Mark under review; Still valid… with a one-line reason. The table follows the response. */
function StalenessActions({
  doc,
  n,
  row,
  onChanged,
}: {
  doc: string;
  n: number;
  row: ItemRow;
  onChanged: (items: Item[]) => void;
}) {
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function act(action: "review" | "reconcile") {
    setBusy(true);
    setError(null);
    try {
      const out = await unwrap(
        api.POST("/v1/roadmaps/{doc}/items/staleness", {
          params: { path: { doc } },
          body: { action, version: n, item_keys: [row.key], reason: action === "reconcile" ? reason.trim() : null },
        }),
      );
      onChanged(out.items);
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  }

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (reason.trim()) void act("reconcile");
  };

  return (
    <div className="mt-3 flex flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        {row.freshness === "potentially_stale" && (
          <Button onClick={() => act("review")} disabled={busy}>
            Mark under review
          </Button>
        )}
        {!asking && (
          <Button variant="ghost" onClick={() => setAsking(true)} disabled={busy}>
            Still valid…
          </Button>
        )}
      </div>
      {asking && (
        <form onSubmit={submit} className="flex flex-col gap-2">
          <label className="flex flex-col gap-1 text-sm font-semibold text-text2">
            Why it is still valid
            <input
              autoFocus
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={500}
              className="h-10 rounded-button border border-line-strong bg-surface px-2.5 text-[15px] font-normal text-text"
            />
          </label>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" variant="primary" disabled={busy || !reason.trim()}>
              Mark still valid
            </Button>
            <Button variant="ghost" onClick={() => setAsking(false)} disabled={busy}>
              Cancel
            </Button>
          </div>
        </form>
      )}
      {error && <ErrorNote>{error}</ErrorNote>}
    </div>
  );
}

/** At most two change chips, then "+N" (E3 Change column). */
function ChangeChips({ change }: { change?: ItemChange }) {
  if (!change) return null;
  const chips = changeChips(change);
  if (!chips.length) return <span className="text-text2">—</span>;
  return (
    <span data-testid="item-change" data-change={change.change} className="inline-flex min-w-0 flex-wrap items-center gap-1">
      {chips.slice(0, 2).map((c) => (
        <Chip key={c.label} kind={c.kind}>
          {c.label}
        </Chip>
      ))}
      {chips.length > 2 && <Chip kind="line">+{chips.length - 2}</Chip>}
    </span>
  );
}
