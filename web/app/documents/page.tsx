"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { DocStatusChip } from "@/app/documents/_components/DocStatusChip";
import { SourceLink } from "@/components/BuildRoadmap";
import {
  Chip,
  DataTable,
  InfoTip,
  Inspector,
  InspectorRow,
  InspectorSection,
  LinkButton,
  Page,
  PageHeader,
  Panel,
  SegmentedControl,
  Split,
  type Column,
} from "@/components/ds";
import { peopleByIds } from "@/components/PersonPicker";
import { ErrorNote } from "@/components/ui";
import { api, unwrap, type DocumentSummary, type Schemas } from "@/lib/api/client";
import { formatDate, formatDateTime } from "@/lib/format";
import { hasRole, useMe } from "@/lib/me";
import { useQuery } from "@/lib/use-query";

const COLUMNS: Column<DocumentSummary>[] = [
  {
    key: "title",
    header: "Document",
    cell: (d) => (
      <Link href={`/documents/${d.slug}`} className="font-medium text-text hover:underline">
        {d.title}
      </Link>
    ),
  },
  { key: "status", header: "Status", width: "128px", cell: (d) => <DocStatusChip status={d.status} dot /> },
  {
    key: "latest",
    header: "Latest",
    width: "76px",
    className: "tnum",
    cell: (d) =>
      d.latest_version != null ? (
        <Link href={`/documents/${d.slug}/v/${d.latest_version}`} className="text-accent-ink hover:underline">
          v{d.latest_version}
        </Link>
      ) : (
        "–"
      ),
  },
  {
    key: "template",
    header: "Template",
    width: "22%",
    hideOnPhone: true,
    className: "font-mono text-[13px] text-text2",
    cell: (d) => d.template ?? "–",
  },
  {
    key: "updated",
    header: "Updated",
    width: "120px",
    hideOnPhone: true,
    align: "right",
    className: "tnum text-text2",
    cell: (d) => <span title={formatDateTime(d.updated_at)}>{formatDate(d.updated_at)}</span>,
  },
];

/** A brief waiting to be drafted (C4 "Ideas"): no PRD yet, not converted or archived. */
type Idea = { intake: Schemas["ProductIntakeOut"]; author: string; open: number };

const OPEN_INTAKE = new Set<Schemas["ProductIntakeOut"]["status"]>(["draft", "analyzing", "awaiting_answers", "ready"]);

async function loadIdeas(): Promise<Idea[]> {
  const [intakes, asked, delegated] = await Promise.all([
    unwrap(api.GET("/v1/intakes", { params: { query: { limit: 500 } } })),
    unwrap(api.GET("/v1/questions", { params: { query: { status: "asked", limit: 500 } } })),
    unwrap(api.GET("/v1/questions", { params: { query: { status: "delegated", limit: 500 } } })),
  ]);
  const ideas = intakes.filter((i) => OPEN_INTAKE.has(i.status) && !i.document_id);
  const people = await peopleByIds(ideas.map((i) => i.author_id)).catch(() => new Map());
  const open = new Map<string, number>();
  for (const q of [...asked, ...delegated]) if (q.intake_id) open.set(q.intake_id, (open.get(q.intake_id) ?? 0) + 1);
  return ideas
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .map((intake) => ({ intake, author: (intake.author_id && people.get(intake.author_id)?.name) || "Someone", open: open.get(intake.id) ?? 0 }));
}

const IDEA_COLUMNS: Column<Idea>[] = [
  {
    key: "title",
    header: "Idea",
    cell: (d) => (
      <Link href={`/intakes/${d.intake.id}`} className="font-medium text-text hover:underline">
        {d.intake.title}
      </Link>
    ),
  },
  { key: "author", header: "Author", width: "160px", hideOnPhone: true, className: "text-text2", cell: (d) => d.author },
  {
    key: "questions",
    header: "Questions",
    width: "150px",
    cell: (d) =>
      d.open > 0 ? <Chip kind="warn">{`${d.open} question${d.open === 1 ? "" : "s"} open`}</Chip> : <Chip kind="pass">Ready to draft</Chip>,
  },
  {
    key: "created",
    header: "Created",
    width: "120px",
    hideOnPhone: true,
    align: "right",
    className: "tnum text-text2",
    cell: (d) => <span title={formatDateTime(d.intake.created_at)}>{formatDate(d.intake.created_at)}</span>,
  },
];

function DocInspector({ d, canPublish }: { d: DocumentSummary; canPublish: boolean }) {
  return (
    <Inspector
      testId="document-inspector"
      label={`${d.title} details`}
      eyebrow="PRD · selected"
      title={d.title}
      chips={
        <>
          {d.latest_version != null && <Chip hero>v{d.latest_version}</Chip>}
          <DocStatusChip status={d.status} hero />
        </>
      }
      action={
        <LinkButton variant="hero" href={`/documents/${d.slug}`}>
          Open
        </LinkButton>
      }
      stats={[
        { label: "Latest", value: d.latest_version != null ? `v${d.latest_version}` : "–" },
        { label: "Approved", value: d.approved_version != null ? `v${d.approved_version}` : "–" },
      ]}
    >
      <InspectorSection label="Details">
        <InspectorRow value={<span className="font-mono text-[13px] font-medium">{d.template ?? "–"}</span>}>Template</InspectorRow>
        <InspectorRow value={<span className="font-mono text-[13px] font-medium">{d.theme ?? "–"}</span>}>Theme</InspectorRow>
        <InspectorRow value={formatDate(d.created_at)}>Created</InspectorRow>
        <InspectorRow value={formatDateTime(d.updated_at)}>Updated</InspectorRow>
      </InspectorSection>
      {d.source && (
        <InspectorSection label="Source">
          <SourceLink source={d.source} />
        </InspectorSection>
      )}
      {d.latest_version != null && (
        <InspectorSection>
          <div className="flex flex-wrap gap-2">
            <LinkButton href={`/documents/${d.slug}/v/${d.latest_version}`} variant="solid">
              Read v{d.latest_version}
            </LinkButton>
            {d.latest_version > 1 && (
              <LinkButton href={`/documents/${d.slug}/diff?from=${d.latest_version - 1}&to=${d.latest_version}`}>
                Changes
              </LinkButton>
            )}
            <LinkButton href={`/documents/${d.slug}/publish`} icon="check">
              {canPublish && d.approved_version !== d.latest_version ? "Publish" : "Check readiness"}
            </LinkButton>
          </div>
        </InspectorSection>
      )}
    </Inspector>
  );
}

export default function DocumentsPage() {
  // PRDs only: roadmaps have their own screen (/roadmap).
  const q = useQuery("documents|prd", () => unwrap(api.GET("/v1/documents", { params: { query: { kind: "prd" } } })));
  const documents = [...(q.data ?? [])].sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  const router = useRouter();
  const { role } = useMe();
  const [picked, setPicked] = useState<string | null>(null);
  const selected = documents.find((d) => d.slug === picked) ?? documents[0] ?? null;
  const inReview = documents.filter((d) => d.status === "in_review").length;
  // C4: briefs waiting to be drafted, so an approver finds the one a commenter wrote.
  const ideasQ = useQuery("documents|ideas", loadIdeas);
  const [view, setView] = useState<"prds" | "ideas">("prds");

  return (
    <Page>
      <PageHeader
        title="PRDs"
        status={
          q.data && (
            <>
              <Chip kind="acc">{documents.length} PRDs</Chip>
              {inReview > 0 && <Chip kind="line">{inReview} in review</Chip>}
            </>
          )
        }
        action={
          <LinkButton href="/documents/new?kind=prd" variant="primary" icon="plus">
            New PRD
          </LinkButton>
        }
      />
      {q.error && <ErrorNote>{q.error}</ErrorNote>}
      <div className="mb-3">
        <SegmentedControl
          label="Show"
          size="sm"
          value={view}
          onChange={setView}
          items={[
            { value: "prds", label: "PRDs", count: q.data ? documents.length : null },
            { value: "ideas", label: "Ideas", count: ideasQ.data?.length ?? 0, title: "Briefs waiting to be drafted" },
          ]}
        />
      </div>
      {view === "ideas" ? (
        <Panel title="Ideas" count={ideasQ.data?.length}>
          {ideasQ.error && <ErrorNote>{ideasQ.error}</ErrorNote>}
          <DataTable
            label="Ideas"
            testId="ideas-table"
            columns={IDEA_COLUMNS}
            rows={ideasQ.data}
            loading={ideasQ.loading}
            rowKey={(d) => d.intake.id}
            onActivate={(k) => router.push(`/intakes/${k}`)}
            empty="No ideas waiting to be drafted"
            rowProps={() => ({ "data-testid": "idea-row" })}
          />
        </Panel>
      ) : (
      <Split inspector={selected ? <DocInspector d={selected} canPublish={hasRole(role, "approver")} /> : undefined}>
        <Panel
          title="PRDs"
          count={q.data ? documents.length : undefined}
          tools={
            <InfoTip label="PRDs">
              Roadmaps live under Roadmap. Import a draft with <code>POST /v1/documents/&#123;doc&#125;/versions</code> or{" "}
              <code>oracle push draft.md</code>.
            </InfoTip>
          }
        >
          <DataTable
            label="PRDs"
            testId="documents-table"
            columns={COLUMNS}
            rows={q.data ? documents : undefined}
            loading={q.loading}
            rowKey={(d) => d.slug}
            selected={selected?.slug ?? null}
            onSelect={(k) => setPicked(k)}
            onActivate={(k) => router.push(`/documents/${k}`)}
            empty="No PRDs yet"
            rowProps={() => ({ "data-testid": "document-row" })}
          />
        </Panel>
      </Split>
      )}
    </Page>
  );
}
