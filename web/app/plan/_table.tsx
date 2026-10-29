import Link from "next/link";

import { Button, Chip, CodeChip, DataTable, type Column } from "@/components/ds";
import { namedText } from "@/lib/codes";

import type { GoalView } from "../home/_goals";
import { driftMarker, engineeringLine, HORIZON_LABEL, HORIZONS, prdLabel, prdName, stateChip, whoLabel, type PlanItem } from "./_lib";

export type GroupBy = "horizon" | "goal" | "prd";
const NO_GOAL = "No goal";

/** H4 §5: "Stopped in the strategy" or "Outside the strategy" on the row, while a finding is open. */
function DriftMarker({ item }: { item: PlanItem }) {
  const m = driftMarker(item);
  if (!m) return null;
  return (
    <Chip kind={m.kind} wrap data-testid="plan-drift-marker">
      {m.label}
    </Chip>
  );
}

/** The state chip; a draft's item has a dashed outline. */
export function StateChip({ item, hero = false, wrap = false }: { item: PlanItem; hero?: boolean; wrap?: boolean }) {
  const s = stateChip(item);
  return (
    <Chip
      kind={s.kind}
      hero={hero}
      wrap={wrap}
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
    // Wraps under the button rather than being cut: "Decide on slip" then "· owners" (qa-plan-4).
    <span data-testid="plan-next" className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5">
      {/* A decision taken on a page the viewer may act on is a button; the rest name it (F2, F3 add theirs). */}
      {n.action === "link_issue" && onLink && item.prd ? (
        <Button
          className="h-7 flex-none px-2 whitespace-nowrap"
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
          className="inline-flex h-7 flex-none items-center rounded-lg border whitespace-nowrap border-line-strong px-2 text-sm font-semibold hover:bg-surface2"
        >
          {n.label}
        </Link>
      ) : (
        <span className="font-medium">{n.label}</span>
      )}
      {who && <span className="min-w-0 break-words text-text2">{` · ${who}`}</span>}
    </span>
  );
}

/** Rows in their group's order, and each row's group (Horizon, Goal or PRD). */
export function grouped(items: PlanItem[], by: GroupBy, tags: Map<string, GoalView>, prdOrder: string[]) {
  const goalOf = (i: PlanItem) => i.goal_ids.map((id) => tags.get(id)).find(Boolean);
  const goalLabel = (i: PlanItem) => {
    const g = goalOf(i);
    return g ? namedText(g) : NO_GOAL;
  };
  const group = (i: PlanItem) => (by === "horizon" ? HORIZON_LABEL[i.horizon] : by === "goal" ? goalLabel(i) : (i.prd?.title ?? "—"));
  const rank = (i: PlanItem): number => {
    if (by === "horizon") return HORIZONS.indexOf(i.horizon);
    if (by === "goal") {
      const g = goalOf(i);
      return g ? Number(g.tag.slice(1)) : 1e6;
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
      wrap: true,
      // Two lines before an ellipsis; the whole title on hover (qa-plan-5).
      cell: (i) => (
        <span data-testid="plan-title" title={i.title} className="line-clamp-2 font-semibold break-words max-[600px]:line-clamp-none">
          {i.title}
        </span>
      ),
    },
    {
      key: "prd",
      header: "PRD",
      width: "120px",
      wrap: true,
      // The PRD by its name; its version is on hover and the state chip says a draft's (qa-plan-5).
      cell: (i) => (
        <span data-testid="plan-prd" title={prdLabel(i)} className="line-clamp-2 break-words text-text2 max-[600px]:line-clamp-none">
          {prdName(i)}
        </span>
      ),
    },
    {
      key: "goal",
      header: "Goal",
      width: "128px",
      wrap: true,
      // prod-4: the first goal in full (its name on two lines), "+N" for the rest, named on hover.
      cell: (i) => {
        const goals = i.goal_ids.map((id) => tags.get(id)).filter((g): g is GoalView => !!g);
        const [first, ...rest] = goals;
        return (
          <span data-testid="plan-goal" className="flex max-w-full min-w-0 flex-wrap items-center gap-1">
            {first ? (
              <>
                <CodeChip kind="goal" entityId={first.id} title={first.title} proposed={first.proposed} wrap />
                {rest.length > 0 && (
                  <span data-testid="plan-goal-more" title={rest.map((g) => namedText(g)).join(", ")} className="tnum flex-none text-sm font-semibold text-text2">
                    +{rest.length}
                  </span>
                )}
              </>
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
      width: "144px",
      phone: "action",
      wrap: true,
      className: "overflow-visible",
      cell: (i) => (
        <span className="inline-flex max-w-full flex-wrap items-center gap-1.5">
          <StateChip item={i} wrap />
          {i.change?.kind === "dropped" && <Chip kind="warn" wrap>Dropped in draft {i.change.draft_version}</Chip>}
          <DriftMarker item={i} />
        </span>
      ),
    },
    {
      key: "engineering",
      header: "Engineering",
      width: "128px",
      wrap: true,
      // Under 760 px (the Ask panel docked) the inspector says it; the other columns keep their room.
      narrow: "hide",
      cell: (i) => (
        <span data-testid="plan-engineering" className="tnum">
          {engineeringLine(i)}
        </span>
      ),
    },
    { key: "next", header: "Next", width: "156px", wrap: true, cell: (i) => <NextCell item={i} me={me} onLink={onLink} /> },
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
