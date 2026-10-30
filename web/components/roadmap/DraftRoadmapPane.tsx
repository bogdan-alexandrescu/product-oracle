"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { Button, Chip, FilterChips, InfoTip, InspectorSection, Notice, Panel, Sheet, Split, type Column } from "@/components/ds";
import { usePolling } from "@/components/JobsPanel";
import { ItemInspector } from "@/components/review/ItemInspector";
import { ItemsTable } from "@/components/review/ItemsTable";
import { ErrorNote, Loading } from "@/components/ui";
import { api, unwrap } from "@/lib/api/client";
import {
  deriveDraftRoadmap,
  getDraftRoadmap,
  putDraftRoadmapSettings,
  type DraftRoadmapOut,
  type DraftRoadmapProblem,
} from "@/lib/api/draft-roadmap";
import { sectionHref } from "@/lib/section-link";
import { errorMessage, useQuery } from "@/lib/use-query";
import { failedAt, formatDateTime } from "@/lib/format";

import { baseName, CompareBar } from "./CompareBar";
import { HORIZONS, needsAttention, toItemRow, type ItemRow } from "./item-row";
import { ChangeChips, ItemHistory, WhatChanged } from "./ItemChanges";
import { CHANGED, useItemsDiff, type Compare } from "./useItemsDiff";

type Filter = "all" | "changed" | "attention";

/** Every 10 s while a derivation is queued or running (JobsPanel's usePolling). */
const POLL_MS = 10_000;

/** The check's problem codes as people read them; any other code is "Check problem". */
const PROBLEM_LABEL: Record<string, string> = {
  unverified_date: "Date unverified",
  date_outside_now: "Date outside Now",
  undated_source: "Date without a source",
  invalid_date: "Unreadable date",
  unknown_dependency: "Unknown dependency",
  horizon_breaks_dependency: "Depends on a later item",
  order_breaks_dependency: "Listed before what it needs",
  unknown_prd_section: "No PRD section",
};
export const problemLabel = (code: string) => PROBLEM_LABEL[code] ?? "Check problem";


function ago(iso: string | null): string {
  if (!iso) return "just now";
  const min = Math.floor((Date.now() - Date.parse(iso)) / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  return `${Math.floor(min / 60)} h ago`;
}

/**
 * A PRD version's Roadmap tab (E1): the items-only roadmap Oracle derives from every PRD
 * draft. A line saying these are proposals, the derivation's status (polled while queued or
 * running), the check's problems linking to their rows, the owner's "Derive for each new
 * draft" switch, and the shared items table and inspector without State and Engineering
 * (draft items have no freshness or tracker records). E3b: compared with the previous
 * draft or the approved plan, with a Changed filter (the default when there is something to
 * compare with), a change column, dropped items as struck rows, and What changed and History
 * in the inspector; `?compare=` and `?filter=` keep the view in the URL. Viewers and
 * commenters read it; approvers and owners also derive; owners also turn the switch.
 */
export function DraftRoadmapPane({
  doc,
  n,
  latest,
  sections,
  canDerive,
  isOwner,
  onStatus,
}: {
  doc: string;
  n: number;
  /** The PRD's latest version: a superseded derivation points at its roadmap. */
  latest: number;
  /** The version's sections: the PRD column's "§ heading". */
  sections: readonly { section_key: string; heading: string }[];
  canDerive: boolean;
  isOwner: boolean;
  /** The status changed: the version (and its tab label) is read again. */
  onStatus?: () => void;
}) {
  const q = useQuery(`draft-roadmap|${doc}|${n}`, () => getDraftRoadmap(doc, n, "full"));
  const data = q.data;
  const status = data?.status;
  usePolling(status === "queued" || status === "running", q.reload, POLL_MS);

  // The tab label follows the status (and the item count once they are stored).
  const seen = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!status) return;
    if (seen.current && seen.current !== status) onStatus?.();
    seen.current = status;
  }, [status, onStatus]);

  const headings = useMemo(() => new Map(sections.map((s) => [s.section_key, s.heading])), [sections]);
  const items = useMemo(() => data?.items ?? [], [data]);
  const rows = useMemo(() => items.map((i) => toItemRow(i, headings)), [items, headings]);
  const problems = useMemo(() => data?.check?.problems ?? [], [data]);
  const byItem = useMemo(() => {
    const m = new Map<string, DraftRoadmapProblem[]>();
    for (const p of problems) if (p.item) m.set(p.item, [...(m.get(p.item) ?? []), p]);
    return m;
  }, [problems]);

  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const compare: Compare = params.get("compare") === "approved" ? "approved" : "previous";
  // Asked again once the draft's items are (re)stored; nothing to ask before.
  const { diff, byKey, ghosts } = useItemsDiff(doc, n, compare, status === "ready" ? (data?.ready_at ?? "ready") : null);
  const compared = !!diff?.base;
  const changed = diff?.summary ? [...CHANGED].reduce((sum, k) => sum + (diff.summary?.[k] ?? 0), 0) : 0;
  const asked = params.get("filter");
  // Opening a draft with something to compare with shows its changes first.
  const filter: Filter = asked === "attention" || asked === "all" ? asked : compared ? "changed" : "all";
  const setUrl = (key: string, value: string) => {
    const next = new URLSearchParams(params.toString());
    next.set(key, value);
    router.replace(`${pathname}?${next.toString()}`, { scroll: false });
  };
  const shownRows = useMemo(() => (compared ? [...rows, ...ghosts] : rows), [compared, rows, ghosts]);
  const titles = useMemo(() => new Map(shownRows.map((r) => [r.key, r.title])), [shownRows]);

  const [selected, setSelected] = useState<string | null>(null);
  const [sheet, setSheet] = useState(false);
  const selectedRow = shownRows.find((r) => r.key === selected) ?? null;
  const historyKey = selectedRow && !selectedRow.ghost ? selectedRow.key : "";
  const historyQ = useQuery(`roadmap-item-history|${doc}|${historyKey}`, () =>
    historyKey
      ? unwrap(api.GET("/v1/roadmap-items/history", { params: { query: { prd: doc, item_key: historyKey } } })).catch(() => null)
      : Promise.resolve(null),
  );
  const onSelect = useCallback((key: string) => {
    setSelected(key);
    if (window.matchMedia("(max-width: 639px)").matches) setSheet(true);
  }, []);
  const goToRow = (key: string) => {
    onSelect(key);
    document.querySelector(`[data-testid="draft-roadmap"] [data-key="${CSS.escape(key)}"]`)?.scrollIntoView({ block: "center" });
  };

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const derive = async () => {
    setBusy(true);
    setError(null);
    try {
      const out = await deriveDraftRoadmap(doc, n);
      q.setData(() => out);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  if (q.error) return <ErrorNote>{q.error}</ErrorNote>;
  if (!data) return <Loading label="Loading roadmap items…" />;

  const row = selectedRow;
  const item = items.find((i) => i.item_key === selected);
  const attention = rows.filter(needsAttention).length;
  const since = diff && compared ? baseName(diff, compare) : "";
  const filterFn =
    filter === "attention"
      ? (r: ItemRow) => !r.ghost && needsAttention(r)
      : filter === "changed"
        ? (r: ItemRow) => CHANGED.has(byKey.get(r.key)?.change ?? "unchanged")
        : undefined;
  const decorate = (r: ItemRow) =>
    r.ghost ? { "data-testid": "roadmap-item-ghost", "data-change": "dropped" } : { "data-change": byKey.get(r.key)?.change };
  const columns: Column<ItemRow>[] = [
    ...(compared
      ? [{ key: "change", header: "Change", width: "190px", phone: "meta" as const, cell: (r: ItemRow) => <ChangeChips change={byKey.get(r.key)} /> }]
      : []),
    {
      key: "check",
      header: "Check",
      width: "170px",
      phone: "meta",
      cell: (r) => {
        const own = byItem.get(r.key) ?? [];
        if (!own.length) return <span className="text-text2">—</span>;
        return (
          <span data-testid="draft-roadmap-chips" className="inline-flex min-w-0 flex-wrap items-center gap-1">
            {[...new Set(own.map((p) => problemLabel(p.code)))].map((label) => (
              <Chip key={label} kind="warn">
                {label}
              </Chip>
            ))}
          </span>
        );
      },
    },
    {
      key: "prd_section",
      header: "PRD",
      width: "150px",
      phone: "meta",
      cell: (r) => {
        const key = items.find((i) => i.item_key === r.key)?.prd.section_key;
        if (!key) return <span className="text-text2">—</span>;
        return (
          <Link
            href={sectionHref(doc, n, key)}
            onClick={(e) => e.stopPropagation()}
            data-testid="draft-roadmap-open-section"
            title={headings.get(key) ?? key}
            className="font-medium text-accent-ink underline-offset-2 hover:underline"
          >
            Open PRD section
          </Link>
        );
      },
    },
  ];
  const inspector = (r: ItemRow) => {
    const key = items.find((i) => i.item_key === r.key)?.prd.section_key;
    const change = byKey.get(r.key);
    return (
      <ItemInspector row={r} item={r.ghost ? undefined : item} total={rows.length} rows={rows} documentHref={key ? sectionHref(doc, n, key) : null}>
        {change && <WhatChanged change={change} since={since} titles={titles} />}
        {!r.ghost && <ItemHistory history={historyQ.data} />}
        {(byItem.get(r.key)?.length ?? 0) > 0 && (
          <InspectorSection label="Check" testId="item-problems">
            <ul className="flex flex-col gap-1.5 text-sm text-warn">
              {byItem.get(r.key)!.map((p, i) => (
                <li key={i}>
                  <b className="font-semibold">{problemLabel(p.code)}</b>: {p.message}
                </li>
              ))}
            </ul>
          </InspectorSection>
        )}
      </ItemInspector>
    );
  };

  return (
    <div data-testid="draft-roadmap" className="flex min-w-0 flex-col gap-3">
      <p className="flex flex-wrap items-center gap-1.5 text-sm text-text2">
        <span>
          <b className="font-semibold text-text">Proposed by draft v{n}</b> · not an approved roadmap
        </span>
        <InfoTip label="draft roadmaps" side="bottom" align="start">
          Oracle builds an items-only draft roadmap from every PRD draft, so you can see the plan while the PRD changes. Items
          here are proposals until a roadmap is approved.
        </InfoTip>
      </p>

      <StatusRow data={data} n={n} latest={latest} doc={doc} canDerive={canDerive} busy={busy} onDerive={derive} />
      {error && <ErrorNote>{error}</ErrorNote>}

      {problems.length > 0 && (
        <div data-testid="draft-roadmap-problems" className="flex flex-col gap-2">
          {problems.map((p, i) => {
            const title = p.item ? (rows.find((r) => r.key === p.item)?.title ?? p.item) : null;
            return (
              <Notice key={i} tone="warn" testId="draft-roadmap-problem">
                <b className="font-semibold">{problemLabel(p.code)}</b>
                {title && (
                  <>
                    {" · "}
                    <a
                      href={`#item-${p.item}`}
                      data-testid="draft-roadmap-problem-link"
                      onClick={(e) => {
                        e.preventDefault();
                        goToRow(p.item!);
                      }}
                      className="font-semibold underline underline-offset-2"
                    >
                      {title}
                    </a>
                  </>
                )}
                <span className="font-normal">: {p.message}</span>
              </Notice>
            );
          })}
        </div>
      )}

      {isOwner && <AutoSwitch doc={doc} initial={data.auto} />}

      {rows.length > 0 && (
        <Split inspector={row ? <div className="max-[639px]:hidden">{inspector(row)}</div> : undefined}>
          {diff && <CompareBar diff={diff} compare={compare} onCompare={(c) => setUrl("compare", c)} />}
          <FilterChips<Filter>
            label="Items"
            testId="items-filter"
            value={filter}
            onChange={(f) => setUrl("filter", f)}
            items={[
              { value: "all", label: "All", count: rows.length },
              ...(compared ? [{ value: "changed" as const, label: "Changed", count: changed, testId: "filter-changed" }] : []),
              { value: "attention", label: "Needs attention", count: attention },
            ]}
          />
          <Panel>
            <ItemsTable
              rows={shownRows}
              selected={selected}
              onSelect={onSelect}
              filter={filterFn}
              hide={["state", "engineering", "prd"]}
              extraColumns={columns}
              rowDecorations={decorate}
              label="Proposed roadmap items"
            />
          </Panel>
        </Split>
      )}
      <Sheet open={sheet && !!row} title={row?.title ?? "Item"} onClose={() => setSheet(false)} testId="sheet-item">
        {row && inspector(row)}
      </Sheet>
    </div>
  );
}

/** The derivation's status, in the words of each state, with what an approver can do about it. */
function StatusRow({
  data,
  n,
  latest,
  doc,
  canDerive,
  busy,
  onDerive,
}: {
  data: DraftRoadmapOut;
  n: number;
  latest: number;
  doc: string;
  canDerive: boolean;
  busy: boolean;
  onDerive: () => void;
}) {
  const action = (label: string) =>
    canDerive ? (
      <Button onClick={onDerive} disabled={busy} data-testid="draft-roadmap-derive">
        {label}
      </Button>
    ) : null;
  let copy: ReactNode;
  let act: ReactNode = null;
  switch (data.status) {
    case "queued":
      copy = "Queued. Oracle starts deriving within a minute.";
      break;
    case "running":
      copy = (
        <>
          Deriving roadmap items from v{n} · started {ago(data.requested_at)}
          {data.run_id && (
            <>
              {" · "}
              <Link href={`/runs/${data.run_id}`} className="font-semibold text-accent-ink underline underline-offset-2">
                Open run
              </Link>
            </>
          )}
        </>
      );
      break;
    case "ready": {
      const count = (h: string) => data.items.filter((i) => i.horizon === h).length;
      const horizons = HORIZONS.filter((h) => count(h.value) > 0).map((h) => ` · ${count(h.value)} ${h.label}`).join("");
      const p = data.check?.problems.length ?? 0;
      copy = (
        <span className="tnum">
          <b className="font-semibold text-text">
            {data.items.length} item{data.items.length === 1 ? "" : "s"}
          </b>
          {horizons}
          {data.ready_at ? ` · built ${formatDateTime(data.ready_at)}` : ""}
          {p ? ` · ${p} problem${p === 1 ? "" : "s"}` : ""}
        </span>
      );
      act = action("Build again");
      break;
    }
    case "failed":
      copy = (
        <span className="font-medium">
          {data.requested_at && <span data-testid="failed-at">{failedAt(data.requested_at)}. </span>}
          Oracle could not build the draft roadmap: {data.error ?? "unknown error"}
        </span>
      );
      act = action("Try again");
      break;
    case "superseded":
      copy = (
        <>
          A newer draft (v{latest}) was imported before this one&apos;s draft roadmap was built.{" "}
          <Link href={`/documents/${doc}/v/${latest}/roadmap`} className="font-semibold text-accent-ink underline underline-offset-2">
            Go to v{latest}&apos;s roadmap
          </Link>
        </>
      );
      act = action(`Build for v${n} anyway`);
      break;
    case "off":
      copy = "Refreshing this roadmap for each new PRD version is turned off.";
      act = action("Build draft roadmap now");
      break;
    case "skipped":
      copy = "Nothing to build yet: this version is the template's empty skeleton.";
      act = action("Build anyway");
      break;
    default:
      // qa-docs-64: someone who cannot build it is told who can.
      copy = canDerive ? "No roadmap items for this version yet." : "No roadmap items for this version yet. Approvers and owners can build them.";
      act = action("Build draft roadmap now");
  }
  return (
    <div
      role="status"
      data-testid="draft-roadmap-status"
      data-status={data.status}
      // qa-docs-65: on a phone the words sit above the button, not squeezed beside it.
      className={`flex min-h-10 flex-wrap items-center gap-x-3 gap-y-2 rounded-button px-3 py-2 text-sm max-[600px]:flex-col max-[600px]:items-start ${
        data.status === "failed" ? "bg-warn-bg text-warn" : "border border-line bg-surface text-text2"
      }`}
    >
      <span className="min-w-0 flex-1 max-[600px]:flex-none">{copy}</span>
      {act}
    </div>
  );
}

/** Owners: "Refresh this roadmap whenever a new PRD version is drafted" on this PRD (saved at once). */
function AutoSwitch({ doc, initial }: { doc: string; initial: boolean }) {
  const [on, setOn] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toggle = async (next: boolean) => {
    setOn(next);
    setBusy(true);
    setError(null);
    try {
      const out = await putDraftRoadmapSettings(doc, { each_draft: next });
      setOn(out.each_draft);
    } catch (e) {
      setOn(!next);
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div data-testid="draft-roadmap-auto" className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <label className="flex min-h-10 items-center gap-2 text-sm font-medium text-text">
        <input type="checkbox" className="size-4 accent-[var(--accent)]" checked={on} disabled={busy} onChange={(e) => void toggle(e.target.checked)} />
        Refresh this roadmap whenever a new PRD version is drafted
      </label>
      <InfoTip label="refreshing with each new version" side="bottom" align="start">
        About $5.50 per draft at standard depth. Runs in the background.
      </InfoTip>
      {error && <ErrorNote>{error}</ErrorNote>}
    </div>
  );
}
