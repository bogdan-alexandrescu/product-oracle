import Link from "next/link";

import { Button, Chip, CodeChip, DataTable, type Column } from "@/components/ds";
import { namedText } from "@/lib/codes";

import type { GoalView } from "../home/_goals";
import { driftMarker, engineeringParts, HORIZON_LABEL, HORIZONS, nextButton, nextSentence, prdLabel, prdName, stateChip, type PlanItem } from "./_lib";

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

/**
 * The state chip; a draft's item has a dashed outline. In the table (`split`) the pill holds one
 * word on one line and the rest ("Next → Now", "in draft 2 (was Planned)") sits below it, outside
 * the pill (qa-plan-30).
 */
export function StateChip({ item, hero = false, split = false }: { item: PlanItem; hero?: boolean; split?: boolean }) {
  const s = stateChip(item);
  const chip = (text: string, attrs: boolean) => (
    <Chip
      kind={s.kind}
      hero={hero}
      data-testid={attrs ? "plan-state" : undefined}
      data-state={attrs ? item.state : undefined}
      data-dashed={attrs && s.dashed ? "true" : undefined}
      className={`flex-none ${s.dashed ? "border-dashed" : ""}`}
    >
      {text}
    </Chip>
  );
  if (!split || !s.detail) return chip(s.label, true);
  return (
    <span
      data-testid="plan-state"
      data-state={item.state}
      data-dashed={s.dashed ? "true" : undefined}
      title={s.label}
      className="inline-flex max-w-full min-w-0 flex-col items-start gap-0.5"
    >
      {chip(s.head, false)}
      <span className="min-w-0 text-[13px] break-words text-text2">
        <span className="sr-only">{s.sep}</span>
        {s.detail}
      </span>
    </span>
  );
}

/** On a phone an empty cell ("—") is dropped rather than left alone on a line (qa-plan-54). */
const EMPTY_ON_PHONE = "max-[600px]:has-[[data-empty]]:hidden";

function NextCell({ item, me, onLink }: { item: PlanItem; me: string | null | undefined; onLink?: (i: PlanItem) => void }) {
  const n = item.next;
  if (!n.action)
    return (
      <span data-testid="plan-next" data-empty className="text-text2">
        —
      </span>
    );
  const sentence = nextSentence(n, me);
  // qa-plan-29: a viewer who may take the decision gets its button ("Review the PRD"); the rest
  // read who takes it in one sentence ("Owners decide on the slip"), never "Decide on slip · owners".
  if (n.action === "link_issue" && onLink && item.prd)
    return (
      <span data-testid="plan-next" className="flex min-w-0 flex-col items-start">
        <Button
          className="h-7 max-w-full flex-none px-2 whitespace-nowrap"
          onClick={(e) => {
            e.stopPropagation();
            onLink(item);
          }}
        >
          {nextButton(n)}
        </Button>
      </span>
    );
  if (n.href && n.viewer_may)
    return (
      <span data-testid="plan-next" className="flex min-w-0 flex-col items-start">
        <Link
          href={n.href}
          onClick={(e) => e.stopPropagation()}
          className="inline-flex h-7 max-w-full flex-none items-center rounded-lg border whitespace-nowrap border-line-strong px-2 text-sm font-semibold hover:bg-surface2"
        >
          {nextButton(n)}
        </Link>
      </span>
    );
  return (
    <span data-testid="plan-next" className="min-w-0 text-sm break-words">
      {sentence}
    </span>
  );
}

/** The Engineering cell: the issue key and its date together; a long pair breaks between them, never inside one (qa-plan-13). */
function EngineeringCell({ item }: { item: PlanItem }) {
  const [issue, day] = engineeringParts(item);
  if (!issue && !day)
    return (
      <span data-testid="plan-engineering" data-empty className="tnum text-text2">
        —
      </span>
    );
  return (
    <span data-testid="plan-engineering" className="tnum text-sm">
      {issue && <span className="whitespace-nowrap">{issue}</span>}
      {issue && day && " "}
      {day && <span className="whitespace-nowrap">{issue ? `· ${day}` : day}</span>}
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
        <span
          data-testid="plan-title"
          title={i.title}
          className={`line-clamp-2 font-semibold break-words max-[600px]:line-clamp-none ${
            i.change?.kind === "dropped" ? "text-text2 line-through decoration-1" : ""
          }`}
        >
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
          {/* qa-plan-31: a dropped item's one chip says so, "Dropped in draft 2 (was Planned)". */}
          <StateChip item={i} split />
          <DriftMarker item={i} />
        </span>
      ),
    },
    {
      key: "engineering",
      header: "Engineering",
      width: "160px",
      wrap: true,
      // Under 760 px (the Ask panel docked) the inspector says it; the other columns keep their room.
      narrow: "hide",
      className: EMPTY_ON_PHONE,
      cell: (i) => <EngineeringCell item={i} />,
    },
    { key: "next", header: "Next", width: "144px", wrap: true, className: EMPTY_ON_PHONE, cell: (i) => <NextCell item={i} me={me} onLink={onLink} /> },
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
      // qa-plan-31 (fix4): "Now · 7" in one span, so a flex row on a phone cannot drop the space.
      groupLabel={(g) => (
        <span>
          {g}
          <span className="text-text2"> · </span>
          <span className="tnum text-accent-ink">{counts.get(g)}</span>
        </span>
      )}
      groupProps={() => ({ "data-testid": "plan-group" })}
      rowProps={(i) => ({ "data-testid": "plan-row", "data-origin": i.origin, "data-item": i.key })}
      empty="No roadmap items yet"
    />
  );
}
