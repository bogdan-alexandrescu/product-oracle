"use client";

import Link from "next/link";
import type { ReactNode } from "react";

import { DocStatusChip } from "@/app/documents/_components/DocStatusChip";
import {
  Chip,
  DataTable,
  GoalTag,
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
import { useQuery } from "@/lib/use-query";

import {
  CHECKPOINT_LABEL,
  RUN_STATUS_KIND,
  RUN_STATUS_LABEL,
  RunCost,
  SEGMENT_STATUS_KIND,
  SEGMENT_STATUS_LABEL,
  shortId,
  type RunOut,
  type RunSummary,
} from "../runs/_lib";

/** A goal a row serves: its G tag, and whether the goal is still proposed. */
export type RowGoal = { tag: string; title: string; proposed: boolean };

/** One line of In flight: a PRD in review, or a run in progress. */
export type Flight =
  | { kind: "prd"; key: string; doc: DocumentSummary; goals: RowGoal[] }
  | { kind: "run"; key: string; run: RunSummary; detail: RunOut | undefined; goals: RowGoal[] };

/** A PRD in review stands at the journey's Review step. */
const REVIEW_STEP = JOURNEY_STEPS.indexOf("Review") + 1;

function segmentsDone(run: RunOut | undefined) {
  if (!run) return null;
  return { done: run.segments.filter((s) => s.status === "succeeded").length, total: run.segments.length };
}

/** What the run does next: the checkpoint it waits on, else the segment under way or next. */
function runNext(run: RunSummary, detail: RunOut | undefined): string {
  if (run.waiting_on) return CHECKPOINT_LABEL[run.waiting_on];
  if (run.status === "awaiting_approval") return "Cost approval";
  if (run.status === "paused_overrun") return "Resume or cancel";
  const seg = detail?.segments.find((s) => s.status === "running") ?? detail?.segments.find((s) => s.status === "pending");
  return seg?.title ?? "–";
}

function title(f: Flight) {
  return f.kind === "prd" ? f.doc.title : (f.run.document_slug ?? f.run.flow_title);
}

function GoalTags({ goals }: { goals: RowGoal[] }) {
  if (goals.length === 0) return <span className="text-text2">–</span>;
  return (
    <span className="inline-flex flex-wrap gap-1.5" data-testid="row-goals">
      {goals.map((g) => (
        <GoalTag key={g.tag} id={g.tag} proposed={g.proposed} title={`${g.tag} · ${g.title}${g.proposed ? " · proposed" : ""}`} />
      ))}
    </span>
  );
}

export function flightColumns(phoneHeader: ReactNode): Column<Flight>[] {
  return [
    {
      key: "name",
      header: phoneHeader,
      phone: "title",
      cell: (f) => (
        <span className="flex min-w-0 items-baseline gap-1.5">
          <span className="truncate font-medium">{title(f)}</span>
          {f.kind === "prd" && f.doc.latest_version != null && (
            <span className="tnum flex-none text-sm text-text2">v{f.doc.latest_version}</span>
          )}
          {f.kind === "run" && <span className="tnum flex-none font-mono text-[13px] text-text2">{shortId(f.run.id)}</span>}
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
          <Chip kind={RUN_STATUS_KIND[f.run.status]} dot>
            {RUN_STATUS_LABEL[f.run.status]}
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
          <span className="truncate" title={runNext(f.run, f.detail)}>
            {runNext(f.run, f.detail)}
          </span>
        ),
    },
    {
      key: "done",
      header: "Done",
      width: "150px",
      phone: "meta",
      cell: (f) => {
        if (f.kind === "prd") {
          return (
            <span className="flex min-w-0 items-center gap-2" data-testid="row-journey">
              <JourneyTrack current={REVIEW_STEP} variant="dots" />
              <b className="tnum flex-none font-semibold">
                {REVIEW_STEP}/{JOURNEY_STEPS.length}
              </b>
            </span>
          );
        }
        const d = segmentsDone(f.detail);
        return d ? <Meter value={d.done} max={d.total} label="Segments done" /> : <span className="text-text2">–</span>;
      },
    },
    {
      key: "goals",
      header: "Goals",
      width: "92px",
      phone: "hide",
      cell: (f) => <GoalTags goals={f.goals} />,
    },
  ];
}

const VERDICT_BAR: Record<string, string> = {
  approved: "bg-pass",
  changes_requested: "bg-warn",
  rejected: "bg-crit",
};

/** The selected PRD: journey, blockers, sections reviewed, open items, its sections and blockers. */
function PrdInspector({ f, openItems }: { f: Extract<Flight, { kind: "prd" }>; openItems: number | undefined }) {
  const d = f.doc;
  const n = d.latest_version;
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
  const blockers = r ? r.items.filter((i) => r.blocking.includes(i.key)) : [];

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
        { label: "Sections done", value: v ? approved : "–", of: v ? sections.length : undefined, testId: "stat-sections" },
        { label: "Open items", value: openItems ?? 0, testId: "stat-open" },
      ]}
    >
      <InspectorSection testId="inspector-journey">
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
              <span className="inline-flex min-w-0 items-center gap-2.5" title={b.question}>
                <Icon name="alert" size={16} className="flex-none text-crit" />
                <span className="truncate">{b.title}</span>
              </span>
            </InspectorRow>
          ))}
        </InspectorSection>
      )}
      {f.goals.length > 0 && (
        <InspectorSection label="Goals" tools={<GoalTags goals={f.goals} />}>
          {f.goals.map((g) => (
            <InspectorRow key={g.tag}>{g.title}</InspectorRow>
          ))}
        </InspectorSection>
      )}
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
function RunInspector({ f }: { f: Extract<Flight, { kind: "run" }> }) {
  const run = f.run;
  const d = segmentsDone(f.detail);
  return (
    <Inspector
      testId="home-inspector"
      label={`Run ${shortId(run.id)} details`}
      eyebrow={`Run ${shortId(run.id)} · selected`}
      title={run.document_slug ?? run.flow_title}
      chips={
        <>
          <Chip hero kind={RUN_STATUS_KIND[run.status]}>
            {RUN_STATUS_LABEL[run.status]}
          </Chip>
          <Chip hero>{run.flow_title}</Chip>
        </>
      }
      action={
        <LinkButton variant="hero" href={`/runs/${run.id}`}>
          Open
        </LinkButton>
      }
      stats={[
        { label: "Segments done", value: d ? d.done : "–", of: d?.total, testId: "stat-segments" },
        { label: "Checkpoints", value: f.detail ? f.detail.checkpoints.filter((c) => c.status === "pending").length : "–" },
      ]}
    >
      <InspectorSection label="Next" testId="inspector-next">
        <InspectorRow>{runNext(run, f.detail)}</InspectorRow>
      </InspectorSection>
      {f.detail && f.detail.segments.length > 0 && (
        <InspectorSection label="Segments" testId="inspector-segments">
          {f.detail.segments.map((s) => (
            <InspectorRow key={s.seq} value={<Chip kind={SEGMENT_STATUS_KIND[s.status]}>{SEGMENT_STATUS_LABEL[s.status]}</Chip>}>
              {s.title}
            </InspectorRow>
          ))}
        </InspectorSection>
      )}
      <InspectorSection label="Cost">
        <InspectorRow value={<RunCost run={run} />}>{run.status === "awaiting_approval" ? "Estimate" : "Spent"}</InspectorRow>
      </InspectorSection>
      {f.goals.length > 0 && (
        <InspectorSection label="Goals" tools={<GoalTags goals={f.goals} />}>
          {f.goals.map((g) => (
            <InspectorRow key={g.tag}>{g.title}</InspectorRow>
          ))}
        </InspectorSection>
      )}
      {run.document_slug && run.document_id && (
        <InspectorSection>
          <Link href={`/documents/${run.document_slug}`} className="font-medium text-accent-ink hover:underline">
            {run.document_slug}
          </Link>
        </InspectorSection>
      )}
    </Inspector>
  );
}

export function FlightInspector({ f, openItems }: { f: Flight; openItems: Map<string, number> }) {
  return f.kind === "prd" ? <PrdInspector key={f.key} f={f} openItems={openItems.get(f.doc.id)} /> : <RunInspector key={f.key} f={f} />;
}

export function FlightTable({
  rows,
  loading,
  selected,
  onSelect,
  onActivate,
  header,
}: {
  rows: Flight[] | undefined;
  loading: boolean;
  selected: string | null;
  onSelect: (key: string) => void;
  onActivate: (f: Flight) => void;
  header: ReactNode;
}) {
  return (
    <DataTable
      label="In flight"
      testId="home-in-flight-table"
      columns={flightColumns(header)}
      rows={rows}
      loading={loading}
      rowKey={(f) => f.key}
      selected={selected}
      onSelect={(k) => onSelect(k)}
      onActivate={(_, f) => onActivate(f)}
      rowProps={(f) => ({ "data-testid": "flight-row", "data-kind": f.kind })}
    />
  );
}
