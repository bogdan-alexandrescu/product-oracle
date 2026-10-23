"use client";

import { useState } from "react";

import { Button, DataTable, FilterChips, Panel, type Column } from "@/components/ds";
import type { EntityOut, GraphOut } from "@/lib/api/client";
import { formatDate } from "@/lib/format";

import type { AddKind } from "./AddItem";
import { LockMark, NodeStatusBadge } from "./common";
import { byTitle } from "./order";

const KINDS = [
  { value: "risk", label: "Risks", one: "Risk" },
  { value: "assumption", label: "Assumptions", one: "Assumption" },
  { value: "requirement", label: "Requirements", one: "Requirement" },
  { value: "strategy_choice", label: "Strategy choices", one: "Strategy choice" },
] as const;

type Kind = (typeof KINDS)[number]["value"];
type Filter = Kind | "all";

/**
 * The items the Ledger does not draw (#337): risks, assumptions, requirements and strategy
 * choices, filtered by kind; archived and rejected ones are left out, as on the Ledger.
 */
export function ItemsTab({
  graph,
  canWrite,
  meId,
  selectedId,
  onOpen,
  onAdd,
}: {
  graph: GraphOut;
  canWrite: boolean;
  meId?: string | null;
  selectedId?: string | null;
  onOpen: (id: string) => void;
  onAdd: (kind: AddKind) => void;
}) {
  const [filter, setFilter] = useState<Filter>("all");
  const items = graph.entities
    .filter((e) => e.status !== "rejected" && KINDS.some((k) => k.value === e.type))
    .sort(byTitle);
  const shown = filter === "all" ? items : items.filter((e) => e.type === filter);
  const label = (t: EntityOut["type"]) => KINDS.find((k) => k.value === t)?.one ?? t;

  const cols: Column<EntityOut>[] = [
    {
      key: "title",
      header: "Item",
      cell: (e) => (
        <span className="flex min-w-0 items-center gap-2">
          <button
            type="button"
            onClick={(ev) => {
              ev.stopPropagation();
              onOpen(e.id);
            }}
            className="min-w-0 truncate text-left font-medium hover:underline"
          >
            {e.title}
          </button>
          <LockMark entity={e} meId={meId} />
        </span>
      ),
    },
    { key: "kind", header: "Kind", width: "150px", cell: (e) => <span className="text-text2">{label(e.type)}</span> },
    { key: "state", header: "State", width: "120px", cell: (e) => <NodeStatusBadge status={e.status} /> },
    {
      key: "updated",
      header: "Updated",
      width: "120px",
      hideOnPhone: true,
      cell: (e) => <span className="tnum text-text2">{formatDate(e.updated_at)}</span>,
    },
  ];

  return (
    <Panel
      title="Items"
      count={items.length}
      tools={
        canWrite ? (
          <Button icon="plus" onClick={() => onAdd(filter === "all" ? "risk" : filter)}>
            Add
          </Button>
        ) : undefined
      }
    >
      <div className="border-b border-line px-4 py-2.5 max-[600px]:px-3">
        <FilterChips<Filter>
          label="Kind"
          value={filter}
          onChange={setFilter}
          items={[
            { value: "all", label: "All", count: items.length },
            ...KINDS.map((k) => ({ value: k.value, label: k.label, count: items.filter((e) => e.type === k.value).length })),
          ]}
        />
      </div>
      <DataTable
        label="Items"
        columns={cols}
        rows={shown}
        rowKey={(e) => e.id}
        selected={selectedId}
        onSelect={(id) => onOpen(id)}
        empty="No items of this kind yet"
      />
    </Panel>
  );
}
