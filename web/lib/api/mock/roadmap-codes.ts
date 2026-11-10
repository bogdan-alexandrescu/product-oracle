/**
 * roadmap-milestone-codes: the API's oracle.simple.roadmap_codes.assign, as the mock reads it.
 * Every milestone of a roadmap read gets one code M1, M2, M3 ... by date across the read
 * (undated last; one date: goal order, no goal last, then name); a goal milestone that is the
 * same milestone as a track milestone (one of its code holding items on its roadmap: the one, for
 * one of no goal, else one whose name it leads or follows, whatever else of the code is there)
 * or as a PRD's (or the roadmap's own) milestone of its code with a name that matches shares its code.
 */
import type { Schemas } from "@/lib/api/client";

type Gm = Schemas["SimpleGoalMilestone"];
type Tm = Schemas["SimpleMilestone"];
type It = { id: string; roadmap: { id: string }; milestone?: { record_id?: string | null } | null };

const CODE = /^(M\d{1,2})(?![\w.])\s*[·:\-–—]?\s*(.*)$/i;
const split = (name: string): [string | null, string] => {
  const m = CODE.exec(name.trim());
  return m ? [m[1].toUpperCase(), m[2].trim()] : [null, name.trim()];
};
// A name with one pair of brackets round it reads without them ("[Launch (beta)]"), as the API's _unwrap.
const unwrap = (name: string) => {
  const n = name.trim();
  const pair = (n[0] === "[" && n.endsWith("]")) || (n[0] === "(" && n.endsWith(")"));
  return n.length > 1 && pair && /^[^[\]()]*(?:(?:\[[^[\]]*\]|\([^()]*\))[^[\]()]*)*$/.test(n.slice(1, -1)) ? n.slice(1, -1).trim() : n;
};
const words = (n: string) => unwrap(n).toLowerCase().split(/\s+/).filter(Boolean);
const match = (a: string, b: string) => {
  const [x, y] = [words(a), words(b)].sort((p, q) => p.length - q.length);
  return x.every((w, k) => w === y[k]);
};
const gmCode = (g: Gm) => g.code.trim().toUpperCase() || split(g.name)[0];

export function withRoadmapCodes<T extends { goal_milestones?: Gm[]; milestones: Tm[]; items: It[] }>(out: T, goalRank: (goalId: string) => number): T {
  const goals = out.goal_milestones ?? [];
  const tracks = out.milestones.filter((m) => m.status !== "dropped" && !(m.start_date && m.end_date));
  for (const m of [...goals, ...out.milestones]) m.roadmap_code = null;
  const roadmapOf = new Map(out.items.map((i) => [i.id, i.roadmap.id]));
  const held = new Map<string, Set<string>>();
  const hold = (id: string, roadmap: string) => held.set(id, (held.get(id) ?? new Set()).add(roadmap));
  for (const i of out.items) if (i.milestone?.record_id) hold(i.milestone.record_id, i.roadmap.id);
  for (const t of tracks) for (const x of t.item_ids) if (roadmapOf.has(x)) hold(t.id, roadmapOf.get(x)!);
  const groups = new Map<string, (Gm | Tm)[]>(tracks.map((t) => [t.id, [t]]));
  // Join whenever names match (the owner, Nov 9): a goal's milestone is the track's (or a PRD's, or
  // the roadmap's own) milestone of its code on its roadmap whose name it leads or follows.
  const into = new Map<string, string>();
  const best = (g: Gm, of: (Gm | Tm)[]) => {
    const name = split(g.name)[1];
    const same = (m: Gm | Tm) => words(split(m.name)[1]).join(" ") === words(name).join(" ");
    const hits = of.filter((m) => match(name, split(m.name)[1])).sort((p, q) => Number(!same(p)) - Number(!same(q)) || (p.id < q.id ? -1 : 1));
    return hits[0]?.id ?? null;
  };
  for (const g of [...goals].sort((p, q) => Number(!!p.goal_id) - Number(!!q.goal_id) || (p.id < q.id ? -1 : 1))) {
    const code = gmCode(g);
    const there = tracks.filter((t) => !!code && split(t.name)[0] === code && !!held.get(t.id)?.has(g.roadmap_id));
    const plain = goals.filter((o) => !!code && !o.goal_id && o !== g && o.roadmap_id === g.roadmap_id && gmCode(o) === code);
    let to = !g.goal_id && there.length === 1 ? there[0].id : (best(g, there) ?? (g.goal_id ? best(g, plain) : null));
    if (!to) {
      groups.set(g.id, [g]);
      continue;
    }
    to = into.get(to) ?? to;
    into.set(g.id, to);
    groups.set(to, [...(groups.get(to) ?? []), g]);
  }
  const far = 1e9;
  const key = (ms: (Gm | Tm)[]) => {
    const lead = ms[0];
    const dates = ms.flatMap((m) => (m.date ? [m.date] : [])).sort();
    const when = lead.date ?? dates[0] ?? null;
    const rank = Math.min(far, ...ms.flatMap((m) => ("goal_id" in m && m.goal_id ? [goalRank(m.goal_id)] : [])));
    const name = "track_id" in lead ? split(lead.name)[1] : lead.name;
    return { when, rank, name: name.toLowerCase(), id: lead.id };
  };
  const cmp = (a: ReturnType<typeof key>, b: ReturnType<typeof key>) =>
    (a.when === null ? 1 : 0) - (b.when === null ? 1 : 0) || (a.when ?? "").localeCompare(b.when ?? "") || a.rank - b.rank || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) || (a.id < b.id ? -1 : 1);
  [...groups.values()]
    .map((ms) => ({ ms, k: key(ms) }))
    .sort((a, b) => cmp(a.k, b.k))
    .forEach(({ ms }, n) => ms.forEach((m) => (m.roadmap_code = `M${n + 1}`)));
  return out;
}
