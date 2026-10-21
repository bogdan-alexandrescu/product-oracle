"use client";

import { Chip, DataTable, InfoTip, Inspector, InspectorSection, Ring, type Column } from "@/components/ds";
import type { Schemas } from "@/lib/api/client";

import { KIND_LABEL } from "./confidence";
import { FreshnessBar, FreshRing, NoSources, Synced } from "./coverage";

export type CompanyCoverage = Schemas["CompanyCoverage"];
type MemberCoverage = Schemas["CompanyMemberCoverage"];
type KindCoverage = Schemas["CompanyKindCoverage"];

/** One table row: a member's sources of one kind, or (kind null) a member with none. */
export type CompanyRow = { member: MemberCoverage["member"]; kind: KindCoverage | null };

const ROLE_LABEL: Record<string, string> = { owner: "Owner", approver: "Approver", commenter: "Commenter", viewer: "Viewer" };

export const memberName = (m: MemberCoverage["member"]) => m.name ?? m.email;
export const companyRowKey = (r: CompanyRow) => `${r.member.id}:${r.kind?.kind ?? "none"}`;

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
      they hold (S5 Connector auth, S6 Private findings).
    </InfoTip>
  );
}

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
  if (data && data.members_with_sources === 0) return <NoSources>No member has connected a source yet</NoSources>;
  const stale = (data?.members ?? []).filter(staleMember).length;
  const columns: Column<CompanyRow>[] = [
    {
      key: "kind",
      header: "Kind",
      cell: (r) => (
        <span data-testid="company-kind">
          <Chip kind="acc">{r.kind ? KIND_LABEL[r.kind.kind] : "–"}</Chip>
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
          {(r.kind?.items ?? 0).toLocaleString("en-US")}
        </span>
      ),
    },
    {
      key: "fresh",
      header: "Fresh",
      width: "72px",
      align: "center",
      phone: "action",
      cell: (r) => (r.kind ? <FreshRing freshness={r.kind.freshness} testId="company-fresh" /> : null),
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
  return (
    <>
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2.5 max-[600px]:px-3">
        {data && (
          <Chip kind="acc" data-testid="company-members-chip">
            {data.members_with_sources} of {data.members_total} members have a source
          </Chip>
        )}
        {stale > 0 && (
          <Chip kind="warn" data-testid="company-stale-chip">
            {stale} with stale sources
          </Chip>
        )}
      </div>
      <DataTable
        label="Coverage by member"
        testId="company-table"
        columns={columns}
        rows={data ? companyRows(data) : undefined}
        rowKey={companyRowKey}
        loading={loading}
        selected={selected}
        onSelect={(key) => onSelect(key)}
        group={(r) => r.member.id}
        groupOnly={(r) => r.kind === null}
        groupHeader={(r) => (
          <span className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="min-w-0 truncate">{memberName(r.member)}</span>
            <Chip kind="line">{ROLE_LABEL[r.member.role] ?? r.member.role}</Chip>
            {r.kind === null && <Chip kind="na">No sources</Chip>}
          </span>
        )}
      />
    </>
  );
}

/** A selected Company row: the four numbers and the freshness counts, nothing else. */
export function CompanyInspector({ row }: { row: CompanyRow & { kind: KindCoverage } }) {
  const k = row.kind;
  const share = k.items ? Math.round((k.freshness.fresh / k.items) * 100) : null;
  return (
    <Inspector
      testId="company-inspector"
      label="Selected member and kind"
      eyebrow="Company · coverage"
      title={`${memberName(row.member)} · ${KIND_LABEL[k.kind]}`}
      statColumns={2}
      stats={[
        { label: "Sources", value: k.sources },
        { label: "Items", value: k.items.toLocaleString("en-US") },
        {
          label: "Fresh",
          figure: share == null ? <span className="text-text2">–</span> : <Ring value={share} size={40} label={`Fresh ${share}%`} />,
        },
        { label: "Last sync", figure: <Synced at={k.last_synced_at} /> },
      ]}
    >
      <InspectorSection label="Freshness">
        <FreshnessBar freshness={k.freshness} />
      </InspectorSection>
    </Inspector>
  );
}
