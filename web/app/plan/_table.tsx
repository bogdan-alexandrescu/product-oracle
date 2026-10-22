import Link from "next/link";

import { Button, Chip, DataTable, GoalTag, type Column } from "@/components/ds";

import type { GoalView } from "../home/_goals";
import { engineeringLine, HORIZON_LABEL, HORIZONS, prdLabel, stateChip, whoLabel, type PlanItem } from "./_lib";

export type GroupBy = "horizon" | "goal" | "prd";
const NO_GOAL = "No goal";

/** The state chip; a draft's item has a dashed outline. */
export function StateChip({ item, hero = false }: { item: PlanItem; hero?: boolean }) {
  const s = stateChip(item);
  return (
    <Chip
      kind={s.kind}
      hero={hero}
      data-testid="plan-state"
      data-state={item.state}
      data-dashed={s.dashed ? "true" : undefined}
      className={s.dashed ? "border-dashed" : ""}
    >
      {s.label}
    </Chip>
  );
}

function NextCell({ item, me, onLink }: { item: PlanItem; me: string | null | undefined; onLink?: (i: PlanItem) => void }) {
  const n = item.next;
  if (!n.action) return <span data-testid="plan-next" className="text-text2">—</span>;
  const who = whoLabel(n.who, me);
  return (
    <span data-testid="plan-next" className="inline-flex min-w-0 items-center gap-1.5">
      {/* A decision taken on a page the viewer may act on is a button; the rest name it (F2, F3 add theirs). */}
      {n.action === "link_issue" && onLink && item.prd ? (
        <Button
          className="h-7 flex-none px-2"
          onClick={(e) => {
            e.stopPropagation();
            onLink(item);
          }}
        >
          {n.label}
        </Button>
      ) : n.href && n.viewer_may ? (
        <Link
          href={n.href}
          onClick={(e) => e.stopPropagation()}
          className="inline-flex h-7 flex-none items-center rounded-lg border border-line-strong px-2 text-sm font-semibold hover:bg-surface2"
        >
          {n.label}
        </Link>
      ) : (
        <span className="font-medium">{n.label}</span>
      )}
      {who && <span className="truncate text-text2">{` · ${who}`}</span>}
    </span>
  );
}

/** Rows in their group's order, and each row's group (Horizon, Goal or PRD). */
export function grouped(items: PlanItem[], by: GroupBy, tags: Map<string, GoalView>, prdOrder: string[]) {
  const goalOf = (i: PlanItem) => i.goal_ids.map((id) => tags.get(id)?.tag).find(Boolean) ?? NO_GOAL;
  const group = (i: PlanItem) => (by === "horizon" ? HORIZON_LABEL[i.horizon] : by === "goal" ? goalOf(i) : (i.prd?.title ?? "—"));
  const rank = (i: PlanItem): number => {
    if (by === "horizon") return HORIZONS.indexOf(i.horizon);
    if (by === "goal") {
      const t = goalOf(i);
      return t === NO_GOAL ? 1e6 : Number(t.slice(1));
    }
    const at = prdOrder.indexOf(i.prd?.slug ?? "");
    return at < 0 ? 1e6 : at;
  };
  // Stable: within a group, the API's order (by roadmap, then position).
  const rows = items.map((i, n) => ({ i, n })).sort((a, b) => rank(a.i) - rank(b.i) || a.n - b.n).map((x) => x.i);
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(group(r), (counts.get(group(r)) ?? 0) + 1);
  return { rows, group, counts };
}

export function PlanTable({
  items,
  by,
  tags,
  prdOrder,
  selected,
  onSelect,
  me,
  loading,
  onLink,
}: {
  items: PlanItem[] | undefined;
  by: GroupBy;
  tags: Map<string, GoalView>;
  prdOrder: string[];
  selected: string | null;
  onSelect: (id: string) => void;
  me: string | null | undefined;
  loading: boolean;
  /** F7: set for those who may link tracker issues; the Next cell's Link issue opens the dialog. */
  onLink?: (i: PlanItem) => void;
}) {
  const { rows, group, counts } = grouped(items ?? [], by, tags, prdOrder);
  const columns: Column<PlanItem>[] = [
    {
      key: "item",
      header: "Item",
      phone: "title",
      cell: (i) => (
        <span data-testid="plan-title" title={i.title} className="block truncate font-semibold">
          {i.title}
        </span>
      ),
    },
    {
      key: "prd",
      header: "PRD",
      width: "120px",
      cell: (i) => (
        <span data-testid="plan-prd" title={prdLabel(i)} className="truncate text-text2">
          {prdLabel(i)}
        </span>
      ),
    },
    {
      key: "goal",
      header: "Goal",
      width: "64px",
      cell: (i) => {
        const goals = i.goal_ids.map((id) => tags.get(id)).filter((g): g is GoalView => !!g);
        return (
          <span data-testid="plan-goal" className="inline-flex items-center gap-1">
            {goals.length ? (
              goals.map((g) => <GoalTag key={g.id} id={g.tag} proposed={g.proposed} title={`${g.tag} · ${g.title}`} />)
            ) : (
              <span className="text-sm font-semibold text-warn">{NO_GOAL}</span>
            )}
          </span>
        );
      },
    },
    {
      key: "state",
      header: "State",
      width: "168px",
      phone: "action",
      className: "overflow-visible",
      cell: (i) => (
        <span className="inline-flex flex-wrap items-center gap-1.5">
          <StateChip item={i} />
          {i.change?.kind === "dropped" && <Chip kind="warn">Dropped in draft {i.change.draft_version}</Chip>}
        </span>
      ),
    },
    {
      key: "engineering",
      header: "Engineering",
      width: "168px",
      cell: (i) => (
        <span data-testid="plan-engineering" className="tnum truncate">
          {engineeringLine(i)}
        </span>
      ),
    },
    { key: "next", header: "Next", width: "140px", cell: (i) => <NextCell item={i} me={me} onLink={onLink} /> },
  ];
  return (
    <DataTable<PlanItem>
      label="Roadmap items"
      testId="plan-table"
      columns={columns}
      rows={loading && !items ? undefined : rows}
      loading={loading && !items}
      rowKey={(i) => i.id}
      selected={selected}
      onSelect={(k) => onSelect(k)}
      group={group}
      groupLabel={(g) => (
        <>
          {g} <span className="tnum text-accent-ink">{counts.get(g)}</span>
        </>
      )}
      groupProps={() => ({ "data-testid": "plan-group" })}
      rowProps={(i) => ({ "data-testid": "plan-row", "data-origin": i.origin, "data-item": i.key })}
      empty="No roadmap items yet"
    />
  );
}
