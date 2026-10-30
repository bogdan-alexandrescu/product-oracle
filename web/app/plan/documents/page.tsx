"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";

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
/**
 * A row of either table: the roadmaps, and below them the approved PRDs that can each build
 * one. qa-plan-49: each in its own table under its own headers, so a PRD's "v1 approved" is
 * never under a roadmap's Template.
 */
type Row = { kind: "roadmap"; d: Doc } | { kind: "prd"; d: Doc; built: Doc[] };

const STATUS_KIND: Record<Doc["status"], ChipKind> = { draft: "na", in_review: "acc", approved: "pass" };
/** qa-plan-51: a link in a row is a tap target of at least 24 x 24 px. */
const TAP = "inline-block min-h-6 py-px";

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
  if (d.approved_version == null) return null;
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
      eyebrow="Roadmap"
      title={docLabel({ title: d.title, kind: "roadmap" })}
      label={`Roadmap ${d.title}`}
      testId="roadmap-inspector"
      // fix4 qa-plan-23: the head on the card surface, as the Plan's and Priorities' inspectors.
      tone="card"
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
    >
      {/* fix4 qa-plan-22: each version's label first, its value beside it (never a value above its label). */}
      <InspectorSection label="Versions" testId="roadmap-versions">
        <InspectorRow value={<span className="text-sm font-medium">{d.latest_version != null ? `v${d.latest_version}` : "—"}</span>}>Latest</InspectorRow>
        <InspectorRow
          value={
            // qa-plan-50: not approved is a status, shown as a chip, not as a big figure.
            d.approved_version == null ? (
              <Chip kind="na" data-testid="roadmap-not-approved">
                Not approved yet
              </Chip>
            ) : (
              <span className="text-sm font-medium">
                <ApprovedValue d={d} />
              </span>
            )
          }
        >
          Approved
        </InspectorRow>
      </InspectorSection>
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
      eyebrow="PRD"
      title={docLabel({ title: d.title, kind: "prd" })}
      label={`PRD ${d.title}`}
      testId="roadmap-inspector"
      tone="card"
      action={
        <LinkButton variant="hero" href={`/documents/${d.slug}/v/${d.approved_version}`}>
          Open
        </LinkButton>
      }
      chips={<Chip hero>v{d.approved_version} approved</Chip>}
    >
      <InspectorSection label={`Roadmaps (${built.length})`}>
        {built.length === 0 ? (
          <span className="text-text2">—</span>
        ) : (
          built.map((r) => (
            <InspectorRow key={r.id} value={<StatusChip status={r.status} />}>
              <Link href={`/documents/${r.slug}`} className={`${TAP} underline-offset-2 hover:underline`}>
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
  return (
    <Suspense fallback={null}>
      <RoadmapDocuments />
    </Suspense>
  );
}

function RoadmapDocuments() {
  const q = useQuery("documents|roadmap", () => unwrap(api.GET("/v1/documents", { params: { query: { kind: "roadmap" } } })));
  const prds = useQuery("documents|prd", () => unwrap(api.GET("/v1/documents", { params: { query: { kind: "prd" } } })));
  useArtifactsChanged(q.reload);
  useArtifactsChanged(prds.reload);
  const { can, capsReady } = useMe();
  // create_run's item check refuses only an update draft below owner (runs/service.py); a
  // roadmap build is not one, so the item lets an approver in.
  const canBuild = can("create_run", true);
  const [selected, setSelected] = useState<string | null>(null);
  // fix4 qa-plan-3: ?prd=<slug> (the report's "Build the roadmap from it") opens on that PRD's row.
  const wantedPrd = useSearchParams().get("prd");
  const names = useStyleNames();
  const roadmaps = [...(q.data ?? [])].sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  const approved = (prds.data ?? []).filter((d) => d.approved_version != null);

  const rows: Row[] = [
    ...roadmaps.map((d): Row => ({ kind: "roadmap", d })),
    ...approved.map((d): Row => ({ kind: "prd", d, built: roadmaps.filter((r) => r.source?.slug === d.slug) })),
  ];
  const keyOf = (r: Row) => `${r.kind}:${r.d.id}`;
  const current =
    rows.find((r) => keyOf(r) === selected) ?? (selected == null ? rows.find((r) => r.kind === "prd" && r.d.slug === wantedPrd) : undefined) ?? rows[0];
  const loading = (q.loading && !q.data) || (prds.loading && !prds.data);
  const inReview = roadmaps.filter((d) => d.status === "in_review").length;

  const columns: Column<Row>[] = [
    {
      key: "name",
      header: "Roadmap",
      // The name in full: it wraps rather than being cut.
      wrap: true,
      cell: (r) => (
        <Link href={`/documents/${r.d.slug}`} data-testid="roadmap-name" className={`${TAP} font-semibold hover:underline`}>
          {docLabel({ title: r.d.title, kind: "roadmap" })}
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
      // The template by name alone (the theme is in the inspector).
      cell: (r) => (
        <span className="text-sm text-text2" data-testid="roadmap-template">
          {names.template(r.d.template) ?? "—"}
        </span>
      ),
    },
    {
      key: "state",
      header: "State",
      width: "128px",
      cell: (r) => (
        <span className="flex flex-col gap-0.5">
          <span className="flex items-center gap-2">
            <StatusChip status={r.d.status} />
            {r.d.latest_version != null && (
              <Link
                href={versionHref(r.d.slug, "roadmap", r.d.latest_version)}
                className="tnum inline-block min-h-6 min-w-6 text-center leading-6 font-medium text-accent-ink hover:underline"
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
      ),
    },
    ...(can("list_share_links")
      ? [
          {
            key: "shared",
            header: "Shared",
            width: "96px",
            hideOnPhone: true,
            cell: (r: Row) => <SharedCell slug={r.d.slug} />,
          },
        ]
      : []),
    {
      key: "source",
      header: "Source PRD",
      // Narrow enough to leave the roadmap's name room beside the open panel (it wraps).
      width: "150px",
      hideOnPhone: true,
      wrap: true,
      // The header says where it came from; the cell is the PRD's name alone.
      cell: (r) =>
        r.d.source ? (
          <Link
            href={`/documents/${r.d.source.slug}/v/${r.d.source.version}`}
            data-testid="roadmap-source"
            className={`${TAP} font-medium underline-offset-2 hover:underline`}
          >
            {docLabel({ title: r.d.source.title, kind: "prd" })} v{r.d.source.version}
          </Link>
        ) : (
          <span className="text-text2">—</span>
        ),
    },
    {
      // The row's action, kept on a phone (right of the title).
      key: "action",
      header: <span className="sr-only">Action</span>,
      width: "176px",
      align: "right",
      phone: "action",
      className: "overflow-visible",
      cell: (r) => <ArtifactMenu doc={{ ...r.d, kind: "roadmap" }} />,
    },
  ];

  /** qa-plan-49: the approved PRDs' own table, under headers that fit them. */
  const prdColumns: Column<Row>[] = [
    {
      key: "name",
      header: "Approved PRD",
      wrap: true,
      cell: (r) => (
        <Link
          href={`/documents/${r.d.slug}/v/${r.d.approved_version}`}
          data-testid="roadmap-name"
          className={`${TAP} font-semibold hover:underline`}
        >
          {docLabel({ title: r.d.title, kind: "prd" })}
        </Link>
      ),
    },
    {
      key: "approved",
      header: "Approved",
      width: "150px",
      cell: (r) => <Chip kind="pass">v{r.d.approved_version} approved</Chip>,
    },
    {
      key: "built",
      header: "Roadmaps built",
      width: "150px",
      hideOnPhone: true,
      // How many; the roadmaps by name are in its inspector.
      cell: (r) => (
        <span className="tnum text-sm text-text2" data-testid="prd-built">
          {r.kind === "prd" && r.built.length > 0 ? plural(r.built.length, "roadmap") : "None yet"}
        </span>
      ),
    },
    {
      key: "action",
      header: <span className="sr-only">Action</span>,
      width: "176px",
      align: "right",
      phone: "action",
      className: "overflow-visible",
      cell: (r) => (
        <span className="flex justify-end">
          <BuildRoadmapButton prd={r.d} size="sm" />
        </span>
      ),
    },
  ];
  const roadmapRows = rows.filter((r) => r.kind === "roadmap");
  const prdRows = rows.filter((r) => r.kind === "prd");

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
          // qa-plan-12: Alignment report, Launches and Changelog are the Plan's page-wide links,
          // at the end of the tab strip on every tab; the header keeps this tab's own action.
          <LinkButton variant="primary" icon="plus" href="/documents/new?kind=roadmap">
            New roadmap
          </LinkButton>
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
          <div className="flex min-w-0 flex-col gap-3">
            <Panel title="Roadmaps" testId="roadmaps-panel">
              <DataTable<Row>
                label="Roadmaps"
                testId="roadmaps-table"
                columns={columns}
                rows={loading ? undefined : roadmapRows}
                rowKey={keyOf}
                selected={current ? keyOf(current) : null}
                onSelect={(k) => setSelected(k)}
                loading={loading}
                empty="No roadmaps yet. Build one from an approved PRD."
                rowProps={() => ({ "data-testid": "roadmap-row" })}
              />
            </Panel>
            <Panel title="Approved PRDs" testId="approved-prds-panel">
              <DataTable<Row>
                label="Approved PRDs"
                testId="approved-prds-table"
                columns={prdColumns}
                rows={loading ? undefined : prdRows}
                rowKey={keyOf}
                selected={current ? keyOf(current) : null}
                onSelect={(k) => setSelected(k)}
                loading={loading}
                empty="No approved PRDs yet. A roadmap is built from an approved PRD."
                rowProps={() => ({ "data-testid": "approved-prd" })}
              />
            </Panel>
          </div>
        </Split>
      </div>
    </Page>
  );
}
