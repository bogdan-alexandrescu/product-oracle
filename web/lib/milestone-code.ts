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
