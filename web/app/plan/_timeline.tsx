"use client";

import { useMemo } from "react";

import { InfoTip, Notice } from "@/components/ds";
import { usePhone } from "@/components/simple/PrdTimeline";
import { Loading } from "@/components/ui";
import { api, unwrap } from "@/lib/api/client";
import { useQuery } from "@/lib/use-query";

import { setRoadmapToday, type Item, type Roadmap } from "../simple/roadmap/_lib";
import { Chart } from "../simple/roadmap/_timeline";
import type { GoalView } from "../home/_goals";
import type { PlanItem } from "./_lib";
import { grouped, type GroupBy } from "./_table";

const none = () => {};

/** The Simple roadmap's item for a Plan row: the same item by its id, else by its roadmap and key (keys are unique per roadmap). */
export function timelineMatch(rows: PlanItem[], items: Item[]): Map<string, Item> {
  const byId = new Map(items.map((i) => [i.id, i]));
  const byKey = new Map(items.map((i) => [`${i.roadmap.slug}|${i.key}`, i]));
  const out = new Map<string, Item>();
  for (const r of rows) {
    const hit = byId.get(r.id) ?? byKey.get(`${r.roadmap.slug}|${r.key}`);
    if (hit) out.set(r.id, hit);
  }
  return out;
}

/**
 * B-26: the Plan's rows against their dates, drawn by Simple's roadmap chart as its Timeline
 * (read only): the same items the table lists (the Show bar's scope), in the same groups, with their
 * dates, milestones, dependencies and Today's line from GET /v1/simple/roadmap. A bar opens
 * the item in the Plan's inspector; a row the roadmap holds no dates for is listed below.
 */
export function PlanTimeline({
  items,
  by,
  tags,
  prdOrder,
  selected,
  onSelect,
}: {
  items: PlanItem[] | undefined;
  by: GroupBy;
  tags: Map<string, GoalView>;
  prdOrder: string[];
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  const phone = usePhone();
  const q = useQuery("plan|timeline|simple-roadmap", () =>
    unwrap(api.GET("/v1/simple/roadmap", {})).then((d) => {
      setRoadmapToday(d.today);
      return d;
    }),
  );
  const drawn = useMemo(() => {
    if (!q.data || !items) return null;
    const { rows, group } = grouped(items, by, tags, prdOrder);
    const match = timelineMatch(rows, q.data.items);
    const plan = new Map([...match].map(([planId, it]) => [it.id, planId]));
    const groups: Roadmap["groups"] = [];
    const used = new Set<string>();
    for (const r of rows) {
      const it = match.get(r.id);
      if (!it || used.has(it.id)) continue;
      used.add(it.id);
      const title = group(r);
      const g = groups.find((x) => x.title === title) ?? (groups.push({ key: `plan-group:${title}`, title, item_ids: [] }), groups.at(-1)!);
      g.item_ids.push(it.id);
    }
    const data: Roadmap = { ...q.data, items: q.data.items.filter((i) => used.has(i.id)), groups };
    return { data, plan, match, undated: rows.filter((r) => !match.has(r.id)) };
  }, [q.data, items, by, tags, prdOrder]);

  if (q.error) return <Notice tone="error">{q.error}</Notice>;
  if (!drawn) return <Loading />;
  const pick = (it: Item) => {
    const id = drawn.plan.get(it.id);
    if (id) onSelect(id);
  };
  return (
    <div data-testid="plan-timeline" className="flex min-w-0 flex-col gap-3 p-3 max-[600px]:p-1.5">
      {drawn.data.items.length > 0 ? (
        <Chart
          data={drawn.data}
          lane={by === "prd" ? "prd" : by === "goal" ? "goal" : "track"}
          laneWord={by === "horizon" ? "Horizon" : by === "goal" ? "Goal" : "PRD"}
          format="timeline"
          unit="week"
          compact={phone}
          canDrag={false}
          moved={{}}
          open={selected ? (drawn.match.get(selected)?.id ?? null) : null}
          onOpen={pick}
          onMove={none}
          onKeyMove={none}
          onKeyEnd={none}
          onKeyCancel={none}
          onSuggestion={pick}
        />
      ) : (
        <p data-testid="plan-timeline-empty" className="px-1 text-[15px] text-text2">
          No dated items yet
        </p>
      )}
      {drawn.undated.length > 0 && (
        <section data-testid="plan-timeline-undated" aria-label="Not on the timeline" className="flex flex-col gap-1.5">
          <h3 className="flex items-center gap-1.5 text-sm font-semibold text-text2">
            Not on the timeline · <span className="tnum text-accent-ink">{drawn.undated.length}</span>
            <InfoTip label="Not on the timeline">
              The roadmap has no dates for these items yet, such as a draft&apos;s new items. Pick one to see it.
            </InfoTip>
          </h3>
          <ul className="flex flex-wrap gap-1.5">
            {drawn.undated.map((r) => (
              <li key={r.id}>
                <button
                  type="button"
                  data-testid="plan-timeline-undated-item"
                  data-id={r.id}
                  aria-pressed={selected === r.id}
                  onClick={() => onSelect(r.id)}
                  className={`inline-flex min-h-8 items-center rounded-lg border px-2.5 text-sm font-semibold ${
                    selected === r.id ? "border-accent bg-accent-soft" : "border-line-strong hover:bg-surface2"
                  } ${r.origin === "draft" ? "border-dashed" : ""}`}
                >
                  {r.title}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
