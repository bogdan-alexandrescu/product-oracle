"use client";

import Link from "next/link";
import { useState } from "react";

import { ArtifactMenu } from "@/components/ArtifactMenu";
import { BuildRoadmapButton, SourceLink } from "@/components/BuildRoadmap";
import {
  Chip,
  DataTable,
  InfoTip,
  Inspector,
  InspectorRow,
  InspectorSection,
  LinkButton,
  Notice,
  Page,
  PageHeader,
  Panel,
  Split,
  type ChipKind,
  type Column,
} from "@/components/ds";
import { api, unwrap, type Schemas } from "@/lib/api/client";
import { DOC_STATUS_LABEL, formatDateTime } from "@/lib/format";
import { useArtifactsChanged } from "@/lib/artifacts";
import { hasRole, useMe } from "@/lib/me";
import { useQuery } from "@/lib/use-query";
import { versionHref } from "@/lib/version-href";

type Doc = Schemas["DocumentSummary"];
/** One table: the roadmaps, then the approved PRDs that can each build one (B1's "In flight" group). */
type Row = { kind: "roadmap"; d: Doc } | { kind: "prd"; d: Doc; built: Doc[] };

const STATUS_KIND: Record<Doc["status"], ChipKind> = { draft: "na", in_review: "acc", approved: "pass" };
const GROUP = { roadmap: "Roadmaps", prd: "Approved PRDs" } as const;

function StatusChip({ status, hero = false }: { status: Doc["status"]; hero?: boolean }) {
  return (
    <Chip kind={STATUS_KIND[status]} hero={hero} dot={!hero} data-status={status}>
      {DOC_STATUS_LABEL[status]}
    </Chip>
  );
}

function RoadmapInspector({ d }: { d: Doc }) {
  return (
    <Inspector
      eyebrow="Roadmap · selected"
      title={d.title}
      label={`Roadmap ${d.title}`}
      testId="roadmap-inspector"
      action={
        <LinkButton variant="hero" href={`/documents/${d.slug}`}>
          Open
        </LinkButton>
      }
      chips={
        <>
          <StatusChip status={d.status} hero />
          {d.latest_version != null && <Chip hero>v{d.latest_version}</Chip>}
          {d.template && <Chip hero>{d.template}</Chip>}
        </>
      }
      stats={[
        { label: "Latest", value: d.latest_version != null ? `v${d.latest_version}` : "—" },
        { label: "Approved", value: d.approved_version != null ? `v${d.approved_version}` : "—" },
      ]}
    >
      <InspectorSection label="Source PRD">
        {d.source ? <SourceLink source={d.source} /> : <span className="text-text2">—</span>}
      </InspectorSection>
      <InspectorSection label="Template and theme">
        <InspectorRow value={<span className="font-mono text-sm font-medium">{d.template ?? "—"}</span>}>Template</InspectorRow>
        <InspectorRow value={<span className="font-mono text-sm font-medium">{d.theme ?? "—"}</span>}>Theme</InspectorRow>
      </InspectorSection>
      <InspectorSection label="Updated">
        <span className="tnum">{formatDateTime(d.updated_at)}</span>
      </InspectorSection>
    </Inspector>
  );
}

function PrdInspector({ d, built }: { d: Doc; built: Doc[] }) {
  return (
    <Inspector
      eyebrow="PRD · selected"
      title={d.title}
      label={`PRD ${d.title}`}
      testId="roadmap-inspector"
      action={
        <LinkButton variant="hero" href={`/documents/${d.slug}/v/${d.approved_version}`}>
          Open
        </LinkButton>
      }
      chips={<Chip hero>v{d.approved_version} approved</Chip>}
      stats={[
        { label: "Approved", value: `v${d.approved_version}` },
        { label: "Roadmaps", value: built.length },
      ]}
    >
      <InspectorSection label="Roadmaps">
        {built.length === 0 ? (
          <span className="text-text2">—</span>
        ) : (
          built.map((r) => (
            <InspectorRow key={r.id} value={<StatusChip status={r.status} />}>
              <Link href={`/documents/${r.slug}`} className="underline-offset-2 hover:underline">
                {r.title}
              </Link>
            </InspectorRow>
          ))
        )}
      </InspectorSection>
      <InspectorSection>
        <BuildRoadmapButton prd={d} size="sm" />
      </InspectorSection>
    </Inspector>
  );
}

/**
 * Plan's Roadmap documents tab (c7: roadmap documents live inside Plan). Roadmaps (O4b): each
 * opens in the document view, so brief / full, Present, review and the exports work as for a
 * PRD. Approved PRDs below can each build a roadmap.
 */
export default function RoadmapDocumentsPage() {
  const q = useQuery("documents|roadmap", () => unwrap(api.GET("/v1/documents", { params: { query: { kind: "roadmap" } } })));
  const prds = useQuery("documents|prd", () => unwrap(api.GET("/v1/documents", { params: { query: { kind: "prd" } } })));
  const latestReport = useQuery("alignment-reports|latest", () => unwrap(api.GET("/v1/alignment-reports", { params: { query: { limit: 1 } } })));
  useArtifactsChanged(q.reload);
  useArtifactsChanged(prds.reload);
  const { role } = useMe();
  const canBuild = hasRole(role, "approver");
  const [selected, setSelected] = useState<string | null>(null);
  const roadmaps = [...(q.data ?? [])].sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  const approved = (prds.data ?? []).filter((d) => d.approved_version != null);

  const rows: Row[] = [
    ...roadmaps.map((d): Row => ({ kind: "roadmap", d })),
    ...approved.map((d): Row => ({ kind: "prd", d, built: roadmaps.filter((r) => r.source?.slug === d.slug) })),
  ];
  const keyOf = (r: Row) => `${r.kind}:${r.d.id}`;
  const current = rows.find((r) => keyOf(r) === selected) ?? rows[0];
  const loading = (q.loading && !q.data) || (prds.loading && !prds.data);
  const inReview = roadmaps.filter((d) => d.status === "in_review").length;

  const columns: Column<Row>[] = [
    {
      key: "name",
      header: "Roadmap",
      cell: (r) =>
        r.kind === "roadmap" ? (
          <Link href={`/documents/${r.d.slug}`} title={r.d.slug} className="font-semibold hover:underline">
            {r.d.title}
          </Link>
        ) : (
          <Link href={`/documents/${r.d.slug}/v/${r.d.approved_version}`} className="font-semibold hover:underline">
            {r.d.title}
          </Link>
        ),
    },
    {
      key: "template",
      header: "Template",
      width: "150px",
      hideOnPhone: true,
      // The template key alone (the theme is in the inspector). An approved PRD has no template
      // or source of its own; the roadmaps it built are in its inspector.
      cell: (r) =>
        r.kind === "roadmap" ? (
          <span className="font-mono text-sm text-text2" title={r.d.template ?? undefined}>
            {r.d.template ?? "—"}
          </span>
        ) : null,
    },
    {
      key: "state",
      header: "State",
      width: "150px",
      cell: (r) =>
        r.kind === "roadmap" ? (
          <span className="flex items-center gap-2">
            <StatusChip status={r.d.status} />
            {r.d.latest_version != null && (
              <Link
                href={versionHref(r.d.slug, "roadmap", r.d.latest_version)}
                className="tnum font-medium text-accent-ink hover:underline"
              >
                v{r.d.latest_version}
              </Link>
            )}
          </span>
        ) : (
          <Chip kind="pass">v{r.d.approved_version} approved</Chip>
        ),
    },
    {
      key: "source",
      header: "Source PRD",
      width: "200px",
      hideOnPhone: true,
      // The header says where it came from; the cell is the PRD's name alone.
      cell: (r) =>
        r.kind === "roadmap" ? (
          r.d.source ? (
            <Link
              href={`/documents/${r.d.source.slug}/v/${r.d.source.version}`}
              data-testid="roadmap-source"
              title={`${r.d.source.title} v${r.d.source.version}`}
              className="font-medium underline-offset-2 hover:underline"
            >
              {r.d.source.title} v{r.d.source.version}
            </Link>
          ) : (
            <span className="text-text2">—</span>
          )
        ) : null,
    },
    {
      // The row's action, kept on a phone (right of the title).
      key: "action",
      header: <span className="sr-only">Action</span>,
      width: "176px",
      align: "right",
      phone: "action",
      className: "overflow-visible",
      cell: (r) =>
        r.kind === "prd" ? (
          <span className="flex justify-end">
            <BuildRoadmapButton prd={r.d} size="sm" />
          </span>
        ) : (
          <ArtifactMenu doc={{ ...r.d, kind: "roadmap" }} />
        ),
    },
  ];

  return (
    <Page>
      <PageHeader
        title="Plan"
        status={
          q.data && (
            <>
              <Chip kind="acc">{roadmaps.length} {roadmaps.length === 1 ? "roadmap" : "roadmaps"}</Chip>
              {inReview > 0 && <Chip kind="acc">{inReview} in review</Chip>}
              <InfoTip label="Roadmap documents" align="start" side="bottom">
                Each roadmap opens in the document view. A run turns an approved PRD&apos;s version into roadmap items
                and a roadmap draft for review.
              </InfoTip>
            </>
          )
        }
        action={
          <span className="flex flex-wrap items-center gap-2">
            {/* F6: the latest weekly alignment report (the Plan's header button until F1). */}
            <LinkButton href={latestReport.data?.[0] ? `/plan/reports/${latestReport.data[0].id}` : "/plan/reports"}>
              Alignment report
            </LinkButton>
            <LinkButton href="/roadmap/launches" data-testid="roadmap-launches-link">
              Launches
            </LinkButton>
            <LinkButton href="/roadmap/changelog" data-testid="roadmap-changelog-link">
              Changelog
            </LinkButton>
            <LinkButton variant="primary" icon="plus" href="/documents/new?kind=roadmap">
              New roadmap
            </LinkButton>
          </span>
        }
      />
      <div className="flex flex-col gap-3">
        {q.error && <Notice tone="error">{q.error}</Notice>}
        {prds.error && <Notice tone="error">{prds.error}</Notice>}
        <Split
          inspector={
            current &&
            (current.kind === "roadmap" ? (
              <RoadmapInspector key={keyOf(current)} d={current.d} />
            ) : (
              <PrdInspector key={keyOf(current)} d={current.d} built={current.built} />
            ))
          }
        >
          <Panel>
            <DataTable<Row>
              label="Roadmaps"
              testId="roadmaps-table"
              columns={columns}
              rows={loading ? undefined : rows}
              rowKey={keyOf}
              selected={current ? keyOf(current) : null}
              onSelect={(k) => setSelected(k)}
              loading={loading}
              group={(r) => GROUP[r.kind]}
              empty="No roadmaps yet"
              rowProps={(r) => ({ "data-testid": r.kind === "roadmap" ? "roadmap-row" : "approved-prd" })}
            />
            {!loading && (!canBuild || approved.length === 0 || (rows.length > 0 && roadmaps.length === 0)) && (
              <div className="flex flex-wrap items-center gap-2 border-t border-line px-4 py-2.5 text-sm text-text2 max-[600px]:px-3">
                {rows.length > 0 && roadmaps.length === 0 && <Chip kind="na">No roadmaps yet</Chip>}
                {approved.length === 0 && <Chip kind="na">No approved PRDs</Chip>}
                {!canBuild && <span>Approvers and owners start these runs.</span>}
              </div>
            )}
          </Panel>
        </Split>
      </div>
    </Page>
  );
}
