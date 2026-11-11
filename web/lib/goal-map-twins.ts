/**
 * Goal map twins (the owner's "Join whenever names match", Nov 9): a PRD's milestone the roadmap
 * read codes as one with a goal's own milestone on the map (oracle.simple.roadmap_codes) is that
 * milestone, so the map draws it once: the goal's own card, holding the twin's features and gaps.
 * `also` gives each kept card the twin's name when it differs (its (i)).
 */
import type { Schemas } from "@/lib/api/client";
import type { GoalMap } from "@/lib/api/mock/goal-map";

type Read = Pick<Schemas["SimpleGoalMilestone"], "id" | "roadmap_code" | "prd" | "name">;

export function joinTwins(map: GoalMap, read: Read[] | undefined): { map: GoalMap; also: Map<string, string> } {
  const also = new Map<string, string>();
  const of = new Map((read ?? []).map((m) => [m.id, m]));
  // Each code's goal's own milestone on the map (no PRD), then each PRD milestone sharing its code.
  const own = new Map<string, string>();
  for (const m of map.milestones) {
    const r = of.get(m.id);
    if (r?.roadmap_code && !r.prd && !own.has(r.roadmap_code)) own.set(r.roadmap_code, m.id);
  }
  const to = new Map<string, string>();
  for (const m of map.milestones) {
    const r = of.get(m.id);
    const keep = r?.prd && r.roadmap_code ? own.get(r.roadmap_code) : undefined;
    if (!keep || keep === m.id) continue;
    to.set(m.id, keep);
    const kept = map.milestones.find((x) => x.id === keep)!;
    if (m.name.trim().toLowerCase() !== kept.name.trim().toLowerCase()) also.set(keep, m.name);
  }
  if (!to.size) return { map, also };
  const at = (id: string) => to.get(id) ?? id;
  const once = (ids: string[]) => [...new Set(ids.map(at))];
  return {
    map: {
      ...map,
      milestones: map.milestones.filter((m) => !to.has(m.id)).map((m) => ({ ...m, depends: once(m.depends).filter((d) => d !== m.id) })),
      features: map.features.map((f) => ({
        ...f,
        milestones: once(f.milestones),
        links: f.links.map((l) => ({ ...l, milestone: at(l.milestone) })).filter((l, i, all) => all.findIndex((x) => x.milestone === l.milestone) === i),
      })),
      gaps: map.gaps.filter((g) => !to.has(g.milestone ?? "")),
    },
    also,
  };
}
