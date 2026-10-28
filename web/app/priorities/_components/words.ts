/**
 * The priorities page's words for what the scorer writes as code: input names, MoSCoW
 * categories, formulas, score steps, the confidence line, evidence refs and scores.
 */
import type { Schemas } from "@/lib/api/client";
import { SOURCE_LABEL, formatDate, plural } from "@/lib/format";
import { docLabel } from "@/lib/labels";

type Method = Schemas["PriorityRanking"]["method"];

/** A scorer input (or the feature attribute it was read from) in words. */
const INPUT_LABEL: Record<string, string> = {
  effort: "Effort",
  effort_weeks: "Effort in weeks",
  reach: "Reach",
  impact: "Impact",
  confidence: "Confidence",
  business_value: "Business value",
  user_business_value: "Business value",
  time_criticality: "Time criticality",
  risk_reduction: "Risk reduction",
  opportunity_enablement: "Opportunity enablement",
  job_size: "Job size",
  goal_value: "Goal value",
  moscow: "MoSCoW",
};

export const inputLabel = (name: string): string => {
  const words = INPUT_LABEL[name];
  if (words) return words;
  const s = name.replace(/_/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
};

/** MoSCoW's categories by name. */
export const MOSCOW_LABEL: Record<string, string> = {
  must: "Must have",
  should: "Should have",
  could: "Could have",
  wont: "Won't have",
  "won't": "Won't have",
};

/** Each method's formula in words (the API's FORMULAS, read aloud). */
const FORMULA_TEXT: Record<Method, string> = {
  goal_weighted: "Score = sum of (goal weight × contribution) × confidence × track record ÷ effort",
  rice: "Score = reach × impact × confidence ÷ effort",
  moscow: "Must have (4), then Should have (3), Could have (2), Won't have (1); ties broken by goal value",
  wsjf: "Score = (business value + time criticality + risk reduction) ÷ job size",
};

export const formulaText = (method: string, fallback: string): string =>
  (FORMULA_TEXT as Record<string, string>)[method] ?? fallback;

/** One decimal (two under 1), thousands separated: 5,400 · 562.5 · 8.1 · 0.33. */
export function formatScore(n: number | null | undefined): string {
  if (n == null) return "—";
  return n.toLocaleString("en-US", { maximumFractionDigits: n !== 0 && Math.abs(n) < 1 ? 2 : 1 });
}

/**
 * Every standalone number in a step, in the Score column's style ("5,400", "83.3"): never a
 * raw figure or one stuck at two decimals. A goal's key ("g.activation") has no digits, so it
 * is left alone; a number already turned into a percent ("60%") keeps its sign.
 */
function fmtNums(s: string): string {
  return s.replace(/(?<![\w.])\d+(?:\.\d+)?(?![\w%])/g, (n) => formatScore(Number(n)));
}

/** A step the scorer wrote, with category names and input names in words. */
export function stepWords(step: string): string {
  const moscow = step.match(/^(must|should|could|won't|wont) = (\d+); tie-break goal value (.+)$/);
  if (moscow) {
    return fmtNums(`${MOSCOW_LABEL[moscow[1]!]} = ${moscow[2]}; ties broken by goal value ${moscow[3]}`);
  }
  const named = step.match(/^(score|goal value|cost of delay|confidence) = /);
  if (named) return fmtNums(named[1]!.charAt(0).toUpperCase() + step.slice(1));
  const missing = step.match(/^not scored: missing (.+)$/);
  if (missing) return `Not scored: no ${missing[1]!.split(/,\s*/).map(inputLabel).join(", ")}`;
  return fmtNums(step);
}

/** An input's value in words: a MoSCoW category by name, a number in the page's style. */
export function inputValueText(name: string, v: unknown): string {
  if (v == null) return "—";
  if (name === "moscow" && typeof v === "string") return MOSCOW_LABEL[v] ?? v;
  if (typeof v === "number") return formatScore(v);
  if (typeof v === "object") return "—";
  return String(v);
}

/** Confidence 0-1 as 0-100: the one scale the page shows it in. */
const pct = (n: number) => Math.round(n * 100);

/** How the confidence was worked out, on the page's 0-100 scale: "Average of 1 evidence item: 60". */
export function confidenceWords(c: Schemas["ConfidenceUsed"]): string {
  const v = pct(c.value);
  switch (c.source) {
    case "evidence":
      return `Average of ${plural(c.evidence.length, "evidence item")}: ${v}`;
    case "baseline":
      return `Stored on the feature (no scored evidence): ${v}`;
    case "attrs":
      return `Set on the feature: ${v}`;
    default:
      return `No evidence and none set on the feature: ${v} assumed`;
  }
}

/** Kinds of source the API names that SOURCE_LABEL has no entry for. */
const MORE_SOURCES: Record<string, string> = {
  google_docs: "Google Docs",
  private_source: "Private source",
  link: "Link",
  manual: "Added by hand",
  priority_override: "A person's change",
};

/** A kind of source by name: "github:issue" → "GitHub". */
export function sourceName(kind: string | null | undefined): string | null {
  if (!kind) return null;
  const base = kind.split(":")[0]!;
  return (SOURCE_LABEL as Record<string, string>)[base] ?? MORE_SOURCES[base] ?? base.replace(/_/g, " ");
}

/** "2026-08-30" (or a full timestamp) as "Aug 30, 2026". */
export const dayText = (d: string | null | undefined): string | null =>
  d ? formatDate(d.length === 10 ? `${d}T12:00:00Z` : d) : null;

const NOUN: Record<string, string> = {
  issue: "Issue",
  pull_request: "Pull request",
  pr: "Pull request",
  commit: "Commit",
};

/**
 * A ref as words: "svc-backend#920" → "Pull request #920 in svc-backend" (by the source's
 * kind), "pyproject.toml:11-60" → "Lines 11–60 of pyproject.toml", a URL → "Link on host".
 */
export function refWords(ref: string, kind?: string | null): string {
  const s = ref.trim();
  const numbered = s.match(/^(?:[\w.-]+\/)?([\w.-]+)#(\d+)$/);
  if (numbered) {
    const sub = kind?.split(":")[1];
    const noun = (sub && NOUN[sub]) || "Issue or pull request";
    return `${noun} #${numbered[2]} in ${numbered[1]}`;
  }
  const lines = s.match(/^([^\s:]+\.[\w]+):(\d+)(?:-(\d+))?$/);
  if (lines) {
    const file = lines[1]!.split("/").pop();
    return lines[3] ? `Lines ${lines[2]}–${lines[3]} of ${file}` : `Line ${lines[2]} of ${file}`;
  }
  const url = s.match(/^https?:\/\/([^/\s?#]+)/i);
  if (url) return `Link on ${url[1]!.replace(/^www\./, "")}`;
  return s;
}

/** A piece of evidence by its source's title, else its ref in words. */
export function evidenceName(ev: { title?: string | null; ref?: string | null; source_kind?: string | null }): string {
  const t = ev.title?.trim();
  if (t) return refWords(t, ev.source_kind);
  if (ev.ref) return refWords(ev.ref, ev.source_kind);
  return "Evidence";
}

/** The PRD a snapshot is for, by its title ("Saved addresses PRD"), else its slug in words. */
export function prdName(doc: { title?: string | null; slug: string }): string {
  const title = doc.title?.trim();
  if (title) return docLabel({ title, kind: "prd" });
  const words = doc.slug.replace(/[-_]+/g, " ").trim();
  return docLabel({ title: words.charAt(0).toUpperCase() + words.slice(1), kind: "prd" });
}
