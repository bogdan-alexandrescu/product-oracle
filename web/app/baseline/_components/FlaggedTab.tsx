"use client";

import { Chip, CodeChip, DataTable, KpiStrip, Panel, type Column } from "@/components/ds";
import type { TraceFeature, TraceGoal, TraceReport } from "@/lib/api/client";

import { ConfidenceRing, FlagBadges, KPI_PHONE, NodeStatusBadge } from "./common";

/** Features that serve no confirmed goal or rest on weak evidence, and goal coverage. */
export function FlaggedTab({
  trace,
  tags,
  selectedId,
  onOpen,
}: {
  trace: TraceReport;
  tags: Map<string, string>;
  selectedId?: string | null;
  onOpen: (id: string) => void;
}) {
  const s = trace.summary;
  const open = (id: string) => (e: { stopPropagation: () => void }) => {
    e.stopPropagation();
    onOpen(id);
  };

  const flaggedCols: Column<TraceFeature>[] = [
    {
      key: "feature",
      header: "Feature",
      cell: (f) => (
        <span className="flex min-w-0 items-center gap-2">
          <button type="button" onClick={open(f.id)} className="min-w-0 truncate text-left font-medium hover:underline">
            {f.title}
          </button>
          <span className="flex flex-none gap-1.5">
            <FlagBadges flags={f.flags} />
          </span>
        </span>
      ),
    },
    { key: "state", header: "Review", width: "120px", hideOnPhone: true, cell: (f) => <NodeStatusBadge status={f.status} /> },
    {
      key: "goals",
      header: "Goals",
      width: "160px",
      hideOnPhone: true,
      cell: (f) =>
        f.goals.length === 0 ? (
          <span className="text-text2">–</span>
        ) : (
          <span className="flex min-w-0 gap-1">
            {f.goals.map((g) => (
              <CodeChip key={g.goal_id} kind="goal" entityId={g.goal_id} entityKey={g.key} title={g.title} />
            ))}
          </span>
        ),
    },
    {
      key: "evidence",
      header: "Evidence",
      phoneLabel: "Evidence",
      width: "84px",
      align: "right",
      cell: (f) => <span className="tnum">{f.evidence_count}</span>,
    },
    {
      key: "confidence",
      header: "Confidence",
      width: "96px",
      align: "center",
      // A score is built on evidence: none, no score (qa-plan-8).
      cell: (f) => <ConfidenceRing value={f.confidence} evidence={f.evidence_count} low={trace.low} size={32} />,
    },
  ];

  const coverageCols: Column<TraceGoal>[] = [
    {
      key: "goal",
      header: "Goal",
      cell: (g) => (
        <span className="flex min-w-0 items-center gap-2">
          <CodeChip kind="goal" entityId={g.id} entityKey={g.key} title={g.title} proposed={g.status === "proposed"} codeOnly />
          <button type="button" onClick={open(g.id)} className="min-w-0 truncate text-left font-medium hover:underline">
            {tags.get(g.id) ?? g.title}
          </button>
        </span>
      ),
    },
    { key: "state", header: "Review", width: "120px", hideOnPhone: true, cell: (g) => <NodeStatusBadge status={g.status} /> },
    {
      key: "features",
      header: "Features",
      phoneLabel: "Features",
      width: "92px",
      align: "right",
      cell: (g) => (
        <span data-col="features" className="tnum" title={g.features.map((f) => `${f.title} (${f.contribution})`).join(", ")}>
          {g.features.length}
        </span>
      ),
    },
    {
      key: "coverage",
      header: "Coverage",
      phoneLabel: "Coverage",
      width: "96px",
      align: "right",
      cell: (g) =>
        g.coverage === 0 && g.status === "confirmed" ? (
          <Chip kind="crit">
            <span data-col="coverage">{g.coverage}</span>
          </Chip>
        ) : (
          <span data-col="coverage" className="tnum font-semibold">
            {g.coverage}
          </span>
        ),
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      <div className={KPI_PHONE}>
        <KpiStrip
          label="Summary"
          items={[
            { label: "Flagged", value: s.flagged, of: s.features, tone: s.flagged > 0 ? "crit" : undefined },
            { label: "Serve no goal", value: s.serves_no_goal, tone: s.serves_no_goal > 0 ? "crit" : undefined },
            { label: "Weak evidence", value: s.weak_evidence, tone: s.weak_evidence > 0 ? "warn" : undefined },
            { label: "Uncovered goals", value: s.uncovered_goals, of: s.confirmed_goals, tone: s.uncovered_goals > 0 ? "warn" : undefined },
          ]}
        />
      </div>

      <Panel title="Flagged features" count={trace.flagged.length}>
        <DataTable
          label="Flagged features"
          columns={flaggedCols}
          rows={trace.flagged}
          rowKey={(f) => f.id}
          selected={selectedId}
          onSelect={(id) => onOpen(id)}
          rowProps={(f) => ({ "data-testid": `flagged-${f.key}` })}
          empty="Nothing flagged"
        />
      </Panel>

      <Panel title="Goal coverage" count={trace.goals.length}>
        <DataTable
          label="Goal coverage"
          columns={coverageCols}
          rows={trace.goals}
          rowKey={(g) => g.id}
          selected={selectedId}
          onSelect={(id) => onOpen(id)}
          rowProps={(g) => ({ "data-testid": `coverage-${g.key}` })}
          empty="No goals yet"
        />
      </Panel>
    </div>
  );
}
