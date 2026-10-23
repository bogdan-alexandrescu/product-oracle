"use client";

import Link from "next/link";
import { useState } from "react";

import {
  Chip,
  DataTable,
  InfoTip,
  Inspector,
  InspectorRow,
  InspectorSection,
  LinkButton,
  Notice,
  PageHeader,
  ViewOnly,
  Panel,
  Split,
  type Column,
} from "@/components/ds";
import { api, unwrap, type Schemas } from "@/lib/api/client";
import { formatDate } from "@/lib/format";
import { useMe } from "@/lib/me";
import { useQuery } from "@/lib/use-query";

type TemplateSummary = Schemas["TemplateSummary"];

const KINDS = [
  { kind: "prd", title: "PRD templates" },
  { kind: "roadmap", title: "Roadmap templates" },
] as const;

const KIND_LABEL: Record<TemplateSummary["kind"], string> = {
  prd: "PRD",
  roadmap: "Roadmap",
  vision: "Vision",
  strategy: "Product strategy",
  update: "Update",
};

const COLUMNS: Column<TemplateSummary>[] = [
  {
    key: "name",
    header: "Template",
    cell: (t) => (
      <span className="flex min-w-0 items-center gap-2">
        <Link
          href={`/settings/templates/${t.key}`}
          onClick={(e) => e.stopPropagation()}
          className={`min-w-0 truncate font-medium hover:underline ${t.archived_at ? "text-text2" : "text-text"}`}
        >
          {t.name}
        </Link>
        {t.builtin && <Chip kind="na">Built-in</Chip>}
        {t.archived_at && <Chip kind="warn">Archived</Chip>}
      </span>
    ),
  },
  {
    key: "theme",
    header: "Suggested theme",
    width: "190px",
    hideOnPhone: true,
    cell: (t) => <span className="font-mono text-sm text-text2">{t.suggested_theme ?? "—"}</span>,
  },
  { key: "latest", header: "Latest", width: "76px", align: "right", cell: (t) => <span className="tnum">v{t.latest_version}</span> },
  {
    key: "added",
    header: "Added",
    width: "120px",
    align: "right",
    hideOnPhone: true,
    cell: (t) => <span className="tnum text-text2">{formatDate(t.created_at)}</span>,
  },
];

function TemplateInspector({ t }: { t: TemplateSummary }) {
  return (
    <Inspector
      eyebrow="Template · selected"
      title={t.name}
      testId="template-inspector"
      chips={
        <>
          <Chip hero kind="acc">
            {KIND_LABEL[t.kind]}
          </Chip>
          {t.builtin && (
            <Chip hero kind="na">
              Built-in
            </Chip>
          )}
          {t.archived_at && (
            <Chip hero kind="warn">
              Archived
            </Chip>
          )}
        </>
      }
      action={
        <LinkButton variant="hero" href={`/settings/templates/${t.key}`}>
          Open
        </LinkButton>
      }
      stats={[
        { label: "Latest", value: `v${t.latest_version}` },
        { label: "Added", value: <span className="text-lg">{formatDate(t.created_at)}</span> },
      ]}
    >
      <InspectorSection label="Facts">
        <InspectorRow value={<span className="font-mono text-sm font-medium">{t.key}</span>}>Key</InspectorRow>
        <InspectorRow value={<span className="font-mono text-sm font-medium">{t.suggested_theme ?? "—"}</span>}>
          Suggested theme
        </InspectorRow>
      </InspectorSection>
      {t.description && (
        <InspectorSection label="Description">
          <p className="text-[15px] text-text">{t.description}</p>
        </InspectorSection>
      )}
      {t.suggest_when && (
        <InspectorSection label="Suggested when">
          <p className="text-[15px] text-text">{t.suggest_when}</p>
        </InspectorSection>
      )}
    </Inspector>
  );
}

export default function TemplatesPage() {
  const { can, capsReady } = useMe();
  const canCreate = can("create_template");
  const [showArchived, setShowArchived] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const q = useQuery(`templates|${showArchived}`, () =>
    unwrap(api.GET("/v1/templates", { params: { query: { include_archived: showArchived } } })),
  );

  const lists = KINDS.map(({ kind, title }) => ({
    kind,
    title,
    rows: q.data?.filter((t) => t.kind === kind).sort((a, b) => a.name.localeCompare(b.name)),
  }));
  const all = lists.flatMap((l) => l.rows ?? []);
  const current = all.find((t) => t.key === selected) ?? all[0];

  const toggle = (
    <label className="inline-flex items-center gap-2 text-sm text-text2">
      <input
        type="checkbox"
        className="size-4 accent-[var(--accent)]"
        checked={showArchived}
        onChange={(e) => setShowArchived(e.target.checked)}
      />
      Show archived
    </label>
  );

  return (
    <>
      <PageHeader
        title="Templates"
        status={
          <>
            <InfoTip label="templates" align="start" side="bottom">
              The skeletons new PRDs and roadmaps start from. Every saved change to a template is a new version; documents keep
              the version they started from.
            </InfoTip>
            {capsReady && !canCreate && <ViewOnly />}
          </>
        }
        action={
          canCreate && (
            <LinkButton variant="primary" icon="plus" href="/settings/templates/new">
              New template
            </LinkButton>
          )
        }
      />
      <Split inspector={current ? <TemplateInspector t={current} /> : undefined}>
        {q.error && <Notice tone="error">{q.error}</Notice>}
        {lists.map(({ kind, title, rows }, i) => (
          <Panel key={kind} title={title} count={rows?.length} tools={i === 0 ? toggle : undefined} testId={`templates-${kind}`}>
            <DataTable
              label={title}
              columns={COLUMNS}
              rows={rows}
              loading={q.loading}
              rowKey={(t) => t.key}
              selected={current?.key}
              onSelect={(k) => setSelected(k)}
              rowProps={(t) => ({ "data-testid": `template-row-${t.key}` })}
              empty={kind === "prd" ? "No PRD templates" : "No roadmap templates"}
            />
          </Panel>
        ))}
      </Split>
    </>
  );
}
