"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { DocStatusChip } from "@/app/documents/_components/DocStatusChip";
import { BuildRoadmapButton, SourceLink } from "@/components/BuildRoadmap";
import { DocToolbar } from "@/components/DocToolbar";
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
import { JobsPanel } from "@/components/JobsPanel";
import { ErrorNote, Loading } from "@/components/ui";
import { api, unwrap, type VersionSummary } from "@/lib/api/client";
import { formatDate, formatDateTime } from "@/lib/format";
import { useQuery } from "@/lib/use-query";

/** A template or theme key beside the title: small mono, hairline pill. */
const META = "inline-flex h-[26px] items-center rounded-full border border-line-strong px-2.5 font-mono text-[13px] text-text2";

function versionColumns(doc: string, latest: number | null | undefined): Column<VersionSummary>[] {
  return [
    {
      key: "number",
      header: "Version",
      width: "120px",
      cell: (v) => (
        <Link href={`/documents/${doc}/v/${v.number}`} className="font-medium text-text hover:underline">
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

function VersionInspector({ doc, v, latest }: { doc: string; v: VersionSummary; latest: number | null | undefined }) {
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
        <LinkButton variant="hero" href={`/documents/${doc}/v/${v.number}`}>
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
        {v.imported_by && <InspectorRow value={v.imported_by}>By</InspectorRow>}
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
    </Inspector>
  );
}

export function DocumentOverview({ doc }: { doc: string }) {
  const router = useRouter();
  const q = useQuery(`doc|${doc}`, () => unwrap(api.GET("/v1/documents/{doc}", { params: { path: { doc } } })));
  const d = q.data;
  const versions = [...(d?.versions ?? [])].reverse();
  const [picked, setPicked] = useState<number | null>(null);
  const selected = versions.find((v) => v.number === picked) ?? versions[0] ?? null;
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
                  {d.latest_version != null && (
                    <LinkButton variant="primary" href={`/documents/${doc}/v/${d.latest_version}`}>
                      Open latest (v{d.latest_version})
                    </LinkButton>
                  )}
                </>
              }
            />
            <Split inspector={selected ? <VersionInspector doc={doc} v={selected} latest={d.latest_version} /> : undefined}>
              <Panel title="Versions" count={versions.length}>
                <DataTable
                  label="Versions"
                  testId="versions-table"
                  columns={versionColumns(doc, d.latest_version)}
                  rows={versions}
                  rowKey={(v) => String(v.number)}
                  selected={selected ? String(selected.number) : null}
                  onSelect={(k) => setPicked(Number(k))}
                  onActivate={(k) => router.push(`/documents/${doc}/v/${k}`)}
                  empty="No versions yet"
                />
              </Panel>
              <Panel title="Jobs" bodyClassName="p-4">
                <JobsPanel doc={doc} />
              </Panel>
            </Split>
          </>
        )}
      </Page>
    </div>
  );
}
