"use client";

import { useState } from "react";

import { Chip, DataTable, FilterChips, Panel, type Column, type FilterChip } from "@/components/ds";
import type { Schemas } from "@/lib/api/client";

import { BLOCKER_STATUS, BLOCKER_STATUS_KIND, GATE_KIND, GATE_LABEL } from "./BlockerInspector";

type Row = Schemas["BlockerSummary"];
type Filter = "all" | Row["status"];

const SEVERITY: Record<Row["severity"], string> = { critical: "Critical", high: "High", medium: "Medium", low: "Low" };

/** Every blocker, worst first, with a count per status; a row opens the blocker inspector. */
export function BlockersTab({
  blockers,
  selectedId,
  onOpen,
}: {
  blockers: Row[];
  selectedId?: string | null;
  onOpen: (id: string) => void;
}) {
  const [filter, setFilter] = useState<Filter>("all");
  const count = (s: Row["status"]) => blockers.filter((b) => b.status === s).length;
  const chips: FilterChip<Filter>[] = [
    { value: "all", label: "All", count: blockers.length },
    ...(Object.keys(BLOCKER_STATUS) as Row["status"][]).map((s) => ({ value: s, label: BLOCKER_STATUS[s], count: count(s) })),
  ];
  const rows = filter === "all" ? blockers : blockers.filter((b) => b.status === filter);

  const columns: Column<Row>[] = [
    {
      key: "blocker",
      header: "Blocker",
      cell: (b) => (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onOpen(b.id);
          }}
          className="min-w-0 text-left font-medium break-words hover:underline"
        >
          {b.statement}
        </button>
      ),
    },
    { key: "severity", header: "Severity", width: "100px", hideOnPhone: true, cell: (b) => SEVERITY[b.severity] },
    {
      key: "status",
      header: "Status",
      phoneLabel: "Status",
      width: "140px",
      cell: (b) => <Chip kind={BLOCKER_STATUS_KIND[b.status]}>{BLOCKER_STATUS[b.status]}</Chip>,
    },
    {
      key: "gate",
      header: "Publishing",
      width: "150px",
      hideOnPhone: true,
      cell: (b) => <Chip kind={GATE_KIND[b.gate.status]}>{GATE_LABEL[b.gate.status]}</Chip>,
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      <FilterChips label="Blocker status" items={chips} value={filter} onChange={setFilter} />
      <Panel title="Blockers" count={rows.length}>
        <DataTable
          label="Blockers"
          columns={columns}
          rows={rows}
          rowKey={(b) => b.id}
          selected={selectedId}
          onSelect={(id) => onOpen(id)}
          rowProps={() => ({ "data-testid": "blocker-row" })}
          empty="No blockers"
        />
      </Panel>
    </div>
  );
}
