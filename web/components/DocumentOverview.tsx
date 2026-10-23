"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { DocStatusChip } from "@/app/documents/_components/DocStatusChip";
import { BuildRoadmapButton, SourceLink } from "@/components/BuildRoadmap";
import { DocToolbar } from "@/components/DocToolbar";
import { DraftWithOracleButton, isTemplateOnly } from "@/components/DraftWithOracle";
import {
  Chip,
  DataTable,
  Inspector,
  InspectorRow,
  InspectorSection,
  LinkButton,
  Page,
  PageHeader,
  Panel,
  Split,
  type Column,
} from "@/components/ds";
import { ORACLE_WORK } from "@/components/JobsPanel";
import { Campaigns, ReviewSettingsButton, SectionAssignments } from "@/components/ReviewSetup";
import { FRESHNESS, sizeText } from "@/components/tech-brief";
import { ErrorNote, Loading } from "@/components/ui";
import { api, unwrap, type VersionSummary } from "@/lib/api/client";
import { formatDate, formatDateTime } from "@/lib/format";
import { useMe } from "@/lib/me";
import { useScreenSubject } from "@/lib/screen-subject";
import { useQuery } from "@/lib/use-query";
import { versionHref } from "@/lib/version-href";

/** A template or theme key beside the title: small mono, hairline pill. */
const META = "inline-flex h-[26px] items-center rounded-full border border-line-strong px-2.5 font-mono text-[13px] text-text2";

function versionColumns(doc: string, kind: string | null | undefined, latest: number | null | undefined): Column<VersionSummary>[] {
  return [
    {
      key: "number",
      header: "Version",
      width: "120px",
      cell: (v) => (
        <Link href={versionHref(doc, kind, v.number)} className="font-medium text-text hover:underline">
          Version {v.number}
        </Link>
      ),
    },
    {
      key: "state",
      header: "State",
      cell: (v) => (
        <span className="inline-flex items-center gap-1.5">
          {v.approved_at ? (
            <Chip kind="pass" dot>
              Approved
            </Chip>
          ) : v.number === latest ? (
            <Chip kind="now">Latest</Chip>
          ) : null}
          {v.warnings.length > 0 && (
            <Chip kind="warn" title={v.warnings.map((w) => w.message).join("\n")}>
              {v.warnings.length} warning{v.warnings.length > 1 ? "s" : ""}
            </Chip>
          )}
        </span>
      ),
    },
    {
      key: "created",
      header: "Imported",
      width: "176px",
      hideOnPhone: true,
      className: "tnum text-text2",
      cell: (v) => formatDateTime(v.created_at),
    },
    {
      key: "diff",
      header: "Changes",
      width: "128px",
      align: "right",
      phone: "action",
      cell: (v) =>
        v.number > 1 ? (
          <Link href={`/documents/${doc}/diff?from=${v.number - 1}&to=${v.number}`} className="text-accent-ink hover:underline">
            Diff from v{v.number - 1}
          </Link>
        ) : (
          <span className="text-text2">–</span>
        ),
    },
  ];
}

function VersionInspector({
  doc,
  kind,
  v,
  latest,
}: {
  doc: string;
  kind: string | null | undefined;
  v: VersionSummary;
  latest: number | null | undefined;
}) {
  const { can } = useMe();
  return (
    <Inspector
      testId="version-inspector"
      label={`v${v.number} details`}
      eyebrow="Version · selected"
      title={`v${v.number}`}
      chips={
        <>
          {v.approved_at && <Chip hero>Approved</Chip>}
          {v.number === latest && <Chip kind="now" hero>Latest</Chip>}
        </>
      }
      action={
        <LinkButton variant="hero" href={versionHref(doc, kind, v.number)}>
          Open
        </LinkButton>
      }
      stats={[
        { label: "Warnings", value: v.warnings.length, tone: v.warnings.length ? "warn" : undefined },
        { label: "Approved", value: v.approved_at ? "Yes" : "No" },
      ]}
    >
      <InspectorSection label="Details">
        <InspectorRow value={formatDateTime(v.created_at)}>Imported</InspectorRow>
        {v.imported_by_name && (
          <InspectorRow
            value={
              <span data-testid="version-importer" title={v.imported_by ?? undefined}>
                {v.imported_by_name}
              </span>
            }
          >
            By
          </InspectorRow>
        )}
        {v.approved_at && <InspectorRow value={formatDate(v.approved_at)}>Approved</InspectorRow>}
        <InspectorRow value={<span className="font-mono text-[13px] font-medium">{v.content_hash.slice(0, 8)}</span>}>Hash</InspectorRow>
      </InspectorSection>
      {v.source && (
        <InspectorSection label="Source">
          <SourceLink source={v.source} />
        </InspectorSection>
      )}
      {v.warnings.length > 0 && (
        <InspectorSection label="Warnings">
          <ul className="flex flex-col gap-2">
            {v.warnings.map((w, i) => (
              <li key={i} className="rounded-button bg-warn-bg px-3 py-2 text-sm text-warn">
                {w.message}
              </li>
            ))}
          </ul>
        </InspectorSection>
      )}
      {/* #370: Oracle's work is where its jobs are run (POST /v1/documents/{doc}/llm-jobs). */}
      {can("create_llm_job") && (
        <InspectorSection>
          <Link href={`/documents/${doc}/v/${v.number}?tab=history#${ORACLE_WORK}`} className="text-sm font-medium text-accent-ink hover:underline">
            Oracle&apos;s work on v{v.number}
          </Link>
        </InspectorSection>
      )}
    </Inspector>
  );
}

/** The PRD's tech briefs, one per feature (F5-1), each opening its brief page. Hidden until there is one; a failed load shows its error. */
function TechBriefs({ doc }: { doc: string }) {
  const q = useQuery(`tech-briefs|${doc}`, () => unwrap(api.GET("/v1/tech-briefs", { params: { query: { prd: doc } } })));
  const briefs = q.data ?? [];
  if (q.error) {
    return (
      <Panel title="Tech briefs" testId="tech-briefs" bodyClassName="p-4">
        <ErrorNote>{q.error}</ErrorNote>
      </Panel>
    );
  }
  if (briefs.length === 0) return null;
  return (
    <Panel title="Tech briefs" count={briefs.length} testId="tech-briefs">
      <ul className="divide-y divide-line">
        {briefs.map((b) => (
          <li key={b.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5">
            <Link href={`/briefs/${b.id}`} className="min-w-0 font-semibold break-words text-accent-ink hover:underline">
              {b.feature.title}
            </Link>
            <span className="text-sm text-text2">{sizeText(b.size)}</span>
            <span className="flex-1" />
            <Chip kind={FRESHNESS[b.freshness].kind} dot>
              {FRESHNESS[b.freshness].label}
            </Chip>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

export function DocumentOverview({ doc }: { doc: string }) {
  const router = useRouter();
  const q = useQuery(`doc|${doc}`, () => unwrap(api.GET("/v1/documents/{doc}", { params: { path: { doc } } })));
  const d = q.data;
  const versions = [...(d?.versions ?? [])].reverse();
  const [picked, setPicked] = useState<number | null>(null);
  const selected = versions.find((v) => v.number === picked) ?? versions[0] ?? null;
  // Review setup (#342): each section of the latest version, its owner, reviewers and due date.
  const latest = d?.latest_version ?? null;
  const statesQ = useQuery(`section-states|${doc}|${latest}`, () =>
    latest == null
      ? Promise.resolve(null)
      : unwrap(api.GET("/v1/documents/{doc}/versions/{n}/section-states", { params: { path: { doc, n: latest } } })),
  );
  const states = statesQ.data?.sections ?? [];
  const templateOnly = isTemplateOnly(d?.kind, d?.versions ?? []);
  // G7 3.3: the panel is about this document (its latest version).
  useScreenSubject(d && versions[0] ? { kind: "document", subject: { document_id: d.id, version: versions[0].number } } : null, d?.title);
  return (
    <div>
      <DocToolbar doc={d} />
      <Page>
        {q.error && <ErrorNote>{q.error}</ErrorNote>}
        {!d && !q.error && <Loading />}
        {d && (
          <>
            <PageHeader
              title={d.title}
              suffix={d.latest_version != null ? `v${d.latest_version}` : undefined}
              status={
                <>
                  <DocStatusChip status={d.status} />
                  {d.template && (
                    <span className={META}>
                      template {d.template}
                      {d.template_version ? ` v${d.template_version}` : ""}
                    </span>
                  )}
                  {d.theme && (
                    <span className={META}>theme {d.theme}</span>
                  )}
                  {d.source && (
                    <span className="text-sm text-text2">
                      <SourceLink source={d.source} />
                    </span>
                  )}
                </>
              }
              action={
                <>
                  {d.kind === "prd" && <BuildRoadmapButton prd={d} />}
                  {statesQ.data && <ReviewSettingsButton doc={doc} sections={states} onSaved={statesQ.reload} />}
                  {templateOnly && <DraftWithOracleButton slug={d.slug} />}
                  {d.latest_version != null && (
                    <LinkButton variant={templateOnly ? "secondary" : "primary"} href={versionHref(doc, d.kind, d.latest_version)}>
                      Open latest (v{d.latest_version})
                    </LinkButton>
                  )}
                </>
              }
            />
            <Split inspector={selected ? <VersionInspector doc={doc} kind={d.kind} v={selected} latest={d.latest_version} /> : undefined}>
              <Panel title="Versions" count={versions.length}>
                <DataTable
                  label="Versions"
                  testId="versions-table"
                  columns={versionColumns(doc, d.kind, d.latest_version)}
                  rows={versions}
                  rowKey={(v) => String(v.number)}
                  selected={selected ? String(selected.number) : null}
                  onSelect={(k) => setPicked(Number(k))}
                  onActivate={(k) => router.push(versionHref(doc, d.kind, k))}
                  empty="No versions yet"
                />
              </Panel>
              {d.kind === "prd" && <TechBriefs doc={doc} />}
              {statesQ.error && <ErrorNote>{statesQ.error}</ErrorNote>}
              {statesQ.data && <SectionAssignments doc={doc} states={states} onSaved={statesQ.reload} />}
              {latest != null && <Campaigns doc={doc} />}
            </Split>
          </>
        )}
      </Page>
    </div>
  );
}
