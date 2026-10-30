"use client";

import { RoleBadge } from "@/components/RoleBadge";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState, useSyncExternalStore } from "react";

import { DocStatusChip } from "@/app/documents/_components/DocStatusChip";
import { ArtifactMenu } from "@/components/ArtifactMenu";
import { SourceLink } from "@/components/BuildRoadmap";
import {
  Button,
  Chip,
  DataTable,
  FilterChips,
  Icon,
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
import { formatDate, formatDateTime, plural } from "@/lib/format";
import { docLabel } from "@/lib/labels";
import { useArtifactsChanged } from "@/lib/artifacts";
import { useMe } from "@/lib/me";
import { NAMES_FAILED, useTemplateNames, type TemplateNames } from "@/lib/template-names";
import { useQuery } from "@/lib/use-query";

/** The one empty marker on this page (qa-docs-42). */
const NONE = "–";
/** A PRD with no template or theme says so in words, not a bare dash (qa-docs-33). */
const NO_TEMPLATE = "No template";
const NO_THEME = "No theme";

type SortKey = "title" | "status" | "latest" | "updated";
type Sort = { key: SortKey; desc: boolean };

const STATUS_ORDER: Record<DocumentSummary["status"], number> = { draft: 0, in_review: 1, approved: 2 };

/** qa-docs-41: the columns sort, each by what it shows. */
function sortDocs(docs: DocumentSummary[], { key, desc }: Sort): DocumentSummary[] {
  const by = (a: DocumentSummary, b: DocumentSummary): number => {
    if (key === "title") return a.title.localeCompare(b.title);
    if (key === "status") return STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
    if (key === "latest") return (a.latest_version ?? 0) - (b.latest_version ?? 0);
    return a.updated_at.localeCompare(b.updated_at);
  };
  return [...docs].sort((a, b) => (desc ? -by(a, b) : by(a, b)) || b.updated_at.localeCompare(a.updated_at));
}

/** Each column's order in words, low to high then high to low (qa-docs-41). */
const SORT_WORDS: Record<SortKey, [string, string]> = {
  title: ["A to Z", "Z to A"],
  status: ["drafts first", "approved first"],
  latest: ["fewest versions first", "most versions first"],
  updated: ["oldest first", "newest first"],
};

/** The sort menu's choices, by column then order (qa-docs-20: a phone has no column headers). */
const SORT_LABEL: Record<SortKey, string> = { title: "Document", status: "Status", latest: "Latest", updated: "Updated" };
const SORT_CHOICES = (Object.keys(SORT_WORDS) as SortKey[]).flatMap((k) =>
  [false, true].map((desc) => ({ value: `${k}:${desc ? "desc" : "asc"}`, label: `${SORT_LABEL[k]}, ${SORT_WORDS[k][desc ? 1 : 0]}` })),
);

/** A phone's sort: a menu above the list, as the column headers are for screen readers only there. */
function SortMenu({ sort, onSort }: { sort: Sort; onSort: (s: Sort) => void }) {
  return (
    <label className="flex min-w-0 items-center gap-2 text-sm font-medium text-text2 min-[601px]:hidden">
      Sort
      <select
        data-testid="sort-menu"
        className="h-11 min-w-0 rounded-lg border border-line-strong bg-surface px-2.5 text-[15px] text-text"
        value={`${sort.key}:${sort.desc ? "desc" : "asc"}`}
        onChange={(e) => {
          const [key, order] = e.target.value.split(":") as [SortKey, string];
          onSort({ key, desc: order === "desc" });
        }}
      >
        {SORT_CHOICES.map((c) => (
          <option key={c.value} value={c.value}>
            {c.label}
          </option>
        ))}
      </select>
    </label>
  );
}

/** A sortable column's aria-sort: ascending, descending or none. */
const ariaSort = (k: SortKey, sort: Sort): "ascending" | "descending" | "none" => (sort.key !== k ? "none" : sort.desc ? "descending" : "ascending");

/** A column header that sorts its column: a second click reverses it. */
function SortHeader({ label, k, sort, onSort }: { label: string; k: SortKey; sort: Sort; onSort: (s: Sort) => void }) {
  const on = sort.key === k;
  const hint = on ? `, ${SORT_WORDS[k][sort.desc ? 1 : 0]}` : "";
  return (
    <>
      <span className="hidden max-[600px]:inline">{label}</span>
      <button
        type="button"
        data-testid={`sort-${k}`}
        aria-label={`Sort by ${label}${hint}`}
        title={on ? `Sorted ${SORT_WORDS[k][sort.desc ? 1 : 0]}` : `Sort by ${label}`}
        onClick={() => onSort({ key: k, desc: on ? !sort.desc : k === "updated" || k === "latest" })}
        // qa-docs-20: a 24 px tall target at the least, not the 16 px line of text.
        // qa-docs-34: a phone sorts from the menu above the list, so the header button is not
        // drawn there at all (only the column's name stays, for screen readers).
        className={`inline-flex min-h-6 items-center gap-1 rounded hover:text-text max-[600px]:hidden ${on ? "text-text" : ""}`}
      >
        {label}
        {on && <Icon name={sort.desc ? "chevron-down" : "chevron-up"} size={16} />}
      </button>
    </>
  );
}

function docColumns(sort: Sort, onSort: (s: Sort) => void, names: TemplateNames): Column<DocumentSummary>[] {
  return [
    {
      key: "title",
      header: <SortHeader label="Document" k="title" sort={sort} onSort={onSort} />,
      ariaSort: ariaSort("title", sort),
      cell: (d) => (
        <Link href={`/documents/${d.slug}`} className="font-medium text-text hover:underline" title={docLabel({ ...d, kind: "prd" })}>
          {d.title}
        </Link>
      ),
    },
    {
      key: "status",
      header: <SortHeader label="Status" k="status" sort={sort} onSort={onSort} />,
      ariaSort: ariaSort("status", sort),
      width: "128px",
      cell: (d) => <DocStatusChip status={d.status} dot />,
    },
    {
      key: "latest",
      header: <SortHeader label="Latest" k="latest" sort={sort} onSort={onSort} />,
      ariaSort: ariaSort("latest", sort),
      width: "84px",
      className: "tnum",
      cell: (d) =>
        d.latest_version != null ? (
          <Link href={`/documents/${d.slug}/v/${d.latest_version}`} className="text-accent-ink hover:underline">
            v{d.latest_version}
          </Link>
        ) : (
          NONE
        ),
    },
    {
      key: "template",
      header: "Template",
      width: "22%",
      hideOnPhone: true,
      className: "text-text2",
      cell: (d) => {
        const name = names.template(d.template);
        return name ? <span title={name}>{name}</span> : <span data-testid="no-template">{NO_TEMPLATE}</span>;
      },
    },
    {
      key: "updated",
      header: <SortHeader label="Updated" k="updated" sort={sort} onSort={onSort} />,
      ariaSort: ariaSort("updated", sort),
      width: "120px",
      hideOnPhone: true,
      align: "right",
      className: "tnum text-text2",
      cell: (d) => <span title={formatDateTime(d.updated_at)}>{formatDate(d.updated_at)}</span>,
    },
    {
      // #482: Open v<n>, Regenerate… and Delete… by role; kept on a phone (right of the title).
      key: "actions",
      header: <span className="sr-only">Actions</span>,
      width: "56px",
      align: "right",
      phone: "action",
      className: "overflow-visible",
      // qa-docs-32: the row's title opens the PRD and its Latest opens the latest version, so
      // the menu repeats no Open.
      cell: (d) => <ArtifactMenu doc={{ ...d, kind: "prd" }} openItem={false} />,
    },
  ];
}

/** Phone width (the DataTable's stacked rows): a tapped row opens its PRD, as there is no room for a panel beside it. */
const PHONE = "(max-width: 600px)";

function subscribePhone(onChange: () => void) {
  const mq = window.matchMedia(PHONE);
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}

function useIsPhone(): boolean {
  return useSyncExternalStore(subscribePhone, () => window.matchMedia(PHONE).matches, () => false);
}

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
      d.open > 0 ? <Chip kind="warn">{`${plural(d.open, "question")} open`}</Chip> : <Chip kind="pass">Ready to draft</Chip>,
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

/** The approved version in words: "v5, the latest", "v3", or "Not approved". */
function approvedText(d: DocumentSummary): string {
  if (d.approved_version == null) return "Not approved";
  return d.approved_version === d.latest_version ? `v${d.approved_version}, the latest` : `v${d.approved_version}`;
}

function DocInspector({ d, canPublish, names }: { d: DocumentSummary; canPublish: boolean; names: TemplateNames }) {
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
    >
      <InspectorSection label="Details">
        <InspectorRow value={d.latest_version != null ? `v${d.latest_version}` : NONE}>Latest version</InspectorRow>
        <InspectorRow value={<span data-testid="inspector-approved">{approvedText(d)}</span>}>Approved version</InspectorRow>
        <InspectorRow value={<span data-testid="inspector-template">{names.template(d.template) ?? NO_TEMPLATE}</span>}>Template</InspectorRow>
        <InspectorRow value={<span data-testid="inspector-theme">{names.theme(d.theme) ?? NO_THEME}</span>}>Theme</InspectorRow>
        <InspectorRow value={<span data-testid="inspector-created" title={formatDateTime(d.created_at)}>{formatDate(d.created_at)}</span>}>
          Created
        </InspectorRow>
        {/* qa-docs-34: the table's one date format (the time on hover), in the Company time zone. */}
        <InspectorRow value={<span data-testid="inspector-updated" title={formatDateTime(d.updated_at)}>{formatDate(d.updated_at)}</span>}>
          Updated
        </InspectorRow>
      </InspectorSection>
      {d.source && (
        <InspectorSection label="Source">
          <SourceLink source={d.source} />
        </InspectorSection>
      )}
      {d.latest_version != null && (
        <InspectorSection>
          <div className="flex flex-wrap gap-2">
            {/* qa-docs-32: the head's Open opens the PRD; this one says it reads the latest version. */}
            <LinkButton href={`/documents/${d.slug}/v/${d.latest_version}`} variant="solid">
              Read latest (v{d.latest_version})
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
  // PRDs only: roadmaps have their own screen (Plan).
  const q = useQuery("documents|prd", () => unwrap(api.GET("/v1/documents", { params: { query: { kind: "prd" } } })));
  useArtifactsChanged(q.reload);
  const router = useRouter();
  const phone = useIsPhone();
  const names = useTemplateNames();
  const { can, capsReady } = useMe();
  // #370: New PRD creates an intake not linked to a PRD (the handler only asks an approver to
  // link one), so the item lets a commenter in, as in NewPrd.
  const canPropose = can("create_intake", true);
  const [sort, setSort] = useState<Sort>({ key: "updated", desc: true });
  // qa-docs-41: In review filters the list.
  const [filter, setFilter] = useState<"all" | "in_review">("all");
  const all = q.data ?? [];
  const inReview = all.filter((d) => d.status === "in_review").length;
  const documents = sortDocs(filter === "in_review" ? all.filter((d) => d.status === "in_review") : all, sort);
  const [picked, setPicked] = useState<string | null>(null);
  const selected = documents.find((d) => d.slug === picked) ?? documents[0] ?? null;
  // C4: briefs waiting to be drafted, so an approver finds the one a commenter wrote.
  const ideasQ = useQuery("documents|ideas", loadIdeas);
  const [view, setView] = useState<"prds" | "ideas">("prds");
  const ideaCount = ideasQ.data?.length ?? 0;
  const columns = docColumns(sort, setSort, names);
  // On a phone a tapped row opens its PRD, but the arrow keys (Home, End, Space) only move
  // the selection: the keydown that selects is caught before the row's own handler.
  const byKey = useRef(false);

  return (
    <Page>
      <PageHeader
        title="PRDs"
        info={
          <InfoTip label="PRDs">
            Every PRD and the briefs (Ideas) waiting to become one. Roadmaps live under Plan. Open a PRD to read its
            versions, review it and publish it.
          </InfoTip>
        }
        status={capsReady ? <RoleBadge /> : undefined}
        action={
          // #370: a commenter writes the brief, an approver drafts; a viewer has no New PRD.
          canPropose && (
            <LinkButton href="/documents/new?kind=prd" variant="primary" icon="plus">
              New PRD
            </LinkButton>
          )
        }
      />
      {q.error && <ErrorNote>{q.error}</ErrorNote>}
      {names.failed && (
        <p data-testid="template-names-failed" role="status" className="mb-3 text-[13px] text-text2">
          {NAMES_FAILED}
        </p>
      )}
      <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-2">
        <SegmentedControl
          label="Show"
          size="sm"
          value={view}
          onChange={setView}
          items={[
            { value: "prds", label: "PRDs", count: q.data ? all.length : null },
            { value: "ideas", label: "Ideas", count: ideasQ.data?.length ?? null, title: "Briefs waiting to be drafted" },
          ]}
        />
        {view === "prds" && inReview > 0 && (
          <FilterChips
            label="Filter PRDs"
            testId="prd-filter"
            value={filter}
            onChange={setFilter}
            items={[
              { value: "all", label: "All" },
              { value: "in_review", label: "In review", count: inReview },
            ]}
          />
        )}
        {view === "prds" && all.length > 1 && <SortMenu sort={sort} onSort={setSort} />}
      </div>
      {view === "ideas" ? (
        <Panel>
          {ideasQ.error && <ErrorNote>{ideasQ.error}</ErrorNote>}
          <DataTable
            label="Ideas"
            testId="ideas-table"
            columns={IDEA_COLUMNS}
            rows={ideasQ.data}
            loading={ideasQ.loading}
            rowKey={(d) => d.intake.id}
            onActivate={(k) => router.push(`/intakes/${k}`)}
            empty={
              // qa-docs-44: where ideas come from, and the way to start one.
              <span data-testid="ideas-empty" className="inline-block max-w-prose whitespace-normal">
                No ideas waiting. An idea is a brief for a PRD: write one with{" "}
                {canPropose ? (
                  <Link href="/documents/new?kind=prd" className="font-medium text-accent-ink hover:underline">
                    New PRD
                  </Link>
                ) : (
                  "New PRD"
                )}
                , or turn a customer request into one from{" "}
                <Link href="/requests" className="font-medium text-accent-ink hover:underline">
                  Requests
                </Link>
                .
              </span>
            }
            rowProps={() => ({ "data-testid": "idea-row" })}
          />
        </Panel>
      ) : (
        <Split
          // qa-docs-16: on a phone a tapped row opens its PRD, so no panel waits below the list.
          inspector={selected && !phone ? <DocInspector d={selected} canPublish={can("publish_version")} names={names} /> : undefined}
        >
          <Panel>
            <div
              onKeyDownCapture={(e) => {
                byKey.current = ["ArrowUp", "ArrowDown", "Home", "End", " "].includes(e.key);
              }}
              onPointerDownCapture={() => {
                byKey.current = false;
              }}
            >
              <DataTable
                label="PRDs"
                testId="documents-table"
                columns={columns}
                rows={q.data ? documents : undefined}
                loading={q.loading}
                rowKey={(d) => d.slug}
                selected={phone ? picked : (selected?.slug ?? null)}
                onSelect={(k) => {
                  const moved = byKey.current;
                  byKey.current = false;
                  if (phone && !moved) router.push(`/documents/${k}`);
                  else setPicked(k);
                }}
                onActivate={(k) => router.push(`/documents/${k}`)}
                empty={
                  filter === "in_review" ? (
                    "No PRDs in review"
                  ) : ideaCount > 0 ? (
                    // qa-onboarding-15: a first brief waits under Ideas, not here: say so and open it.
                    <span data-testid="prds-empty-ideas" className="inline-flex flex-wrap items-center justify-center gap-x-3 gap-y-2 whitespace-normal">
                      <span>
                        No PRDs yet. {plural(ideaCount, "brief")} {ideaCount === 1 ? "waits" : "wait"} in Ideas.
                      </span>
                      <Button onClick={() => setView("ideas")}>Open Ideas</Button>
                    </span>
                  ) : (
                    // qa-shell-9: the next step, only for someone who can take it.
                    <span data-testid="prds-empty" className="inline-block max-w-prose whitespace-normal">
                      {canPropose ? "No PRDs yet. Start one with New PRD." : "No PRDs yet. They appear here once someone starts one."}
                    </span>
                  )
                }
                rowProps={() => ({ "data-testid": "document-row" })}
              />
            </div>
          </Panel>
        </Split>
      )}
    </Page>
  );
}
