"use client";

import Link from "next/link";

import { Button, Chip, DataTable, Inspector, InspectorRow, InspectorSection, type Column } from "@/components/ds";

import { CompanyEmpty } from "../../_empty";
import { FindingRow } from "./DriftList";
import { findingsAbout, plural, type Choice, type Finding, type Stack } from "./lib";

/** One stack-table line: a goal under its focus choice, or something not under the strategy. */
export type StackRow = {
  key: string;
  group: "under" | "unaligned";
  choice: Choice | null;
  goal: { id: string; title: string } | null;
  /** An item not under the strategy (the unaligned group). */
  item: { id: string; title: string; draft: boolean } | null;
  /** Roadmap items under the line (the goal's, or the choice's when it has no goal). */
  items: number | null;
  findings: Finding[];
};

const UNDER = "under";
const UNALIGNED = "unaligned";

/** The lines: one per goal under its focus choice, then the goals and items not under it. */
export function stackRows(stack: Stack | undefined, open: Finding[]): StackRow[] {
  if (!stack) return [];
  const rows: StackRow[] = [];
  for (const c of stack.strategy?.choices.filter((x) => x.stance === "focus") ?? []) {
    const about = findingsAbout(open, c.entity_id);
    if (!c.goals.length) {
      rows.push({ key: c.entity_id, group: UNDER, choice: c, goal: null, item: null, items: c.items, findings: about });
      continue;
    }
    c.goals.forEach((g, i) =>
      rows.push({
        key: `${c.entity_id}|${g.id}`,
        group: UNDER,
        choice: c,
        goal: g,
        item: null,
        items: g.items ?? 0,
        findings: [...(i === 0 ? about : []), ...findingsAbout(open, g.id)],
      }),
    );
  }
  for (const g of stack.unaligned.goals) {
    rows.push({ key: `goal|${g.id}`, group: UNALIGNED, choice: null, goal: g, item: null, items: null, findings: findingsAbout(open, g.id) });
  }
  for (const i of stack.unaligned.items) {
    rows.push({
      key: `item|${i.roadmap_item_id}`,
      group: UNALIGNED,
      choice: null,
      goal: null,
      item: { id: i.roadmap_item_id, title: i.title, draft: i.draft },
      items: null,
      findings: findingsAbout(open, i.roadmap_item_id),
    });
  }
  return rows;
}

const dash = <span className="text-text2">—</span>;

/**
 * The strategy stack (B1 Split): the vision, each focus choice, the goals derived from it
 * and the roadmap items under them; a last group lists what is not under the strategy.
 */
export function StackTable({
  stack,
  rows,
  selected,
  onSelect,
  confirmedGoals = null,
  hasStrategy = false,
  onNewStrategy,
}: {
  stack: Stack | undefined;
  rows: StackRow[];
  selected: string | null;
  onSelect: (key: string) => void;
  /** How many confirmed goals the company has (null: not known yet). */
  confirmedGoals?: number | null;
  /** A product strategy document exists (a draft, not approved yet). */
  hasStrategy?: boolean;
  /** An owner may start the product strategy here (none exists yet). */
  onNewStrategy?: () => void;
}) {
  const vision = stack?.vision;
  const columns: Column<StackRow>[] = [
    {
      key: "choice",
      header: "Focus choice",
      phone: "title",
      wrap: true,
      cell: (r) => <span data-col="choice">{r.choice ? <span className="font-medium">{r.choice.title}</span> : dash}</span>,
    },
    {
      key: "goal",
      header: "Goal",
      phone: "meta",
      wrap: true,
      cell: (r) => (
        <span data-col="goal">
          {r.goal ? r.goal.title : r.choice ? <span className="text-warn">No goal</span> : dash}
        </span>
      ),
    },
    {
      key: "items",
      header: "Roadmap items",
      width: "160px",
      phone: "meta",
      wrap: true,
      cell: (r) => (
        <span data-col="items" className="tnum">
          {r.item ? (
            <>
              {r.item.title}
              {r.item.draft && <span className="ml-1 text-text2">(draft)</span>}
            </>
          ) : r.items != null ? (
            plural(r.items, "item")
          ) : (
            dash
          )}
        </span>
      ),
    },
    {
      key: "findings",
      header: "Findings",
      width: "112px",
      phone: "hide",
      cell: (r) => (
        <span data-col="findings">{r.findings.length ? <Chip kind={r.findings.some((f) => f.severity === "high") ? "crit" : "warn"}>{r.findings.length} open</Chip> : dash}</span>
      ),
    },
  ];
  // qa-company-36: an empty stack says what it holds and what fills it, not a header row
  // over "No approved strategy yet". qa-company-13: the confirmed goals Home shows are not
  // lost; they line up here once a product strategy is approved, and an owner starts one.
  if (stack && rows.length === 0) {
    const goals = confirmedGoals ? `The ${plural(confirmedGoals, "confirmed goal")}` : "The confirmed goals";
    const next = hasStrategy
      ? "Open the product strategy draft to review it; an owner approves it."
      : onNewStrategy
        ? "Start one to line them up."
        : "An owner writes it.";
    return (
      <CompanyEmpty
        testId="stack-empty"
        title="Waiting for an approved product strategy"
        action={
          onNewStrategy && !hasStrategy ? (
            <Button variant="primary" icon="plus" onClick={onNewStrategy}>
              New product strategy
            </Button>
          ) : undefined
        }
      >
        {goals} show here under the focus choice each follows from, with the roadmap items serving it, once a product strategy is
        approved. {next}
      </CompanyEmpty>
    );
  }
  return (
    <DataTable
      label="Strategy stack"
      testId="strategy-stack"
      columns={columns}
      rows={stack ? rows : undefined}
      loading={!stack}
      rowKey={(r) => r.key}
      selected={selected}
      onSelect={onSelect}
      group={(r) => r.group}
      groupLabel={(g) =>
        g === UNALIGNED ? (
          "Not under the strategy"
        ) : (
          <span className="[overflow-wrap:anywhere]">
            Under the strategy{vision?.headline ? <span className="font-normal text-text2"> · Vision: {vision.headline}</span> : null}
          </span>
        )
      }
      groupProps={(g) => ({ "data-testid": `stack-group-${g}` })}
      rowProps={() => ({ "data-testid": "stack-row" })}
    />
  );
}

/** The selected line's chain (vision → choice → goal → items) and its open findings. */
export function StackInspector({ stack, row, onWaived }: { stack: Stack | undefined; row: StackRow | null; onWaived: (f: Finding) => void }) {
  if (!row) return null;
  const title = row.item?.title ?? row.goal?.title ?? row.choice?.title ?? "";
  const doc = stack?.strategy?.document;
  return (
    <Inspector
      label="Stack line"
      testId="stack-inspector"
      eyebrow={row.group === UNALIGNED ? "Not under the strategy" : "Under the strategy"}
      title={<span className="[overflow-wrap:anywhere]">{title}</span>}
    >
      <InspectorSection label="Chain">
        <InspectorRow value={stack?.vision ? `v${stack.vision.document.version}` : undefined}>
          {stack?.vision?.headline ?? "No approved vision"}
        </InspectorRow>
        <InspectorRow>
          {row.choice && doc ? (
            <Link href={`/documents/${doc.slug}/v/${doc.version}#choice-${row.choice.id}`} className="text-accent-ink hover:underline">
              {row.choice.title}
            </Link>
          ) : (
            "No focus choice"
          )}
        </InspectorRow>
        <InspectorRow>
          {row.goal ? (
            <Link href={`/baseline?entity=${row.goal.id}`} className="text-accent-ink hover:underline">
              {row.goal.title}
            </Link>
          ) : (
            "No goal"
          )}
        </InspectorRow>
        <InspectorRow>{row.item ? row.item.title : row.items != null ? plural(row.items, "roadmap item") : "No roadmap items"}</InspectorRow>
      </InspectorSection>
      <InspectorSection label="Findings">
        {row.findings.length ? (
          <ul className="-mx-4">
            {row.findings.map((f) => (
              <FindingRow key={f.id} finding={f} stack={stack} onWaived={onWaived} testId="inspector-finding" />
            ))}
          </ul>
        ) : (
          <p className="text-sm text-text2">No open findings</p>
        )}
      </InspectorSection>
    </Inspector>
  );
}
