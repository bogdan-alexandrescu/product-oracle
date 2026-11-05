"use client";

import { useMemo } from "react";

import { InfoTip, Notice } from "@/components/ds";
import { usePhone } from "@/components/simple/PrdTimeline";
import { Loading } from "@/components/ui";
import { api, unwrap } from "@/lib/api/client";
import { useQuery } from "@/lib/use-query";

import { setRoadmapToday, type Item, type Milestone, type Roadmap } from "../simple/roadmap/_lib";
import { Chart } from "../simple/roadmap/_timeline";
import type { GoalView } from "../home/_goals";
import type { PlanItem } from "./_lib";
import { grouped, type GroupBy } from "./_table";
import { sortedMilestones, type Track } from "./_tracks";

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
 * A draft's row drawn by the roadmap item it shares a key with: at the draft's own delivery date
 * when it has one, else at the item's (approved) dates, marked so (`approved`).
 */
function draftDates(r: PlanItem, it: Item): { item: Item; approved: boolean } {
  if (r.origin !== "draft" || r.id === it.id) return { item: it, approved: false };
  const end = r.engineering.date;
  if (!end) return { item: it, approved: true };
  const start = it.start.date > end ? end : it.start.date;
  return { item: { ...it, start: { ...it.start, date: start }, end: { ...it.end, date: end, estimated: false } }, approved: false };
}

/**
 * The Plan's track milestones as the chart's milestone marks ("M1 First release" on its date), for
 * the tracks of the rows drawn; one the roadmap already marks (the same id) is not drawn twice.
 */
function trackMarks(tracks: Track[] | undefined, trackIds: Set<string>, have: Milestone[]): Milestone[] {
  const seen = new Set(have.map((m) => m.id));
  const out: Milestone[] = [];
  for (const t of tracks ?? []) {
    if (!trackIds.has(t.id)) continue;
    sortedMilestones(t).forEach((m, n) => {
      if (!m.target_date || m.status === "dropped" || seen.has(m.id)) return;
      out.push({ id: m.id, track_id: t.id, name: `M${n + 1} ${m.name}`, date: m.target_date, horizon: m.horizon, status: m.status, item_ids: [], done_when: [], targets: [] });
    });
  }
  return out;
}

/**
 * B-26: the Plan's rows against their dates, drawn by Simple's roadmap chart as its Timeline
 * (read only): the same items the table lists (the Show bar's scope), in the same groups, with their
 * dates, milestones, dependencies and Today's line from GET /v1/simple/roadmap, read again when a
 * live roadmap version moves (`live`: an approved plan change), and the Plan's track milestones.
 * A bar opens the item in the Plan's inspector; a row the roadmap holds no dates for is listed below.
 */
export function PlanTimeline({
  items,
  live,
  tracks,
  by,
  tags,
  prdOrder,
  selected,
  onSelect,
}: {
  items: PlanItem[] | undefined;
  /** The live roadmap versions ("slug@version,…"). */
  live: string;
  tracks: Track[] | undefined;
  by: GroupBy;
  tags: Map<string, GoalView>;
  prdOrder: string[];
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  const phone = usePhone();
  const q = useQuery(
    `plan|timeline|simple-roadmap|${live}`,
    () =>
      unwrap(api.GET("/v1/simple/roadmap", {})).then((d) => {
        setRoadmapToday(d.today);
        return d;
      }),
    { keepPrevious: true },
  );
  const drawn = useMemo(() => {
    if (!q.data || !items) return null;
    const { rows, group } = grouped(items, by, tags, prdOrder);
    const match = timelineMatch(rows, q.data.items);
    const plan = new Map([...match].map(([planId, it]) => [it.id, planId]));
    const groups = new Map<string, Roadmap["groups"][number]>();
    const drawnItems: Item[] = [];
    const approved = new Set<string>();
    const trackIds = new Set<string>();
    for (const r of rows) {
      const it = match.get(r.id);
      if (!it || plan.get(it.id) !== r.id) continue;
      const d = draftDates(r, it);
      drawnItems.push(d.item);
      if (d.approved) approved.add(it.id);
      if (r.track_id) trackIds.add(r.track_id);
      const title = group(r);
      let g = groups.get(title);
      if (!g) groups.set(title, (g = { key: `plan-group:${title}`, title, item_ids: [] }));
      g.item_ids.push(it.id);
    }
    const milestones = [...q.data.milestones, ...trackMarks(tracks, trackIds, q.data.milestones)];
    const data: Roadmap = { ...q.data, items: drawnItems, groups: [...groups.values()], milestones };
    return { data, plan, match, approved, undated: rows.filter((r) => !match.has(r.id)) };
  }, [q.data, items, tracks, by, tags, prdOrder]);

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
          overlay={(l, sc) =>
            drawn.data.items
              .filter((it) => drawn.approved.has(it.id) && l.y.has(it.id))
              .map((it) => (
                <span
                  key={it.id}
                  data-testid="plan-timeline-approved-dates"
                  data-item={it.key}
                  className="absolute z-[6] flex items-center"
                  style={{ left: sc.x(it.end.date) + sc.px + 4, top: l.y.get(it.id)!, height: l.rowH }}
                >
                  <InfoTip label={`the dates of ${it.title}`}>
                    The draft has no dates for this item yet, so its bar shows the approved dates.
                  </InfoTip>
                </span>
              ))
          }
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
