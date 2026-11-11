/**
 * roadmap-milestone-codes: the API's oracle.simple.roadmap_codes.assign, as the mock reads it.
 * Every milestone of a roadmap read gets one code M1, M2, M3 ... by date across the read
 * (undated last; one date: goal order, no goal last, then name); a goal milestone that is the
 * same milestone as a track milestone (one of its code holding items on its roadmap: the one, for
 * one of no goal, else one whose name it leads or follows, whatever else of the code is there)
 * or as a PRD's (or the roadmap's own) milestone of its code with a name that matches shares its code;
 * a goal's own milestone whose name matches a PRD's milestone of any code on its roadmap of its goal or
 * none too (the closest in date, then the exact name; one goal's own per PRD milestone, by goal order).
 * A joined group goes by its goal's own milestone's date (its track milestone's first, else its earliest).
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
  // One with no name matches only as its roadmap's only one of its code (a bare "M3" never takes every goal's M3).
  const days = (iso: string) => Date.parse(`${iso.slice(0, 10)}T00:00:00Z`) / 864e5;
  const best = (g: Gm, of: (Gm | Tm)[], alone: boolean, near = false) => {
    const name = split(g.name)[1];
    const ok = (m: Gm | Tm) => (words(name).length && words(split(m.name)[1]).length ? match(name, split(m.name)[1]) : alone);
    const same = (m: Gm | Tm) => words(split(m.name)[1]).join(" ") === words(name).join(" ");
    const gap = (m: Gm | Tm) => (near && g.date && m.date ? Math.abs(days(m.date) - days(g.date)) : Infinity);
    const by = (p: Gm | Tm, q: Gm | Tm) => (gap(p) === gap(q) ? 0 : gap(p) < gap(q) ? -1 : 1);
    const hits = of.filter(ok).sort((p, q) => by(p, q) || Number(!same(p)) - Number(!same(q)) || (p.id < q.id ? -1 : 1));
    return hits[0]?.id ?? null;
  };
  // No goal first, then a PRD's of a goal (a goal's own may join either), then a goal's own by goal order.
  const order = (g: Gm) => Number(!!g.goal_id) + Number(!!g.goal_id && !g.prd);
  const rankOf = (g: Gm) => (g.goal_id && !g.prd ? goalRank(g.goal_id) : 0);
  const prds = new Set(goals.filter((o) => !!o.prd).map((o) => o.id));
  const taken = new Set<string>(); // PRD milestones a goal's own milestone has joined
  for (const g of [...goals].sort((p, q) => order(p) - order(q) || rankOf(p) - rankOf(q) || (p.id < q.id ? -1 : 1))) {
    const code = gmCode(g);
    const there = tracks.filter((t) => !!code && split(t.name)[0] === code && !!held.get(t.id)?.has(g.roadmap_id));
    const plain = goals.filter((o) => !!code && !o.goal_id && o !== g && o.roadmap_id === g.roadmap_id && gmCode(o) === code);
    const alike = new Set(goals.filter((o) => o.roadmap_id === g.roadmap_id && gmCode(o) === code).map((o) => `${o.goal_id ?? ""}|${o.prd?.id ?? ""}`));
    const alone = alike.size === 1 && there.length === 1;
    // Goal map twins (Nov 10): a goal's own milestone is a PRD's on its roadmap of the same name, whatever the PRD's
    // code, of its goal or none ("Join only within the same goal", the owner, Nov 11).
    const twins = goals.filter((o) => !!o.prd && o !== g && o.roadmap_id === g.roadmap_id && (!o.goal_id || o.goal_id === g.goal_id));
    let to = !g.goal_id && there.length === 1 ? there[0].id : (best(g, there, alone) ?? (g.goal_id ? (best(g, plain, false) ?? (g.prd ? null : best(g, twins, false, true))) : null));
    // One goal's own milestone per PRD milestone; another stays its own.
    if (to && g.goal_id && !g.prd && prds.has(to)) {
      if (taken.has(to)) to = null;
      else taken.add(to);
    }
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
    const own = ms.flatMap((m) => ("goal_id" in m && m.goal_id && !m.prd && m.date ? [m.date] : []));
    const when = "track_id" in lead ? (lead.date ?? dates[0] ?? null) : (own[0] ?? dates[0] ?? null);
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
