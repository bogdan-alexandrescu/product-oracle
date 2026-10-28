"use client";

import Link from "next/link";
import type { ReactNode } from "react";

import {
  Button,
  Chip,
  DataTable,
  Empty,
  Icon,
  InfoTip,
  Inspector,
  InspectorRow,
  InspectorSection,
  LinkButton,
  type Column,
} from "@/components/ds";
import type { Schemas } from "@/lib/api/client";
import { formatAge, formatCount, formatDate, formatDateTime, formatPercent, plural } from "@/lib/format";

import { itemKinds, KIND_LABEL } from "./confidence";

export type Coverage = Schemas["SourceCoverage"];
export type CoverageDetail = Schemas["SourceCoverageDetail"];
type Freshness = Schemas["FreshnessCounts"];
type UsedIn = Schemas["UsedIn"];
type NotReadStatus = NonNullable<Schemas["UnavailableItem"]["status"]>;

export const STATUS_LABEL: Record<Coverage["status"], string> = {
  active: "Active",
  paused: "Paused",
  error: "Error",
  needs_attention: "Needs attention",
};
const NOT_READ_LABEL: Record<NotReadStatus, string> = {
  skipped: "Skipped",
  unavailable: "No access",
  flagged: "Flagged",
  limited: "Limited",
};

const n = formatCount;

/** No value: one dash style on the page. */
export const NONE = "—";

/** The last sync, relative, with the full date in the title; "Never" before the first. */
export function Synced({ at, testId }: { at: string | null | undefined; testId?: string }) {
  if (!at) return <span data-testid={testId}>Never</span>;
  return (
    <span data-testid={testId} title={formatDateTime(at)}>
      {formatAge(at)}
    </span>
  );
}

const total = (f: Freshness) => f.fresh + f.aging + f.stale;

/** The fresh share of a source's items in words ("50% fresh"), with the counts on hover; "—" with no items. */
export function FreshShare({ freshness, testId }: { freshness: Freshness; testId?: string }) {
  const items = total(freshness);
  if (!items) {
    return (
      <span data-testid={testId} className="text-text2" title="No items yet">
        {NONE}
      </span>
    );
  }
  const share = formatPercent(freshness.fresh / items);
  return (
    <span
      data-testid={testId}
      className="tnum whitespace-nowrap"
      title={`${formatCount(freshness.fresh)} of ${plural(items, "item")} fresh: newer than their kind's half-life`}
    >
      {share} fresh
    </span>
  );
}

/** Fresh / Aging / Stale as one bar, with the counts below it. */
export function FreshnessBar({ freshness }: { freshness: Freshness }) {
  const items = total(freshness) || 1;
  const parts = [
    { key: "fresh", label: "Fresh", value: freshness.fresh, cls: "bg-accent" },
    { key: "aging", label: "Aging", value: freshness.aging, cls: "bg-warn" },
    { key: "stale", label: "Stale", value: freshness.stale, cls: "bg-line-strong" },
  ];
  return (
    <div className="flex flex-col gap-2">
      <div aria-hidden className="flex h-2.5 overflow-hidden rounded-full bg-surface2">
        {parts.map((p) => (p.value ? <span key={p.key} className={p.cls} style={{ width: `${(p.value / items) * 100}%` }} /> : null))}
      </div>
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-sm" aria-label="Freshness">
        {parts.map((p) => (
          <li key={p.key} data-testid={`freshness-${p.key}`} className="flex items-center gap-1.5">
            <span aria-hidden className={`size-2.5 rounded-full ${p.cls}`} />
            {p.label} <b className="tnum">{n(p.value)}</b>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The reason without the status the chip beside it already says: "Skipped: shared from outside" is "Shared from outside". */
function whyNotRead(reason: string, label: string): string {
  const prefix = `${label.toLowerCase()}:`;
  const rest = reason.toLowerCase().startsWith(prefix) ? reason.slice(prefix.length).trim() : reason.trim();
  return rest.charAt(0).toUpperCase() + rest.slice(1);
}

const notReadTotal = (c: Coverage) => c.not_read.skipped + c.not_read.unavailable + c.not_read.flagged + c.not_read.limited;
const usedTotal = (c: Coverage) => c.used.evidence + c.used.citations + c.used.section_links;

/** Mine: one line per source. */
export function CoverageTable({
  rows,
  loading,
  selected,
  onSelect,
}: {
  rows: Coverage[] | undefined;
  loading: boolean;
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  const columns: Column<Coverage>[] = [
    {
      key: "source",
      header: "Source",
      cell: (c) => (
        <span className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 truncate font-semibold">{c.name}</span>
          <Chip kind="acc">{KIND_LABEL[c.kind]}</Chip>
        </span>
      ),
    },
    {
      key: "items",
      header: "Items",
      width: "80px",
      align: "right",
      phoneLabel: "Items",
      cell: (c) => (
        <span className="tnum" data-testid="coverage-items">
          {n(c.items)}
        </span>
      ),
    },
    {
      key: "not-read",
      header: "Not read",
      width: "92px",
      align: "right",
      phoneLabel: "Not read",
      cell: (c) => {
        const v = notReadTotal(c);
        return (
          <span data-testid="coverage-not-read">
            {v > 0 ? (
              <Chip kind="warn" title="Skipped, unreadable, flagged or limited">
                {n(v)}
              </Chip>
            ) : (
              "0"
            )}
          </span>
        );
      },
    },
    {
      key: "fresh",
      header: "Fresh",
      width: "96px",
      align: "right",
      phone: "action",
      cell: (c) => <FreshShare freshness={c.freshness} testId="coverage-fresh" />,
    },
    {
      key: "used",
      header: "Used",
      width: "72px",
      align: "right",
      phoneLabel: "Used",
      cell: (c) => (
        <span className="tnum" data-testid="coverage-used">
          {n(usedTotal(c))}
        </span>
      ),
    },
    {
      key: "synced",
      header: "Synced",
      width: "84px",
      align: "right",
      phoneLabel: "Synced",
      cell: (c) => <Synced at={c.last_synced_at} testId="coverage-synced" />,
    },
  ];
  return (
    <DataTable
      label="Coverage of my sources"
      testId="coverage-table"
      columns={columns}
      rows={rows}
      rowKey={(c) => c.source_id}
      loading={loading}
      selected={selected}
      onSelect={(id) => onSelect(id)}
    />
  );
}

/** One use: a link to the baseline item, the document version, or the section. */
function UseRow({ use }: { use: UsedIn }) {
  let href = "";
  let icon: "baseline" | "doc" | "outline" = "doc";
  let title: ReactNode = null;
  let extra: ReactNode = null;
  if (use.kind === "evidence") {
    icon = "baseline";
    title = use.entity?.title ?? "Baseline item";
    extra = use.entity ? <Chip kind="acc">{use.entity.type}</Chip> : null;
    href = use.entity ? `/baseline?entity=${use.entity.id}` : "/baseline";
  } else if (use.document) {
    const base = `/documents/${use.document.slug}${use.version ? `/v/${use.version}` : ""}`;
    title = use.document.title;
    if (use.kind === "citation") {
      href = base;
      extra = use.version ? <Chip kind="na">v{use.version}</Chip> : null;
    } else {
      icon = "outline";
      href = use.section_key ? `${base}#${use.section_key}` : base;
      extra = <span className="min-w-0 truncate text-text2">{use.section_title ?? use.section_key}</span>;
    }
  }
  const body = (
    <>
      <Icon name={icon} size={16} />
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 truncate font-semibold">{title}</span>
          {extra}
        </span>
        <span className="block truncate text-[13px] text-text2">
          {use.item.title ?? "Item"} · {formatDate(use.at)}
        </span>
      </span>
    </>
  );
  return (
    <li data-kind={use.kind} className="border-t border-line first:border-t-0">
      {href ? (
        <Link href={href} className="flex min-w-0 items-center gap-2.5 py-2 hover:text-accent-ink">
          {body}
        </Link>
      ) : (
        <span className="flex min-w-0 items-center gap-2.5 py-2">{body}</span>
      )}
    </li>
  );
}

/** The selected source: items by kind, freshness, what was not read, where it is used. */
export function CoverageInspector({
  detail,
  summary,
  busy,
  canSync,
  onSync,
  onLoadMore,
  loadingMore,
  endpoint,
}: {
  detail: CoverageDetail | undefined;
  summary: Coverage;
  busy: boolean;
  /** Whether the person may sync and edit sources (a viewer reads only). */
  canSync: boolean;
  onSync: () => void;
  onLoadMore: () => void;
  loadingMore: boolean;
  /** Fireflies: the GraphQL endpoint the source's connection reads. */
  endpoint?: string | null;
}) {
  const c = detail ?? summary;
  return (
    <Inspector
      testId="coverage-inspector"
      label="Selected source"
      eyebrow="Source · coverage"
      title={c.name}
      chips={
        <>
          <Chip hero>{KIND_LABEL[c.kind]}</Chip>
          <Chip hero>{STATUS_LABEL[c.status]}</Chip>
        </>
      }
      stats={[
        { label: "Items", value: n(c.items) },
        { label: "Not read", value: n(notReadTotal(c)), tone: notReadTotal(c) > 0 ? "warn" : undefined },
        { label: "Used", value: n(usedTotal(c)) },
      ]}
    >
      {c.kind === "fireflies" && endpoint && (
        <InspectorSection label="Reads" testId="coverage-endpoint">
          <p className="min-w-0 truncate font-mono text-sm" title={endpoint}>
            {endpoint}
          </p>
        </InspectorSection>
      )}
      <InspectorSection label="Items" testId="coverage-kinds">
        {(detail?.by_kind ?? []).map((k) => (
          <InspectorRow
            key={k.kind}
            value={
              <>
                {n(k.items)}
                {k.newest_at && <span className="ml-2 font-normal text-text2">{formatDate(k.newest_at)}</span>}
              </>
            }
          >
            {itemKinds(k.kind)}
          </InspectorRow>
        ))}
        <InspectorRow value={n(c.removed)}>
          <span className="inline-flex items-center gap-1.5">
            Removed
            <InfoTip label="Removed" align="start">
              Removed when you narrowed your picks, or deleted where they live.
            </InfoTip>
          </span>
        </InspectorRow>
      </InspectorSection>
      <InspectorSection
        testId="coverage-freshness"
        label={
          <>
            Freshness
            <InfoTip label="Freshness" align="start">
              Fresh: newer than this kind&apos;s half-life
              {detail?.by_kind[0] ? ` (${KIND_LABEL[c.kind]} ${detail.by_kind[0].half_life_days} days)` : ""}. Aging: up to two
              half-lives. Stale: older. Sync now brings in what changed since the last sync.
            </InfoTip>
          </>
        }
      >
        <FreshnessBar freshness={c.freshness} />
        <div className="mt-2 flex gap-4 text-sm text-text2">
          <span>
            Newest <b className="text-text" title={c.newest_at ? formatDateTime(c.newest_at) : undefined}>{c.newest_at ? formatAge(c.newest_at) : NONE}</b>
          </span>
          <span>
            Oldest <b className="text-text" title={c.oldest_at ? formatDateTime(c.oldest_at) : undefined}>{c.oldest_at ? formatAge(c.oldest_at) : NONE}</b>
          </span>
        </div>
      </InspectorSection>
      <InspectorSection label="Not read">
        {detail && detail.not_read_items.length === 0 ? (
          <p className="text-sm text-text2">Nothing left out</p>
        ) : (
          <ul aria-label="Not read" className="flex flex-col">
            {(detail?.not_read_items ?? []).map((u) => {
              const status = u.status ?? "unavailable";
              return (
                <li key={u.external_id} className="flex min-w-0 flex-wrap items-center gap-x-2.5 border-t border-line py-1.5 first:border-t-0">
                  <span className="min-w-0 flex-1 truncate" title={u.name ?? undefined}>
                    {u.name ?? "Unnamed item"}
                  </span>
                  <Chip kind={status === "skipped" ? "na" : "warn"} title={u.reason}>
                    {NOT_READ_LABEL[status]}
                  </Chip>
                  {/* qa-work-51: why it was not read, on every width. */}
                  <span data-testid="not-read-reason" className="basis-full text-[13px] text-text2">
                    {whyNotRead(u.reason, NOT_READ_LABEL[status])}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </InspectorSection>
      <InspectorSection label="Used in">
        {detail && detail.used_in.length === 0 ? (
          <p className="text-sm text-text2">Not used yet</p>
        ) : (
          <>
            <ul aria-label="Used in">
              {(detail?.used_in ?? []).map((u, i) => (
                <UseRow key={`${u.kind}-${u.at}-${i}`} use={u} />
              ))}
            </ul>
            {detail && detail.used_in.length < detail.used_in_total && (
              <Button variant="ghost" onClick={onLoadMore} disabled={loadingMore}>
                Load more
              </Button>
            )}
          </>
        )}
      </InspectorSection>
      <InspectorSection>
        {canSync ? (
          <div className="flex flex-wrap items-center gap-2">
            {c.kind !== "upload" && (
              <Button onClick={onSync} disabled={busy || c.status === "paused"} icon="clock">
                {busy ? "Syncing…" : "Sync now"}
              </Button>
            )}
            <LinkButton href={`/settings/sources#source-${c.source_id}`} icon="settings">
              Edit picks
            </LinkButton>
            {c.status === "paused" && c.kind !== "upload" && <span className="text-sm text-text2">Paused: resume it to sync</span>}
          </div>
        ) : (
          <p className="text-sm text-text2" data-testid="sync-viewer-note">
            Viewers can read coverage; a commenter or above syncs and edits sources.
          </p>
        )}
      </InspectorSection>
    </Inspector>
  );
}

/** No sources yet: where to add one. */
export function NoSources({ children = "No sources yet" }: { children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-3 pb-8">
      <Empty icon="sources">{children}</Empty>
      <LinkButton href="/settings/sources" icon="plus">
        Add a source
      </LinkButton>
    </div>
  );
}

export type CoverageTab = "mine" | "company";

/** Mine and Company (owners only): tab semantics, arrow keys move between them. */
export function CoverageTabs({ value, onChange }: { value: CoverageTab; onChange: (t: CoverageTab) => void }) {
  const items: { id: CoverageTab; label: string }[] = [
    { id: "mine", label: "Mine" },
    { id: "company", label: "Company" },
  ];
  return (
    <div
      role="tablist"
      aria-label="Coverage"
      onKeyDown={(e) => {
        if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
        e.preventDefault();
        const next = value === "mine" ? "company" : "mine";
        onChange(next);
        e.currentTarget.querySelector<HTMLElement>(`[data-testid="coverage-tab-${next}"]`)?.focus();
      }}
      className="inline-flex flex-none overflow-hidden rounded-button border border-line-strong bg-surface"
    >
      {items.map((t) => {
        const on = t.id === value;
        return (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={on}
            tabIndex={on ? 0 : -1}
            data-testid={`coverage-tab-${t.id}`}
            onClick={() => onChange(t.id)}
            className={`flex h-8 items-center px-3 text-sm font-medium whitespace-nowrap not-last:border-r not-last:border-line ${
              on ? "bg-accent text-on-accent" : "text-text hover:bg-surface2"
            }`}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}
