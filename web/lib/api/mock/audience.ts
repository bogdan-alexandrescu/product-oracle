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
 * "Owned by …", "Owner — …", "Tech lead:", "PM:", "Owner / PM:", "Who:", "*Owner*:" on
 * Board, a name whole past its initials and titles; "Tracker: …", "Jira:", "Estimate: …",
 * "Story points:", "Est.:" where the audience does not show them; revenue for
 * Engineering) and so-headed table columns ("Owner(s)", "Est.", "Tech lead"), reading
 * tables as GFM does. A table keeps its header and delimiter rows. `redact` is the API's
 * variants.redact case for case (api/tests/fixtures/audience_redaction.json).
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
  assignee: "owner", assignees: "owner", "assigned to": "owner", pm: "owner", pms: "owner", who: "owner",
  "product manager": "owner", "product owner": "owner",
  tracker: "tracker", "tracker key": "tracker", "tracker keys": "tracker", issue: "tracker", issues: "tracker",
  epic: "tracker", epics: "tracker", jira: "tracker", ticket: "tracker", tickets: "tracker",
  estimate: "effort", estimates: "effort", est: "effort", effort: "effort", "story points": "effort",
  points: "effort", size: "effort", "depends on": "depends_on", dependencies: "depends_on",
};
const BARE_LABELS = ["owned by", "assigned to"];
// Words that qualify an owner label ("Tech lead", "Eng lead", "Lead PM"); only owner labels take them.
const QUALIFIERS = ["tech", "technical", "eng", "engineering", "product", "design", "project", "program", "delivery", "team", "lead", "co"];
const OWNER_CORE = ["lead", "leads", "owner", "owners", "pm", "pms", "dri", "manager"];
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const EMPH = "(?:\\*\\*|__|\\*|_)?";
const ONE_LABEL =
  `(?:(?:${QUALIFIERS.join("|")})\\s+)+(?:${OWNER_CORE.join("|")})|` +
  Object.keys(LABELS).filter((k) => !BARE_LABELS.includes(k)).sort((a, b) => b.length - a.length).map(escape).join("|") +
  "|revenue[\\w ]{0,20}?";
// One label, or several joined by "/" ("Owner / PM").
const ONE = `(?:${ONE_LABEL})(?![^\\W_])(?:\\(s\\))?\\.?`;
const PART = new RegExp(
  `(?<![\\w-])${EMPH}(?:(?<label>${ONE}(?:\\s*/\\s*${ONE})*)${EMPH}(?:\\s*\\([^()\\n]{1,24}\\))?${EMPH}\\s*(?::|—|–|\\s-\\s)${EMPH}` +
    "|(?<bare>" + BARE_LABELS.join("|") + ")\\s+)[ \\t]*",
  "gi",
);
// A full stop inside a name: an initial ("Dana M. Markerson") or a title ("Dr. Markerson").
const NAME_STOPS = new Set(["dr", "mr", "mrs", "ms", "mx", "prof", "jr", "sr", "st"]);
// A table's delimiter row (GFM): cells of one or more dashes with optional colons.
const TABLE_SEP = /^ {0,3}(?!-\s)[-:| ]*-[-:| ]*$/;
const DELIM_CELL = /^:?-+:?$/;
// Lines that end a table's body (GFM): a heading, quote, fence, list item or rule.
const BLOCK_START = /^ {0,3}(?:#{1,6}(?:\s|$)|>|```|~~~|[-*+](?:\s|$)|\d{1,9}[.)](?:\s|$)|(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$)/;
// A table's key column: the first so headed, else the first column.
const KEY_HEADERS = new Set(["item", "items", "bet", "bets", "title", "feature", "features", "pitch", "pitches", "idea", "ideas", "initiative", "project", "name"]);
const LIST_ITEM = /^(\s*)(?:[-*+]|\d+[.)])\s+/;
const SENTENCE_END = /(?<=[.;!?])\s+/;
// What may follow an item's title in its own entry: nothing, or a closing emphasis or link, then a separator.
const ENTRY_END = /^(?:[*_]+|\](?:\([^)]*\))?)*(?:\s*$|\s*[:.(]|\s+[—–-](?:\s|$))/;

/** The fields a label or column header names ("Owner(s)", "Est.", "Tech lead", "Lead PM", "Owner / PM"). */
function labelFields(label: string): Set<string> {
  const out = new Set<string>();
  for (const part of label.replace(/\(s\)|\([^()]*\)\s*$|[*_]/g, "").split("/")) {
    let words = part.replace(/^[ .:\t]+|[ .:\t]+$/g, "").toLowerCase().replace(/\s+/g, " ").split(" ");
    if (words[0].startsWith("revenue")) {
      out.add("revenue");
      continue;
    }
    let qualified = false;
    while (words.length > 1 && !(words.join(" ") in LABELS) && QUALIFIERS.includes(words[0])) {
      words = words.slice(1);
      qualified = true;
    }
    const field = LABELS[words.join(" ")];
    if (field && (!qualified || OWNER_CORE.includes(words.join(" ")))) out.add(field);
    else if (qualified && words.join(" ") === "manager") out.add("owner");
  }
  return out;
}

function hiddenFields(audience: Audience): Set<string> {
  const fields = new Set(AUDIENCES.find((a) => a.key === audience)!.item_fields);
  const out = new Set(["tracker", "effort", "depends_on"].filter((f) => !fields.has(f)));
  if (audience === "board") out.add("owner");
  if (fields.has("effort")) out.add("revenue");
  return out;
}

function splitRow(line: string): string[] {
  let inner = line.trim();
  if (inner.startsWith("|")) inner = inner.slice(1);
  if (inner.endsWith("|") && !inner.endsWith("\\|")) inner = inner.slice(0, -1);
  return inner.split(/(?<!\\)\|/).map((c) => c.trim());
}

const joinRow = (cells: string[]) => `| ${cells.join(" | ")} |`;
const indent = (line: string) => line.length - line.replace(/^ +/, "").length;
const isFence = (line: string) => /^\s*(?:```|~~~)/.test(line);

function isDelim(line: string, columns: number): boolean {
  if (!TABLE_SEP.test(line)) return false;
  const cells = splitRow(line);
  return cells.length === columns && cells.every((c) => DELIM_CELL.test(c));
}

/** Each line's part in a GFM table, from the table's own structure (as the API's _table_rows). */
function tableRows(lines: string[]): ([string, string[]] | null)[] {
  const out: ([string, string[]] | null)[] = lines.map(() => null);
  let fence = false;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (isFence(line)) fence = !fence;
    if (fence || indent(line) >= 4 || !/(?<!\\)\|/.test(line) || !isDelim(lines[i + 1] ?? "", splitRow(line).length)) {
      i++;
      continue;
    }
    const head = splitRow(line);
    out[i] = ["head", head];
    out[i + 1] = ["delim", head];
    i += 2;
    while (i < lines.length && lines[i].trim() && !BLOCK_START.test(lines[i]) && indent(lines[i]) < 4) {
      out[i] = ["body", head];
      i++;
    }
  }
  return out;
}

function keyColumn(head: string[]): number {
  const at = head.findIndex((h) => KEY_HEADERS.has(h.replace(/[*_]/g, "").replace(/^[ .:]+|[ .:]+$/g, "").toLowerCase()));
  return at < 0 ? 0 : at;
}

const mentions = (line: string, name: string) => new RegExp(`(?<!\\w)${escape(name)}(?!\\w)`, "i").test(line);

/** Where a labelled value starting at `i` ends: `;`, `|`, a tag, `closer` or a sentence's full stop (a name runs past an initial or a title). */
function valueEnd(text: string, i: number, field: string, closer: string | null): number {
  for (; i < text.length; i++) {
    const c = text[i];
    if (c === ";" || c === "|" || c === "\n" || c === closer || (c === "<" && /^<\/?[A-Za-z]/.test(text.slice(i, i + 3)))) return i;
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
    const fields = [...labelFields(m.groups!.label ?? m.groups!.bare)].filter((f) => hidden.has(f));
    const before = text.slice(0, m.index).replace(/[ \t]+$/, "");
    const end0 = m.index + m[0].length;
    if (!fields.length || /[\p{L}\p{N}]$/u.test(before)) {
      out += text.slice(pos, end0);
      pos = end0;
      PART.lastIndex = pos;
      continue;
    }
    const field = fields.includes("owner") ? "owner" : fields.sort()[0];
    const closer = before.endsWith("(") ? ")" : null;
    let end = valueEnd(text, end0, field, closer);
    if (closer && text[end] === ")") {
      // "(Owner: Dana)": the brackets go with it, the space after them stays.
      out += text.slice(pos, m.index).replace(/[ \t]+$/, "").slice(0, -1).replace(/[ \t]+$/, "");
      pos = end + 1;
    } else {
      let head = text.slice(pos, m.index);
      const stop = text[end] === "." || text[end] === ";" ? text[end] : "";
      if (stop) end++;
      while (text[end] === " " || text[end] === "\t") end++;
      const rest = text.slice(end);
      if (!rest.trim() || rest.startsWith("|") || rest.startsWith("<")) {
        // The part ended the line, cell or element: no dangling space or dash.
        let trimmed = head.replace(/[ \t]*(?:[—–:,]|\s-)?[ \t]*$/, "");
        const bare = head.replace(/[ \t]+$/, "");
        if (trimmed !== bare && stop === ".") trimmed += ".";
        if (rest.startsWith("<") || trimmed !== bare) head = trimmed;
      }
      out += head;
      pos = end;
    }
    PART.lastIndex = pos;
  }
  return out + text.slice(pos);
}

/** A line or a cell without its hidden labelled parts and the sentences naming a hidden tracker issue. */
function redactPart(text: string, hidden: Set<string>, refs: string[]): string {
  let next = stripParts(text, hidden);
  if (refs.some((r) => mentions(next, r))) {
    next = next.split(SENTENCE_END).filter((p) => !refs.some((r) => mentions(p, r))).join(" ");
  }
  return next === text ? text : next.trimEnd();
}

/** Whether a line (or a table's key cell) is an entry keyed by a dropped item's whole title, not a line merely containing the word. */
function namesDropped(text: string, dropTitles: string[]): boolean {
  const lead = text.replace(LIST_ITEM, "").trimStart().replace(/^(?:\*\*|__|\[)+/, "").toLowerCase();
  return dropTitles.some((title) => {
    const t = title.trim().toLowerCase();
    return !!t && lead.startsWith(t) && ENTRY_END.test(lead.slice(t.length));
  });
}

/**
 * Written item text without what `audience` hides (as the API's variants.redact): hidden table columns and
 * labelled parts, sentences naming a hidden tracker issue (`refs`), and the entries of `dropTitles` (Board's
 * goal-less items) with a dropped bullet's wrapped lines. A table keeps its header and delimiter rows.
 */
export function redact(text: string, audience: Audience, refs: string[] = [], dropTitles: string[] = []): string {
  const hidden = hiddenFields(audience);
  if (!hidden.has("tracker")) refs = [];
  const lines = text.split("\n");
  const rows = tableRows(lines);
  const out: string[] = [];
  let fence = false;
  let dropped: number | null = null; // the indent of a dropped bullet, while its lines run on
  lines.forEach((line, n) => {
    const row = rows[n];
    if (row) {
      dropped = null;
      const [kind, head] = row;
      const drop = new Set(head.flatMap((h, i) => ([...labelFields(h)].some((f) => hidden.has(f)) ? [i] : [])));
      let cells = splitRow(line);
      if (kind === "body") {
        const key = keyColumn(head);
        if (key < cells.length && namesDropped(cells[key], dropTitles)) return;
        cells = cells.map((c) => redactPart(c, hidden, refs));
      }
      const kept = cells.filter((_, i) => !drop.has(i));
      if (drop.size === head.length) return; // every column hidden: the table goes
      out.push(kept.join("\u0000") === splitRow(line).join("\u0000") ? line : joinRow(kept));
      return;
    }
    if (isFence(line)) fence = !fence;
    if (fence || isFence(line) || !line.trim()) {
      dropped = null;
      out.push(line);
      return;
    }
    const bullet = LIST_ITEM.exec(line);
    if (dropped !== null) {
      if (!(bullet && bullet[1].length <= dropped)) return;
      dropped = null;
    }
    if (namesDropped(line, dropTitles)) {
      if (bullet) dropped = bullet[1].length;
      return;
    }
    const kept = redactPart(line, hidden, refs);
    if (kept !== line && !kept.replace(/[ \-*+\t]/g, "")) return;
    out.push(kept);
  });
  return out.join("\n").replace(/^\n+|\n+$/g, "");
}

/** The sections of one rendering in `audience` (see the file comment). */
export function audienceSections<S extends Section>(sections: S[], audience: Audience): S[] {
  const hidden = new Set(AUDIENCES.find((a) => a.key === audience)!.hidden_sections);
  const out: S[] = [];
  let skip: number | null = null;
  let leftOut = 0;
  let area: number | null = null;
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
    const body_md = redact(s.body_md, audience);
    out.push(body_md === s.body_md ? s : { ...s, body_md, body_text: redact(s.body_text, audience) });
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
