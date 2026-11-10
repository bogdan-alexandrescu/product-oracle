/**
 * roadmap-milestone-codes (the owner, Nov 9): a milestone's one code across the roadmap (M1, M2
 * ... by date), computed by the API (oracle.simple.roadmap_codes, `roadmap_code`); every page
 * shows it in place of a goal's or a track's own code.
 */
const CODE = /^(M\d{1,2})(?![\w.])\s*[·:\-–—]?\s*(.*)$/i;

/** A track milestone's name with its roadmap code in place of its own ("M1 Measured" -> "M3 Measured"). */
export function trackWords(m: { name: string; roadmap_code?: string | null }): string {
  if (!m.roadmap_code) return m.name;
  const rest = CODE.exec(m.name.trim())?.[2] ?? m.name.trim();
  return rest ? `${m.roadmap_code} ${rest}` : m.roadmap_code;
}

/** A PRD milestone's key date ("M1 Prove it") read with the milestone's roadmap code, when the roadmap lists it. */
export function keyDateWords(k: { name: string; date: string; prd?: { id: string } | null }, goalMilestones: readonly { code: string; roadmap_code?: string | null; prd?: { id: string } | null }[]): string {
  if (!k.prd) return k.name;
  const own = CODE.exec(k.name.trim())?.[1].toUpperCase();
  const m = own ? goalMilestones.find((g) => g.prd?.id === k.prd!.id && g.code.toUpperCase() === own) : undefined;
  return m ? trackWords({ name: k.name, roadmap_code: m.roadmap_code }) : k.name;
}

type Named = { name: string; roadmap_code?: string | null };
const rest = (name: string) => (CODE.exec(name.trim())?.[2] ?? name).trim().split(/\s+/).filter(Boolean).join(" ");

/**
 * Join whenever names match (the owner, Nov 9): the milestones of one roadmap code are one
 * milestone (the API joins them); it shows the longer name (more words, then more letters; a
 * track's own on a tie) and lists each other name once ("Also: M1 Measured"), so no name is hidden.
 */
export function joinedNames(goals: readonly Named[], tracks: readonly Named[]): Map<string, { name: string; also: string[] }> {
  const by = new Map<string, string[]>();
  for (const m of [...tracks, ...goals]) {
    const n = m.roadmap_code ? rest(m.name) : "";
    if (m.roadmap_code && n) by.set(m.roadmap_code, [...(by.get(m.roadmap_code) ?? []), n]);
  }
  const size = (n: string) => n.split(" ").length * 1e4 + n.length;
  return new Map(
    [...by].map(([code, names]) => {
      const name = names.reduce((a, b) => (size(b) > size(a) ? b : a));
      const also = [...new Map(names.filter((n) => n.toLowerCase() !== name.toLowerCase()).map((n) => [n.toLowerCase(), `${code} ${n}`])).values()];
      return [code, { name, also }];
    }),
  );
}

/** A milestone's words by its roadmap code and the joined milestone's name ("M1 Measured and mapped"). */
export function joinedWords(m: Named, joined: Map<string, { name: string; also: string[] }>): string {
  const j = m.roadmap_code ? joined.get(m.roadmap_code) : undefined;
  return j && m.roadmap_code ? `${m.roadmap_code} ${j.name}` : trackWords(m);
}
