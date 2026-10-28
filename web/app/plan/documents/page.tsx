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
  ViewOnly,
  type ChipKind,
  type Column,
} from "@/components/ds";
import { api, unwrap, type Schemas } from "@/lib/api/client";
import { DOC_STATUS_LABEL, formatDateTime, formatDay, plural } from "@/lib/format";
import { docLabel } from "@/lib/labels";
import { useArtifactsChanged } from "@/lib/artifacts";
import { useMe } from "@/lib/me";
import { useQuery } from "@/lib/use-query";
import { versionHref } from "@/lib/version-href";

type Doc = Schemas["DocumentSummary"];
/** One table: the roadmaps, then the approved PRDs that can each build one (B1's "In flight" group). */
type Row = { kind: "roadmap"; d: Doc } | { kind: "prd"; d: Doc; built: Doc[] };

const STATUS_KIND: Record<Doc["status"], ChipKind> = { draft: "na", in_review: "acc", approved: "pass" };
const GROUP = { roadmap: "Roadmaps", prd: "Approved PRDs" } as const;

/** A template's or theme's key in words, until the list names it: "roadmap-board" is "Roadmap board". */
function keyWords(key: string): string {
  const words = key.replace(/[-_.]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Roadmap templates and themes by their names, as the Build roadmap dialog shows them. */
function useStyleNames() {
  const templates = useQuery("templates|roadmap", () => unwrap(api.GET("/v1/templates", { params: { query: { kind: "roadmap" } } })));
  const themes = useQuery("themes|roadmap", () => unwrap(api.GET("/v1/themes", { params: { query: { kind: "roadmap" } } })));
  const name = (list: { key: string; name: string }[] | undefined, key: string | null | undefined) =>
    key ? (list?.find((t) => t.key === key)?.name ?? keyWords(key)) : null;
  return {
    template: (key: string | null | undefined) => name(templates.data, key),
    theme: (key: string | null | undefined) => name(themes.data, key),
  };
}
type StyleNames = ReturnType<typeof useStyleNames>;

/** "v1, Oct 18": the approved version and the day it was approved, read off the versions. */
function ApprovedValue({ d }: { d: Doc }) {
  const versions = useQuery(`versions|${d.slug}`, () =>
    unwrap(api.GET("/v1/documents/{doc}/versions", { params: { path: { doc: d.slug } } })),
  );
  if (d.approved_version == null) return <>Not yet</>;
  const at = versions.data?.find((v) => v.number === d.approved_version)?.approved_at;
  return (
    <span data-testid="roadmap-approved">
      v{d.approved_version}
      {at ? `, ${formatDay(at)}` : ""}
    </span>
  );
}

function StatusChip({ status, hero = false }: { status: Doc["status"]; hero?: boolean }) {
  return (
    <Chip kind={STATUS_KIND[status]} hero={hero} dot={!hero} data-status={status}>
      {DOC_STATUS_LABEL[status]}
    </Chip>
  );
}

/** O5: a roadmap's active share links and the next to end (approvers and owners). */
function SharedCell({ slug }: { slug: string }) {
  const q = useQuery(`share-links|${slug}|plan`, () => unwrap(api.GET("/v1/documents/{doc}/share-links", { params: { path: { doc: slug } } })));
  const active = (q.data ?? []).filter((l) => l.state === "active");
  const next = active.map((l) => l.expires_at).sort()[0];
  return (
    <span data-testid="shared-cell" className="tnum block text-sm leading-4 text-text2">
      {!q.data ? "" : next ? (
        <>
          <span className="block">{active.length} active</span>
          <span className="block">ends {formatDay(next)}</span>
        </>
      ) : (
        "—"
      )}
    </span>
  );
}

function RoadmapInspector({ d, names }: { d: Doc; names: StyleNames }) {
  const template = names.template(d.template);
  const theme = names.theme(d.theme);
  return (
    <Inspector
      eyebrow="Roadmap · selected"
      title={docLabel({ title: d.title, kind: "roadmap" })}
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
          {template && <Chip hero>{template}</Chip>}
        </>
      }
      stats={[
        { label: "Latest", value: d.latest_version != null ? `v${d.latest_version}` : "—" },
        { label: "Approved", value: <ApprovedValue d={d} /> },
      ]}
    >
      <InspectorSection label="Source PRD">
        {d.source ? <SourceLink source={d.source} /> : <span className="text-text2">—</span>}
      </InspectorSection>
      <InspectorSection label="Template and theme">
        <InspectorRow value={<span className="text-sm font-medium">{template ?? "—"}</span>}>Template</InspectorRow>
        <InspectorRow value={<span className="text-sm font-medium">{theme ?? "—"}</span>}>Theme</InspectorRow>
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
      title={docLabel({ title: d.title, kind: "prd" })}
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
                {docLabel({ title: r.title, kind: "roadmap" })}
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
  useArtifactsChanged(q.reload);
  useArtifactsChanged(prds.reload);
  const { can, capsReady } = useMe();
  // create_run's item check refuses only an update draft below owner (runs/service.py); a
  // roadmap build is not one, so the item lets an approver in.
  const canBuild = can("create_run", true);
  const [selected, setSelected] = useState<string | null>(null);
  const names = useStyleNames();
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
      // The name in full: it wraps rather than being cut.
      wrap: true,
      cell: (r) =>
        r.kind === "roadmap" ? (
          <Link href={`/documents/${r.d.slug}`} data-testid="roadmap-name" className="font-semibold hover:underline">
            {docLabel({ title: r.d.title, kind: "roadmap" })}
          </Link>
        ) : (
          <Link href={`/documents/${r.d.slug}/v/${r.d.approved_version}`} data-testid="roadmap-name" className="font-semibold hover:underline">
            {docLabel({ title: r.d.title, kind: "prd" })}
          </Link>
        ),
    },
    {
      key: "template",
      header: "Template",
      width: "128px",
      hideOnPhone: true,
      // A narrow table drops it: the inspector names the template too.
      narrow: "hide",
      wrap: true,
      // The template by name alone (the theme is in the inspector). An approved PRD has no
      // template or source of its own; the roadmaps it built are in its inspector.
      cell: (r) =>
        r.kind === "roadmap" ? (
          <span className="text-sm text-text2" data-testid="roadmap-template">
            {names.template(r.d.template) ?? "—"}
          </span>
        ) : null,
    },
    {
      key: "state",
      header: "State",
      width: "150px",
      cell: (r) =>
        r.kind === "roadmap" ? (
          <span className="flex flex-col gap-0.5">
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
            {/* An earlier version may be approved while a later one is in review. */}
            {r.d.approved_version != null && r.d.status !== "approved" && (
              <span className="tnum text-[13px] leading-4 text-text2" data-testid="roadmap-approved-version">
                v{r.d.approved_version} approved
              </span>
            )}
          </span>
        ) : (
          <Chip kind="pass">v{r.d.approved_version} approved</Chip>
        ),
    },
    ...(can("list_share_links")
      ? [
          {
            key: "shared",
            header: "Shared",
            width: "96px",
            hideOnPhone: true,
            cell: (r: Row) => (r.kind === "roadmap" ? <SharedCell slug={r.d.slug} /> : null),
          },
        ]
      : []),
    {
      key: "source",
      header: "Source PRD",
      width: "180px",
      hideOnPhone: true,
      wrap: true,
      // The header says where it came from; the cell is the PRD's name alone.
      cell: (r) =>
        r.kind === "roadmap" ? (
          r.d.source ? (
            <Link
              href={`/documents/${r.d.source.slug}/v/${r.d.source.version}`}
              data-testid="roadmap-source"
              className="font-medium underline-offset-2 hover:underline"
            >
              {docLabel({ title: r.d.source.title, kind: "prd" })} v{r.d.source.version}
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
        info={
          <InfoTip label="Roadmap documents" align="start" side="bottom">
            Each roadmap opens in the document view. A run turns an approved PRD&apos;s version into roadmap items
            and a roadmap draft for review.
          </InfoTip>
        }
        status={
          q.data && (
            <>
              {capsReady && !canBuild && <ViewOnly />}
              <Chip kind="acc">{plural(roadmaps.length, "roadmap")}</Chip>
              {inReview > 0 && <Chip kind="acc">{inReview} in review</Chip>}
            </>
          )
        }
        action={
          <span className="flex flex-wrap items-center gap-2">
            {/* F6: the latest weekly alignment report (the Plan's header button until F1). */}
            <LinkButton href="/plan/reports/latest">
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
              <RoadmapInspector key={keyOf(current)} d={current.d} names={names} />
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
            {!loading && (approved.length === 0 || (rows.length > 0 && roadmaps.length === 0)) && (
              <div className="flex flex-wrap items-center gap-2 border-t border-line px-4 py-2.5 text-sm text-text2 max-[600px]:px-3">
                {rows.length > 0 && roadmaps.length === 0 && <Chip kind="na">No roadmaps yet</Chip>}
                {approved.length === 0 && <Chip kind="na">No approved PRDs</Chip>}
              </div>
            )}
          </Panel>
        </Split>
      </div>
    </Page>
  );
}
