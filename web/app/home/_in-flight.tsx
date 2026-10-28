"use client";

import Link from "next/link";
import type { ReactNode } from "react";

import { DocStatusChip } from "@/app/documents/_components/DocStatusChip";
import {
  Chip,
  CodeChip,
  DataTable,
  Icon,
  Inspector,
  InspectorRow,
  InspectorSection,
  JOURNEY_STEPS,
  JourneyTrack,
  LinkButton,
  Meter,
  type Column,
} from "@/components/ds";
import { api, unwrap, type DocumentSummary, type Schemas, type VersionOut } from "@/lib/api/client";
import { plural } from "@/lib/format";
import { docLabel, runLabel } from "@/lib/labels";
import { useQuery } from "@/lib/use-query";

import {
  CHECKPOINT_LABEL,
  runStatusKind,
  runStatusLabel,
  RunCost,
  SEGMENT_STATUS_KIND,
  SEGMENT_STATUS_LABEL,
  type RunOut,
  type RunSummary,
} from "../runs/_lib";

/** A goal a row serves: its G tag, and whether the goal is still proposed. */
export type RowGoal = { id: string; tag: string; title: string; proposed: boolean };

/**
 * One line of In flight: a PRD in review, or a run in progress. Everything a line shows
 * comes from the documents and runs lists (a run's `progress`), so the table costs no call
 * per row; goal tags, blockers and segments load in the inspector, for the selected row only.
 */
export type Flight = { kind: "prd"; key: string; doc: DocumentSummary } | { kind: "run"; key: string; run: RunSummary };

/** Goal id -> the goal's tag and title, as Home's goals strip tags them. */
export type GoalIndex = Map<string, RowGoal>;

/** A PRD in review stands at the journey's Review step. */
const REVIEW_STEP = JOURNEY_STEPS.indexOf("Review") + 1;

/** What the run does next: the checkpoint it waits on, else the segment under way or next. */
function runNext(run: RunSummary): string {
  if (run.waiting_on) return CHECKPOINT_LABEL[run.waiting_on];
  if (run.status === "awaiting_approval") return "Cost approval";
  if (run.status === "paused_overrun") return "Resume or cancel";
  return run.progress?.now ?? "–";
}

/** The run's document, by slug, among the PRDs Home lists. */
const runDoc = (run: RunSummary, docs: DocumentSummary[] | undefined) =>
  run.document_slug ? docs?.find((x) => x.slug === run.document_slug) : undefined;

/** A row by its human name (qa-shell-32): the PRD's title, or the run's document and flow, never a slug or an id. */
function title(f: Flight, docs?: DocumentSummary[]) {
  return f.kind === "prd" ? docLabel(f.doc) : runLabel(f.run, runDoc(f.run, docs)?.title);
}

/** "Step 8/9": where a PRD in review stands on the journey, said as a step so it is not read as sections done. */
const STEP_TEXT = `Step ${REVIEW_STEP}/${JOURNEY_STEPS.length}`;

export function flightColumns(phoneHeader: ReactNode, docs?: DocumentSummary[]): Column<Flight>[] {
  return [
    {
      key: "name",
      header: phoneHeader,
      phone: "title",
      cell: (f) => (
        <span className="flex min-w-0 items-baseline gap-1.5">
          <span className="truncate font-medium" title={title(f, docs)}>
            {title(f, docs)}
          </span>
          {f.kind === "prd" && f.doc.latest_version != null && (
            <span className="tnum flex-none text-sm text-text2">v{f.doc.latest_version}</span>
          )}
        </span>
      ),
    },
    {
      key: "status",
      header: "Status",
      width: "180px",
      phone: "meta",
      cell: (f) =>
        f.kind === "prd" ? (
          <DocStatusChip status={f.doc.status} dot />
        ) : (
          <Chip kind={runStatusKind(f.run)} dot>
            {runStatusLabel(f.run)}
          </Chip>
        ),
    },
    {
      key: "next",
      header: "Next",
      width: "19%",
      phone: "hide",
      cell: (f) =>
        f.kind === "prd" ? (
          <Chip kind="now">Review</Chip>
        ) : (
          <span className="truncate" title={runNext(f.run)}>
            {runNext(f.run)}
          </span>
        ),
    },
    {
      key: "done",
      header: "Progress",
      width: "150px",
      phone: "meta",
      cell: (f) => {
        if (f.kind === "prd") {
          return (
            <span className="flex min-w-0 items-center gap-2" data-testid="row-journey" title={`Journey step ${REVIEW_STEP} of ${JOURNEY_STEPS.length}: Review`}>
              <JourneyTrack current={REVIEW_STEP} variant="dots" />
              <b className="tnum flex-none font-semibold whitespace-nowrap">{STEP_TEXT}</b>
            </span>
          );
        }
        const d = f.run.progress;
        // qa-company-43: a run paused over budget is not finished, whatever its segments say.
        if (f.run.status === "paused_overrun") {
          return (
            <span className="tnum font-semibold whitespace-nowrap text-crit" data-testid="row-paused" title={d ? `Paused after ${d.done} of ${plural(d.total, "segment")}` : "Paused"}>
              Paused{d ? ` at ${d.done}/${d.total}` : ""}
            </span>
          );
        }
        return d ? <Meter value={d.done} max={d.total} label="Segments done" /> : <span className="text-text2">–</span>;
      },
    },
  ];
}

const VERDICT_BAR: Record<string, string> = {
  approved: "bg-pass",
  changes_requested: "bg-warn",
  rejected: "bg-crit",
};

/** The goals a document's latest version traces to, tagged as Home tags them; loaded for the selected row only. */
function useTracedGoals(slug: string | null | undefined, n: number | null | undefined, goals: GoalIndex): RowGoal[] | undefined {
  const trace = useQuery(`home|trace|${slug}@${n}`, () =>
    !slug || n == null
      ? Promise.resolve(null)
      : unwrap(api.GET("/v1/documents/{doc}/versions/{n}/trace", { params: { path: { doc: slug, n } } })).catch(() => null),
  );
  if (trace.loading) return undefined;
  const ids = [...new Set(trace.data?.sections.flatMap((s) => s.goals.map((g) => g.id)) ?? [])];
  return ids
    .map((id) => goals.get(id))
    .filter((g): g is RowGoal => !!g)
    .sort((a, b) => a.tag.localeCompare(b.tag, undefined, { numeric: true }));
}

function GoalsSection({ goals }: { goals: RowGoal[] | undefined }) {
  if (!goals || goals.length === 0) return null;
  return (
    <InspectorSection label="Goals" testId="inspector-goals">
      <span data-testid="row-goals" className="contents">
        {goals.map((g) => (
          <InspectorRow key={g.tag}>
            <CodeChip kind="goal" entityId={g.id} title={g.title} proposed={g.proposed} />
          </InspectorRow>
        ))}
      </span>
    </InspectorSection>
  );
}

/** The selected PRD: journey, blockers, sections reviewed, open items, its sections and blockers. */
function PrdInspector({ f, openItems, goalIndex }: { f: Extract<Flight, { kind: "prd" }>; openItems: number | undefined; goalIndex: GoalIndex }) {
  const d = f.doc;
  const n = d.latest_version;
  const goals = useTracedGoals(d.slug, n, goalIndex);
  const version = useQuery(`home|version|${d.slug}|${n}`, () =>
    n == null ? Promise.resolve(null) : unwrap(api.GET("/v1/documents/{doc}/versions/{n}", { params: { path: { doc: d.slug, n } } })),
  );
  // Readiness needs a composition; without one the blockers stay unknown, never zero.
  const readiness = useQuery(`home|readiness|${d.slug}|${n}`, () =>
    n == null
      ? Promise.resolve(null)
      : unwrap(api.GET("/v1/documents/{doc}/versions/{n}/readiness", { params: { path: { doc: d.slug, n } } })).catch(() => null),
  );
  const v: VersionOut | null | undefined = version.data;
  const sections = v?.sections ?? [];
  const count = (k: string | null) => sections.filter((s) => (s.verdict?.verdict ?? null) === k).length;
  const approved = count("approved");
  const r: Schemas["ReadinessDashboard"] | null | undefined = readiness.data;
  const failing = r ? r.items.filter((i) => r.blocking.includes(i.key)) : [];
  // qa-company-45: the critical-blockers check names its blockers by id; read their statements,
  // only when the check is failing, so each line names a blocker, never the check's heading.
  const ids = failing.flatMap((i) => i.evidence_ids ?? []);
  const named = useQuery(`home|blockers|${d.id}|${ids.join(",")}`, (): Promise<Schemas["BlockerSummary"][]> =>
    ids.length === 0
      ? Promise.resolve([])
      : unwrap(api.GET("/v1/blockers", { params: { query: { document_id: d.id } } })).catch(() => []),
  );
  const statement = new Map((named.data ?? []).map((b) => [b.id, b.statement]));
  const blockers: { key: string; title: string; hard: boolean }[] = failing.flatMap((i) => {
    const each = (i.evidence_ids ?? []).flatMap((id) => (statement.has(id) ? [{ key: `${i.key}:${id}`, title: statement.get(id)!, hard: i.hard }] : []));
    return each.length > 0 ? each : [{ key: i.key, title: i.title, hard: i.hard }];
  });

  return (
    <Inspector
      testId="home-inspector"
      label={`${d.title} details`}
      eyebrow="PRD · selected"
      title={d.title}
      chips={
        <>
          {n != null && <Chip hero>v{n}</Chip>}
          <DocStatusChip status={d.status} hero />
        </>
      }
      action={
        <LinkButton variant="hero" href={`/documents/${d.slug}`}>
          Open
        </LinkButton>
      }
      stats={[
        {
          label: "Blockers",
          value: r ? r.blocking.length : "–",
          tone: r && r.blocking.length > 0 ? "crit" : undefined,
          testId: "stat-blockers",
        },
        { label: "Sections approved", value: v ? approved : "–", of: v ? sections.length : undefined, testId: "stat-sections" },
        { label: "Open items", value: openItems ?? 0, testId: "stat-open" },
      ]}
    >
      <InspectorSection testId="inspector-journey" label={`Journey: step ${REVIEW_STEP} of ${JOURNEY_STEPS.length}, ${JOURNEY_STEPS[REVIEW_STEP - 1]}`}>
        <JourneyTrack current={REVIEW_STEP} variant="bar" />
      </InspectorSection>
      {v && sections.length > 0 && (
        <InspectorSection
          label="Sections"
          testId="inspector-sections"
          tools={
            <span className="flex flex-wrap items-center gap-2.5 font-medium text-text">
              <Legend cls="bg-pass" label="Approved" n={approved} />
              <Legend cls="bg-warn" label="Changes" n={count("changes_requested") + count("rejected")} />
              <Legend cls="bg-surface2 shadow-[inset_0_0_0_1px_var(--line-strong)]" label="Open" n={count(null)} />
            </span>
          }
        >
          <div role="img" aria-label={`${approved} of ${sections.length} sections approved`} className="flex gap-1">
            {sections.map((s) => (
              <i
                key={s.section_key}
                title={`${s.heading}${s.verdict ? ` · ${s.verdict.verdict.replace("_", " ")}` : ""}`}
                className={`h-2.5 min-w-1 flex-1 rounded-[3px] ${
                  s.verdict ? VERDICT_BAR[s.verdict.verdict] : "bg-surface2 shadow-[inset_0_0_0_1px_var(--line-strong)]"
                }`}
              />
            ))}
          </div>
        </InspectorSection>
      )}
      {blockers.length > 0 && (
        <InspectorSection
          label="Blockers"
          testId="inspector-blockers"
          tools={<Chip kind="crit">{blockers.filter((b) => b.hard).length || blockers.length} critical</Chip>}
        >
          {blockers.map((b) => (
            <InspectorRow key={b.key}>
              <span className="inline-flex min-w-0 items-center gap-2.5" title={b.title} data-testid="inspector-blocker">
                <Icon name="alert" size={16} className="flex-none text-crit" />
                <span className="truncate">{b.title}</span>
              </span>
            </InspectorRow>
          ))}
        </InspectorSection>
      )}
      <GoalsSection goals={goals} />
    </Inspector>
  );
}

function Legend({ cls, label, n }: { cls: string; label: string; n: number }) {
  if (n === 0) return null;
  return (
    <span className="inline-flex items-center gap-1.5">
      <i aria-hidden className={`size-2.5 rounded-[3px] ${cls}`} />
      {label} <b className="tnum">{n}</b>
    </span>
  );
}

/** The selected run: segments done, what it waits on, its segments; cost as one small figure (P3d). */
function RunInspector({ f, docs, goalIndex }: { f: Extract<Flight, { kind: "run" }>; docs: DocumentSummary[]; goalIndex: GoalIndex }) {
  const run = f.run;
  const d = run.progress;
  // The run's segments and checkpoints: one call, for the selected run only.
  const detailQ = useQuery(`home|run|${run.id}`, () => unwrap(api.GET("/v1/runs/{run_id}", { params: { path: { run_id: run.id } } })));
  const detail: RunOut | undefined = detailQ.data;
  const doc = runDoc(run, docs);
  const goals = useTracedGoals(doc?.slug, doc?.latest_version, goalIndex);
  const name = runLabel(run, doc?.title);
  return (
    <Inspector
      testId="home-inspector"
      label={`${name} details`}
      eyebrow="Run · selected"
      title={name}
      chips={
        <Chip hero kind={runStatusKind(run)}>
          {runStatusLabel(run)}
        </Chip>
      }
      action={
        <LinkButton variant="hero" href={`/runs/${run.id}`}>
          Open
        </LinkButton>
      }
      stats={[
        { label: "Segments done", value: d ? d.done : "–", of: d?.total, testId: "stat-segments" },
        { label: "Checkpoints", value: detail ? detail.checkpoints.filter((c) => c.status === "pending").length : "–" },
      ]}
    >
      <InspectorSection label="Next" testId="inspector-next">
        <InspectorRow>{runNext(run)}</InspectorRow>
      </InspectorSection>
      {detail && detail.segments.length > 0 && (
        <InspectorSection label="Segments" testId="inspector-segments">
          {detail.segments.map((s) => (
            <InspectorRow key={s.seq} value={<Chip kind={SEGMENT_STATUS_KIND[s.status]}>{SEGMENT_STATUS_LABEL[s.status]}</Chip>}>
              {s.title}
            </InspectorRow>
          ))}
        </InspectorSection>
      )}
      <InspectorSection label="Cost">
        <InspectorRow value={<RunCost run={run} />}>{run.status === "awaiting_approval" ? "Estimate" : "Spent"}</InspectorRow>
      </InspectorSection>
      <GoalsSection goals={goals} />
      {run.document_slug && run.document_id && (
        <InspectorSection>
          <Link href={`/documents/${run.document_slug}`} className="font-medium text-accent-ink hover:underline">
            {doc ? docLabel(doc) : runLabel({ ...run, flow_title: "" }).replace(/ · $/, "")}
          </Link>
        </InspectorSection>
      )}
    </Inspector>
  );
}

export function FlightInspector({
  f,
  openItems,
  docs,
  goalIndex,
}: {
  f: Flight;
  openItems: Map<string, number>;
  docs: DocumentSummary[];
  goalIndex: GoalIndex;
}) {
  return f.kind === "prd" ? (
    <PrdInspector key={f.key} f={f} openItems={openItems.get(f.doc.id)} goalIndex={goalIndex} />
  ) : (
    <RunInspector key={f.key} f={f} docs={docs} goalIndex={goalIndex} />
  );
}

export function FlightTable({
  rows,
  loading,
  selected,
  onSelect,
  header,
  docs,
}: {
  rows: Flight[] | undefined;
  loading: boolean;
  selected: string | null;
  onSelect: (key: string) => void;
  header: ReactNode;
  /** The PRDs Home lists, so a run is named by its document's title (else its slug in words). */
  docs?: DocumentSummary[];
}) {
  // Each row's PRD is in `rows` too: a run of a PRD in review is named by that PRD's title.
  const named = docs ?? rows?.flatMap((f) => (f.kind === "prd" ? [f.doc] : []));
  return (
    <DataTable
      label="In flight"
      testId="home-in-flight-table"
      columns={flightColumns(header, named)}
      rows={rows}
      loading={loading}
      rowKey={(f) => f.key}
      selected={selected}
      // Enter selects as a click does; the inspector's Open opens the row.
      onSelect={(k) => onSelect(k)}
      rowProps={(f) => ({ "data-testid": "flight-row", "data-kind": f.kind, "data-document": (f.kind === "prd" ? f.doc.slug : f.run.document_slug) ?? undefined })}
    />
  );
}
