"use client";

import Link from "next/link";

import { Chip, DataTable, InfoTip, Inspector, InspectorRow, InspectorSection, type Column } from "@/components/ds";

import { CompanyEmpty } from "../../_empty";
import { StackPending, type StackLoad } from "./Cards";
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

// pass F F-44: on a phone an empty cell shows nothing, not a bare dash, and its label goes with
// it: the cell is hidden whole (data-empty).
const dash = (
  <span data-empty className="text-text2">
    —
  </span>
);
const EMPTY_ON_PHONE = "max-[600px]:has-[[data-empty]]:hidden";
/** On a phone only: the cell is dropped (its value is the row's title there). */
const phoneOnlyEmpty = <span data-empty hidden />;

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
  canStart = false,
  load,
}: {
  stack: Stack | undefined;
  /** The stack's loading or failed state (pass F F-13: no grey bars forever after a failure). */
  load?: StackLoad;
  rows: StackRow[];
  selected: string | null;
  onSelect: (key: string) => void;
  /** How many confirmed goals the company has (null: not known yet). */
  confirmedGoals?: number | null;
  /** A product strategy document exists (a draft, not approved yet). */
  hasStrategy?: boolean;
  /** An owner may start the product strategy (on its card; none exists yet). */
  canStart?: boolean;
}) {
  const vision = stack?.vision;
  const columns: Column<StackRow>[] = [
    {
      key: "choice",
      header: "Focus choice",
      phone: "title",
      wrap: true,
      cell: (r) => (
        <span data-col="choice">
          {r.choice ? (
            <span className="font-medium">{r.choice.title}</span>
          ) : (
            // A line with no choice is titled on a phone with its goal or item, not a blank line.
            <>
              <span className="text-text2 max-[600px]:hidden">—</span>
              <span className="hidden font-medium max-[600px]:inline">
                {r.goal?.title ?? r.item?.title}
                {r.item?.draft && <span className="ml-1 font-normal text-text2">(draft)</span>}
              </span>
            </>
          )}
        </span>
      ),
    },
    {
      key: "goal",
      header: "Goal",
      phone: "meta",
      phoneLabel: "Goal",
      wrap: true,
      className: EMPTY_ON_PHONE,
      cell: (r) => (
        <span data-col="goal">
          {r.goal ? r.goal.title : r.choice ? <span className="text-warn">No goal</span> : dash}
          {r.goal && !r.choice && phoneOnlyEmpty}
        </span>
      ),
    },
    {
      key: "items",
      header: "Roadmap items",
      width: "160px",
      phone: "meta",
      phoneLabel: "Roadmap items",
      wrap: true,
      className: EMPTY_ON_PHONE,
      cell: (r) => (
        <span data-col="items" className="tnum">
          {r.item ? (
            <>
              {r.item.title}
              {r.item.draft && <span className="ml-1 text-text2">(draft)</span>}
              {phoneOnlyEmpty}
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
      ? "Open the product strategy draft to review it."
      : canStart
        ? "Start one on the Product strategy card above."
        : "An owner writes it.";
    // One New product strategy, on its card (qa-company-20): the empty stack points to it.
    // pass F F-45: one short line; what the stack holds sits behind the (i).
    return (
      <CompanyEmpty testId="stack-empty" title="Waiting for an approved product strategy">
        {next}{" "}
        <InfoTip label="the strategy stack" align="end">
          {goals} show here under the focus choice each follows from, with the roadmap items serving it, once an owner approves a
          product strategy.
        </InfoTip>
      </CompanyEmpty>
    );
  }
  if (!stack && load?.failed) return <StackPending load={load} testId="stack" />;
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
        {/* pass F F-43: the vision line wraps (two lines at most), not cut after a few words. */}
        <div className="flex min-h-8 items-start gap-2.5 py-1">
          <span data-testid="chain-vision" className="line-clamp-2 min-w-0 flex-1 [overflow-wrap:anywhere]">
            {stack?.vision?.headline ?? "No approved vision"}
          </span>
          {stack?.vision && <span className="tnum flex-none font-semibold">v{stack.vision.document.version}</span>}
        </div>
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
