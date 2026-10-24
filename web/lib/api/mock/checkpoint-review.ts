/**
 * D1 Roadmap items review: what the mock's review route (GET …/checkpoints/{id}/review, D8,
 * ./runs.ts reviewOut) reads from roadmap_items.yaml, as oracle.runs.actions does from the
 * checked file: each item's position, title, horizon, milestone, confidence, rank, outcome,
 * dependencies and PRD section. The mock's files hold one flow-style item per line
 * (`- {id: …, title: …}`); this reads that subset of YAML. Made-up data only.
 */
import type { Schemas } from "@/lib/api/client";

type Value = string | number | boolean | null | Value[] | { [key: string]: Value };

/** One flow-style value (`{a: b, c: [d]}`, `[x, y]`, `"quoted"` or a plain scalar) from `s` at `at`. */
function parseFlow(s: string, at = 0): [Value, number] {
  const skip = (i: number) => {
    while (i < s.length && s[i] === " ") i++;
    return i;
  };
  let i = skip(at);
  if (s[i] === "{") {
    const out: Record<string, Value> = {};
    i = skip(i + 1);
    while (i < s.length && s[i] !== "}") {
      const colon = s.indexOf(":", i);
      const key = s.slice(i, colon).trim();
      const [value, next] = parseFlow(s, colon + 1);
      out[key] = value;
      i = skip(next);
      if (s[i] === ",") i = skip(i + 1);
    }
    return [out, i + 1];
  }
  if (s[i] === "[") {
    const out: Value[] = [];
    i = skip(i + 1);
    while (i < s.length && s[i] !== "]") {
      const [value, next] = parseFlow(s, i);
      out.push(value);
      i = skip(next);
      if (s[i] === ",") i = skip(i + 1);
    }
    return [out, i + 1];
  }
  if (s[i] === '"') {
    const end = s.indexOf('"', i + 1);
    return [s.slice(i + 1, end), end + 1];
  }
  let end = i;
  while (end < s.length && !",}]".includes(s[end])) end++;
  const raw = s.slice(i, end).trim();
  const num = Number(raw);
  return [raw === "" || raw === "null" ? null : raw !== "" && !Number.isNaN(num) && /^[\d.]+$/.test(raw) ? num : raw, end];
}

export type FileItem = Pick<Schemas["ReviewItem"], "key" | "position" | "title" | "horizon" | "milestone" | "confidence" | "rank" | "outcome" | "depends_on" | "prd_section">;

const text = (v: Value | undefined): string | null => (v == null || typeof v === "object" ? null : String(v));

/** The file's items in order, as the review route serves them; [] when the file is not one item per line. */
export function fileItems(yaml: string): FileItem[] {
  const out: FileItem[] = [];
  for (const line of yaml.split("\n")) {
    const m = /^\s*- (\{.*\})\s*$/.exec(line);
    if (!m) continue;
    const [raw] = parseFlow(m[1]);
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || !raw.id) continue;
    const milestone = raw.milestone && typeof raw.milestone === "object" && !Array.isArray(raw.milestone) ? raw.milestone : null;
    const priority = raw.priority && typeof raw.priority === "object" && !Array.isArray(raw.priority) ? raw.priority : null;
    out.push({
      key: String(raw.id),
      position: out.length + 1,
      title: text(raw.title),
      horizon: text(raw.horizon),
      milestone: milestone ? { name: text(milestone.name), date: text(milestone.date) } : null,
      confidence: text(raw.confidence),
      rank: typeof priority?.rank === "number" ? priority.rank : null,
      outcome: text(raw.outcome),
      depends_on: Array.isArray(raw.depends_on) ? raw.depends_on.map(String) : [],
      prd_section: text(raw.prd_section),
    });
  }
  return out;
}
