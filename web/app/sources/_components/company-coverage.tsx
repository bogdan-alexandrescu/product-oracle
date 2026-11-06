"use client";

import { useState } from "react";

import { Chip, DataTable, InfoTip, Inspector, InspectorSection, type Column } from "@/components/ds";
import type { Schemas } from "@/lib/api/client";
import { formatCount, formatPercent, plural } from "@/lib/format";

import { KIND_LABEL } from "./confidence";
import { FreshnessBar, FreshShare, NONE, NoSources, Synced } from "./coverage";

export type CompanyCoverage = Schemas["CompanyCoverage"];
type MemberCoverage = Schemas["CompanyMemberCoverage"];
type KindCoverage = Schemas["CompanyKindCoverage"];

/** One table row: a member's sources of one kind, or (kind null) a member with none. */
export type CompanyRow = { member: MemberCoverage["member"]; kind: KindCoverage | null };

const ROLE_LABEL: Record<string, string> = { owner: "Owner", approver: "Approver", commenter: "Commenter", viewer: "Viewer" };

export const memberName = (m: MemberCoverage["member"]) => m.name ?? m.email;
export const companyRowKey = (r: CompanyRow) => `${r.member.id}:${r.kind?.kind ?? "none"}`;

/**
 * A member's name with their email secondary; the email alone when there is no name (F-55:
 * the API/mock may send none, so this derives nothing fake).
 */
function MemberLabel({ member }: { member: MemberCoverage["member"] }) {
  if (!member.name) return <span className="min-w-0 truncate">{member.email}</span>;
  return (
    <span className="flex min-w-0 flex-col">
      <span className="min-w-0 truncate">{member.name}</span>
      <span className="min-w-0 truncate text-[13px] font-normal text-text2">{member.email}</span>
    </span>
  );
}

/** A member is stale when the fresh share of their live items is below half. */
function staleMember(m: MemberCoverage): boolean {
  const items = m.kinds.reduce((s, k) => s + k.items, 0);
  const fresh = m.kinds.reduce((s, k) => s + k.freshness.fresh, 0);
  return items > 0 && fresh / items < 0.5;
}

export function companyRows(data: CompanyCoverage | undefined): CompanyRow[] {
  return (data?.members ?? []).flatMap((m): CompanyRow[] =>
    m.kinds.length ? m.kinds.map((kind) => ({ member: m.member, kind })) : [{ member: m.member, kind: null }],
  );
}

/** Counts only: you see how many sources each member connected and how fresh they are. */
export function CountsOnlyTip() {
  return (
    <InfoTip label="Company" align="end">
      Counts only. You see how many sources each member connected and how fresh they are, never their names or what
      they hold.
    </InfoTip>
  );
}

/** Which members a filter chip keeps; pressing the same one again, or All, clears it. */
type MemberFilter = "without-source" | "stale" | null;

/** Company: per member and source kind, grouped by member. */
export function CompanyTable({
  data,
  loading,
  selected,
  onSelect,
}: {
  data: CompanyCoverage | undefined;
  loading: boolean;
  selected: string | null;
  onSelect: (key: string) => void;
}) {
  const [filter, setFilter] = useState<MemberFilter>(null);
  if (data && data.members_with_sources === 0) return <NoSources>No member has connected a source yet</NoSources>;
  const staleIds = new Set((data?.members ?? []).filter(staleMember).map((m) => m.member.id));
  const stale = staleIds.size;
  const allRows = data ? companyRows(data) : undefined;
  const rows =
    allRows &&
    (filter === "without-source"
      ? allRows.filter((r) => r.kind === null)
      : filter === "stale"
        ? allRows.filter((r) => staleIds.has(r.member.id))
        : allRows);
  const columns: Column<CompanyRow>[] = [
    {
      key: "kind",
      header: "Member",
      cell: (r) => (
        <span data-testid="company-kind">
          <Chip kind="acc">{r.kind ? KIND_LABEL[r.kind.kind] : NONE}</Chip>
        </span>
      ),
    },
    {
      key: "sources",
      header: "Sources",
      width: "84px",
      align: "right",
      phone: "meta",
      phoneLabel: "Sources",
      cell: (r) => (
        <span className="tnum" data-testid="company-sources">
          {r.kind?.sources ?? 0}
        </span>
      ),
    },
    {
      key: "items",
      header: "Items",
      width: "84px",
      align: "right",
      hideOnPhone: true,
      cell: (r) => (
        <span className="tnum" data-testid="company-items">
          {formatCount(r.kind?.items ?? 0)}
        </span>
      ),
    },
    {
      key: "fresh",
      header: "Fresh",
      width: "96px",
      align: "right",
      phone: "action",
      cell: (r) => (r.kind ? <FreshShare freshness={r.kind.freshness} testId="company-fresh" /> : null),
    },
    {
      key: "synced",
      header: "Last sync",
      width: "96px",
      align: "right",
      hideOnPhone: true,
      cell: (r) => <Synced at={r.kind?.last_synced_at} testId="company-synced" />,
    },
  ];
  const toggle = (f: MemberFilter) => setFilter((cur) => (cur === f ? null : f));
  return (
    <>
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2.5 max-[600px]:px-3">
        {data && (
          <button type="button" aria-pressed={filter === "without-source"} onClick={() => toggle("without-source")}>
            <Chip kind="acc" data-testid="company-members-chip">
              {data.members_with_sources} of {plural(data.members_total, "member")} have a source
            </Chip>
          </button>
        )}
        {stale > 0 && (
          <button type="button" aria-pressed={filter === "stale"} onClick={() => toggle("stale")}>
            <Chip kind="warn" data-testid="company-stale-chip">
              {stale} with stale sources
            </Chip>
          </button>
        )}
        {filter && (
          <button type="button" data-testid="company-filter-all" onClick={() => setFilter(null)}>
            <Chip kind="line">All</Chip>
          </button>
        )}
      </div>
      <DataTable
        label="Coverage by member"
        testId="company-table"
        columns={columns}
        rows={rows}
        rowKey={companyRowKey}
        loading={loading}
        selected={selected}
        onSelect={(key) => onSelect(key)}
        group={(r) => r.member.id}
        groupOnly={(r) => r.kind === null}
        groupHeader={(r) => (
          <span className="flex min-w-0 flex-wrap items-center gap-2">
            <MemberLabel member={r.member} />
            <Chip kind="line">{ROLE_LABEL[r.member.role] ?? r.member.role}</Chip>
            {r.kind === null && <Chip kind="na">No sources</Chip>}
          </span>
        )}
        empty={filter === "without-source" ? "Every member has a source" : filter === "stale" ? "No stale sources" : undefined}
      />
    </>
  );
}

/** A selected Company row: the four numbers and the freshness counts, nothing else. */
export function CompanyInspector({ row }: { row: CompanyRow & { kind: KindCoverage } }) {
  const k = row.kind;
  return (
    <Inspector
      testId="company-inspector"
      label="Selected member and kind"
      eyebrow="Company · coverage"
      title={`${memberName(row.member)} · ${KIND_LABEL[k.kind]}`}
      statColumns={2}
      stats={[
        { label: "Sources", value: k.sources },
        { label: "Items", value: formatCount(k.items) },
        { label: "Fresh", value: k.items ? formatPercent(k.freshness.fresh / k.items) : NONE },
        { label: "Last sync", figure: <Synced at={k.last_synced_at} /> },
      ]}
    >
      <InspectorSection label="Freshness">
        <FreshnessBar freshness={k.freshness} />
      </InspectorSection>
    </Inspector>
  );
}
