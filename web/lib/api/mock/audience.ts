/**
 * O5 lane 1 (as api/oracle/roadmap/variants.py): the roadmap audience registry and the
 * `audience=` parameter of a version's export and deck.
 *
 * The mock renders an audience from the version's sections: it drops the audience's
 * hidden sections (and their sub-sections) and, for Board, the item cards that serve no
 * confirmed goal, with the line "N items serve no confirmed goal and are left out". The
 * API also rebuilds the item rows from the version's roadmap items and reads "serves no
 * confirmed goal" from each item's feature-to-goal link; the mock keeps the cards as
 * written and reads it from their words. As the API, it takes out of the item areas
 * (horizons, releases, lanes, milestones, bets, pitches, ideas) the labelled parts the
 * audience hides in their common written forms ("Owner: …", "Lead:", "DRI:", "Owner (PM):",
 * "Owned by …", "Owner — …" on Board, a name whole past its initials and titles;
 * "Tracker: …", "Jira:", "Estimate: …", "Story points:", "Est.:" where the audience does
 * not show them; revenue for Engineering) and so-headed table columns ("Owner(s)",
 * "Est."). A table keeps its header and separator rows.
 */
import type { Schemas } from "@/lib/api/client";

type Audience = Schemas["AudienceOut"]["key"];
type Section = { section_key: string; level: number; heading: string; body_md: string; body_text: string };

const ALWAYS = ["layout"];
const TEAM_FIELDS = ["confidence", "depends_on", "horizon", "milestone", "outcome", "title"];

export const AUDIENCES: Schemas["AudienceOut"][] = [
  {
    key: "board",
    label: "Board",
    hidden_sections: [...ALWAYS, "sources", "changes", "risks", "dependencies", "capacity", "drift", "launch", "no-goal"].sort(),
    item_fields: ["confidence", "horizon", "outcome", "risk", "title"],
    group_by: "goal",
    max_items_per_horizon: 7,
    appendix: false,
  },
  { key: "team", label: "Team", hidden_sections: ALWAYS, item_fields: TEAM_FIELDS, group_by: "goal", max_items_per_horizon: null, appendix: true },
  {
    key: "engineering",
    label: "Engineering",
    hidden_sections: ALWAYS,
    item_fields: [...TEAM_FIELDS, "effort", "tracker"].sort(),
    group_by: "team",
    max_items_per_horizon: null,
    appendix: true,
  },
  { key: "public", label: "Public", hidden_sections: [], item_fields: [], group_by: "stage", max_items_per_horizon: null, appendix: false },
];

const NO_GOAL = "serves no confirmed goal";

export function isAudience(value: string | null): value is Audience {
  return !!value && AUDIENCES.some((a) => a.key === value);
}

export function audienceLabel(audience: Audience): string {
  return AUDIENCES.find((a) => a.key === audience)!.label;
}

/**
 * The API's refusals, in its order: Public below approver (or for a run) 403; markdown
 * 422; not a roadmap 422; Public 409 public_not_ready (lane 2 builds it).
 */
export function audienceRefusal(
  audience: string | null,
  kind: string | undefined,
  role: string,
  format: string,
): { status: number; body: unknown } | null {
  if (audience === null) return null;
  if (!isAudience(audience)) return { status: 422, body: { detail: `unknown audience '${audience}'` } };
  if (audience === "public" && role !== "owner" && role !== "approver") {
    return { status: 403, body: { detail: "The Public audience needs the approver role" } };
  }
  if (format === "md") return { status: 422, body: { detail: "markdown is the stored text; export an audience as html, pdf or pptx" } };
  if (kind !== "roadmap") return { status: 422, body: { detail: `audience is offered for roadmaps only; this is a ${kind ?? "prd"}` } };
  if (audience === "public") {
    return {
      status: 409,
      body: {
        detail: {
          code: "public_not_ready",
          message:
            "The Public version of this roadmap is built from approved public texts and needs a public check first; it is never made by removing things from the internal text",
        },
      },
    };
  }
  return null;
}

const ITEM_AREAS = new Set(["now", "next", "later", "releases", "timeline", "milestones", "current", "candidates", "ideas"]);
const LABELS: Record<string, string> = {
  owner: "owner", owners: "owner", "owned by": "owner", lead: "owner", leads: "owner", dri: "owner",
  assignee: "owner", assignees: "owner", "assigned to": "owner",
  tracker: "tracker", "tracker key": "tracker", "tracker keys": "tracker", issue: "tracker", issues: "tracker",
  epic: "tracker", epics: "tracker", jira: "tracker", ticket: "tracker", tickets: "tracker",
  estimate: "effort", estimates: "effort", est: "effort", effort: "effort", "story points": "effort",
  points: "effort", size: "effort", "depends on": "depends_on", dependencies: "depends_on",
};
const BARE_LABELS = ["owned by", "assigned to"];
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const PART = new RegExp(
  "(?<![\\w-])(?:\\*\\*|__)?(?:(?<label>" +
    Object.keys(LABELS).filter((k) => !BARE_LABELS.includes(k)).sort((a, b) => b.length - a.length).map(escape).join("|") +
    "|revenue[\\w ]{0,20}?)(?!\\w)(?:\\(s\\))?\\.?(?:\\s*\\([^()\\n]{1,24}\\))?(?:\\*\\*|__)?\\s*(?::|—|–|\\s-\\s)(?:\\*\\*|__)?" +
    "|(?<bare>" + BARE_LABELS.join("|") + ")\\s+)[ \\t]*",
  "gi",
);
// A full stop inside a name: an initial ("Dana M. Markerson") or a title ("Dr. Markerson").
const NAME_STOPS = new Set(["dr", "mr", "mrs", "ms", "mx", "prof", "jr", "sr", "st"]);
const TABLE_SEP = /^\s*\|?\s*:?-{2,}/;

function labelField(label: string): string | undefined {
  const l = label.replace(/\(s\)|\([^()]*\)\s*$|[*_]/g, "").replace(/^[\s.:]+|[\s.:]+$/g, "").toLowerCase().replace(/\s+/g, " ");
  return l.startsWith("revenue") ? "revenue" : LABELS[l];
}

function hiddenFields(audience: Audience): Set<string> {
  const fields = new Set(AUDIENCES.find((a) => a.key === audience)!.item_fields);
  const out = new Set(["tracker", "effort", "depends_on"].filter((f) => !fields.has(f)));
  if (audience === "board") out.add("owner");
  if (fields.has("effort")) out.add("revenue");
  return out;
}

function splitRow(line: string): string[] {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
}

/** Where a labelled value starting at `i` ends: `;`, `|`, `closer` or a sentence's full stop (a name runs past an initial or a title). */
function valueEnd(text: string, i: number, field: string, closer: string | null): number {
  for (; i < text.length; i++) {
    const c = text[i];
    if (c === ";" || c === "|" || c === "\n" || c === closer) return i;
    if (c === "." && (i + 1 === text.length || /\s/.test(text[i + 1]))) {
      const w = /([A-Za-z]+)$/.exec(text.slice(0, i))?.[1] ?? "";
      const nameStop = (w.length === 1 && w === w.toUpperCase()) || NAME_STOPS.has(w.toLowerCase());
      if (!(field === "owner" && nameStop && i + 1 < text.length)) return i;
    }
  }
  return text.length;
}

/** `text` without its labelled parts whose field is hidden; a label counts only where a part starts. */
function stripParts(text: string, hidden: Set<string>): string {
  let out = "";
  let pos = 0;
  PART.lastIndex = 0;
  for (let m = PART.exec(text); m; m = PART.exec(text)) {
    const field = labelField(m.groups!.label ?? m.groups!.bare) ?? "";
    const before = text.slice(0, m.index).replace(/[ \t]+$/, "");
    const end0 = m.index + m[0].length;
    if (!hidden.has(field) || /[A-Za-z0-9]$/.test(before)) {
      out += text.slice(pos, end0);
      pos = end0;
      PART.lastIndex = pos;
      continue;
    }
    const closer = before.endsWith("(") ? ")" : null;
    let end = valueEnd(text, end0, field, closer);
    if (closer && text[end] === ")") {
      out += text.slice(pos, m.index).replace(/[ \t]+$/, "").slice(0, -1).replace(/[ \t]+$/, "");
      end++;
    } else {
      out += text.slice(pos, m.index);
      if (text[end] === "." || text[end] === ";") end++;
    }
    while (text[end] === " " || text[end] === "\t") end++;
    pos = end;
    PART.lastIndex = pos;
  }
  return out + text.slice(pos);
}

/** Written item text without the labelled parts and table columns `hidden` names; tables keep their header and separator rows. */
function redact(body: string, hidden: Set<string>): string {
  const lines = body.split("\n");
  const out: string[] = [];
  let drop: Set<number> | null = null;
  lines.forEach((line, i) => {
    if (line.trimStart().startsWith("|")) {
      const head = drop === null && TABLE_SEP.test(lines[i + 1] ?? "");
      if (head) drop = new Set(splitRow(line).flatMap((h, n) => (hidden.has(labelField(h) ?? "") ? [n] : [])));
      let cells = splitRow(line);
      if (drop?.size) cells = cells.filter((_, n) => !drop!.has(n));
      if (!head && !TABLE_SEP.test(line)) cells = cells.map((c) => stripParts(c, hidden).trimEnd());
      out.push(drop?.size || cells.join("|") !== splitRow(line).join("|") ? `| ${cells.join(" | ")} |` : line);
      return;
    }
    drop = null;
    const kept = stripParts(line, hidden);
    if (kept !== line && !kept.replace(/[\s\-*+]/g, "")) return;
    out.push(kept === line ? line : kept.trimEnd());
  });
  return out.join("\n");
}

/** The sections of one rendering in `audience` (see the file comment). */
export function audienceSections<S extends Section>(sections: S[], audience: Audience): S[] {
  const hidden = new Set(AUDIENCES.find((a) => a.key === audience)!.hidden_sections);
  const out: S[] = [];
  let skip: number | null = null;
  let leftOut = 0;
  let area: number | null = null;
  const fields = hiddenFields(audience);
  for (const s of sections) {
    if (skip !== null) {
      if (s.level > skip) continue;
      skip = null;
    }
    if (area !== null && s.level <= area) area = null;
    if (area === null && ITEM_AREAS.has(s.section_key)) area = s.level;
    const goalless = s.level >= 3 && s.body_md.toLowerCase().includes(NO_GOAL);
    if (hidden.has(s.section_key) || (audience === "board" && goalless)) {
      if (!hidden.has(s.section_key)) leftOut++;
      skip = s.level;
      continue;
    }
    if (area === null) {
      out.push(s);
      continue;
    }
    const body_md = redact(s.body_md, fields);
    out.push(body_md === s.body_md ? s : { ...s, body_md, body_text: redact(s.body_text, fields) });
  }
  if (!leftOut) return out;
  const line = leftOut === 1 ? "1 item serves no confirmed goal and is left out." : `${leftOut} items serve no confirmed goal and are left out.`;
  const at = out.findIndex((s) => s.section_key === "brief-items");
  if (at >= 0) {
    const s = out[at];
    out[at] = { ...s, body_md: `${s.body_md}\n\n${line}`, body_text: `${s.body_text}\n\n${line}` };
  }
  return out;
}
