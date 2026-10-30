/**
 * O5 lane 1 (as api/oracle/roadmap/variants.py): the roadmap audience registry and the
 * `audience=` parameter of a version's export and deck.
 *
 * Board (owner decision 2026-10-26) is built from the version's roadmap items alone, as the API's: a row per
 * shown item (title, outcome, confidence, goal) under Now, Next and Later, the line "N items serve no confirmed
 * goal and are left out", or a sentence when the version has no items; no written text reaches it. Team and
 * Engineering keep the written sections without the audience's hidden ones and, in the item areas (horizons,
 * releases, lanes, milestones, bets, pitches, ideas), without the labelled parts they hide ("Tracker: …",
 * "Jira:", "Estimate: …", "Story points:", "Est.:"; revenue for Engineering) and so-headed table columns,
 * reading tables as GFM does. `redact` is the API's variants.redact case for case
 * (api/tests/fixtures/audience_redaction.json).
 *
 * Board and Team group each horizon's items by goal (owner decision 2026-10-26, as the API's variants.goal_groups):
 * a sub-heading per confirmed goal the item's feature reaches in the baseline at render time (the first by title
 * when it reaches two), goals by title, then "No goal". Team's horizons are rebuilt from the items so (a card per
 * item: its outcome, goal, confidence, then the written card's text); the mock's Engineering keeps its written cards.
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
    item_fields: ["confidence", "horizon", "outcome", "title"],
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
  tracker: "tracker", "tracker key": "tracker", "tracker keys": "tracker", issue: "tracker", issues: "tracker",
  epic: "tracker", epics: "tracker", jira: "tracker", ticket: "tracker", tickets: "tracker",
  estimate: "effort", estimates: "effort", est: "effort", effort: "effort", "story points": "effort",
  points: "effort", size: "effort", "depends on": "depends_on", dependencies: "depends_on",
};
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const EMPH = "(?:\\*\\*|__|\\*|_)?";
const ONE_LABEL =
  Object.keys(LABELS).sort((a, b) => b.length - a.length).map(escape).join("|") + "|revenue[\\w ]{0,20}?";
// One label, or several joined by "/" ("Est. / Jira").
const ONE = `(?:${ONE_LABEL})(?![^\\W_])(?:\\(s\\))?\\.?`;
const PART = new RegExp(
  `(?<![\\w-])${EMPH}(?:(?<label>${ONE}(?:\\s*/\\s*${ONE})*)${EMPH}(?:\\s*\\([^()\\n]{1,24}\\))?${EMPH}\\s*(?::|—|–|\\s-\\s)${EMPH})[ \\t]*`,
  "gi",
);
// A table's delimiter row (GFM): cells of one or more dashes with optional colons.
const TABLE_SEP = /^ {0,3}(?!-\s)[-:| ]*-[-:| ]*$/;
const DELIM_CELL = /^:?-+:?$/;
// Lines that end a table's body (GFM): a heading, quote, fence, list item or rule.
const BLOCK_START = /^ {0,3}(?:#{1,6}(?:\s|$)|>|```|~~~|[-*+](?:\s|$)|\d{1,9}[.)](?:\s|$)|(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$)/;
const SENTENCE_END = /(?<=[.;!?])\s+/;

/** The fields a label or column header names ("Est.", "Estimate (days)", "**Jira**", "Est. / Jira"). */
function labelFields(label: string): Set<string> {
  const out = new Set<string>();
  for (const part of label.replace(/\(s\)|\([^()]*\)\s*$|[*_]/g, "").split("/")) {
    const words = part.replace(/^[ .:\t]+|[ .:\t]+$/g, "").toLowerCase().replace(/\s+/g, " ").split(" ");
    if (words[0].startsWith("revenue")) {
      out.add("revenue");
      continue;
    }
    const field = LABELS[words.join(" ")];
    if (field) out.add(field);
  }
  return out;
}

function hiddenFields(audience: Audience): Set<string> {
  const fields = new Set(AUDIENCES.find((a) => a.key === audience)!.item_fields);
  const out = new Set(["tracker", "effort", "depends_on"].filter((f) => !fields.has(f)));
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

const mentions = (line: string, name: string) => new RegExp(`(?<!\\w)${escape(name)}(?!\\w)`, "i").test(line);

/** Where a labelled value starting at `i` ends: `;`, `|`, a tag, `closer` or a sentence's full stop. */
function valueEnd(text: string, i: number, closer: string | null): number {
  for (; i < text.length; i++) {
    const c = text[i];
    if (c === ";" || c === "|" || c === "\n" || c === closer || (c === "<" && /^<\/?[A-Za-z]/.test(text.slice(i, i + 3)))) return i;
    if (c === "." && (i + 1 === text.length || /\s/.test(text[i + 1]))) return i;
  }
  return text.length;
}

/** `text` without its labelled parts whose field is hidden; a label counts only where a part starts. */
function stripParts(text: string, hidden: Set<string>): string {
  let out = "";
  let pos = 0;
  PART.lastIndex = 0;
  for (let m = PART.exec(text); m; m = PART.exec(text)) {
    const fields = [...labelFields(m.groups!.label)].filter((f) => hidden.has(f));
    const before = text.slice(0, m.index).replace(/[ \t]+$/, "");
    const end0 = m.index + m[0].length;
    if (!fields.length || /[\p{L}\p{N}]$/u.test(before)) {
      out += text.slice(pos, end0);
      pos = end0;
      PART.lastIndex = pos;
      continue;
    }
    const closer = before.endsWith("(") ? ")" : null;
    let end = valueEnd(text, end0, closer);
    if (closer && text[end] === ")") {
      // "(Est.: 3w)": the brackets go with it, the space after them stays.
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

/**
 * Written item text without what `audience` (Team, Engineering) hides (as the API's variants.redact): hidden
 * table columns and labelled parts, and sentences naming a hidden tracker issue (`refs`). A table keeps its
 * header and delimiter rows.
 */
export function redact(text: string, audience: Audience, refs: string[] = []): string {
  const hidden = hiddenFields(audience);
  if (!hidden.has("tracker")) refs = [];
  const lines = text.split("\n");
  const rows = tableRows(lines);
  const out: string[] = [];
  let fence = false;
  lines.forEach((line, n) => {
    const row = rows[n];
    if (row) {
      const [kind, head] = row;
      const drop = new Set(head.flatMap((h, i) => ([...labelFields(h)].some((f) => hidden.has(f)) ? [i] : [])));
      let cells = splitRow(line);
      if (kind === "body") cells = cells.map((c) => redactPart(c, hidden, refs));
      const kept = cells.filter((_, i) => !drop.has(i));
      if (drop.size === head.length) return; // every column hidden: the table goes
      out.push(kept.join("\u0000") === splitRow(line).join("\u0000") ? line : joinRow(kept));
      return;
    }
    if (isFence(line)) fence = !fence;
    if (fence || isFence(line) || !line.trim()) {
      out.push(line);
      return;
    }
    const kept = redactPart(line, hidden, refs);
    if (kept !== line && !kept.replace(/[ \-*+\t]/g, "")) return;
    out.push(kept);
  });
  return out.join("\n").replace(/^\n+|\n+$/g, "");
}

/** A roadmap item as Board reads it (as the API's variants.ItemView): `goals` and `no_goal` from its feature-to-goal link. */
export type BoardItem = {
  key: string;
  title: string;
  outcome: string | null;
  horizon: "now" | "next" | "later";
  position: number;
  confidence: string | null;
  rank: number | null;
  goals: string[];
  no_goal: boolean;
  /** The goal it is grouped under: the first by title of the confirmed goals its feature reaches; null for "No goal". */
  group: string | null;
};

export const NO_GOAL_GROUP = "No goal";
export const NO_GOAL_FLAG = "\u2691 Serves no confirmed goal.";
const byTitle = (a: string, b: string) => (a.toLowerCase() < b.toLowerCase() ? -1 : a.toLowerCase() > b.toLowerCase() ? 1 : a < b ? -1 : a > b ? 1 : 0);

/** The goal a Board row's Goal column and a Team card name: the group's goal (owner answer 2026-10-26, as the API's variants.goal_names). */
const groupGoal = (i: BoardItem): string[] => (i.group !== null ? [i.group] : i.goals);

/** `items` by goal group, their order kept: the goals by title, then "No goal" (as the API's variants.goal_groups). */
export function goalGroups(items: BoardItem[]): [string, BoardItem[]][] {
  const by = new Map<string | null, BoardItem[]>();
  for (const i of items) by.set(i.group, [...(by.get(i.group) ?? []), i]);
  const titles = [...by.keys()].filter((t): t is string => t !== null).sort(byTitle);
  const out: [string, BoardItem[]][] = titles.map((t) => [t, by.get(t)!]);
  if (by.has(null)) out.push([NO_GOAL_GROUP, by.get(null)!]);
  return out;
}

const HORIZONS = { now: "Now", next: "Next", later: "Later" } as const;
const BOARD_COLUMNS = ["Item", "Outcome", "Confidence", "Goal"];
export const BOARD_NO_ITEMS =
  "This roadmap version has no structured items yet, so Board has no rows to show: Board is built from its items only, never its written text.";
const cell = (text: string | null) => (text ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ").trim();
const leftOutLine = (n: number) => (n === 1 ? "1 item serves no confirmed goal and is left out." : `${n} items serve no confirmed goal and are left out.`);

/**
 * Board (owner decision 2026-10-26, as the API's variants._board): from the items alone, a section per horizon
 * with a row per shown item (title, outcome, confidence, goal; at most 7, best ranked first), the left-out line
 * before the first; a version without items says so. Nothing of the written text is read.
 */
function boardSections<S extends Section>(sections: S[], items: BoardItem[]): S[] {
  const like = sections[0];
  if (!like) return [];
  const section = (section_key: string, heading: string, body: string): S => ({ ...like, section_key, level: 2, heading, body_md: body, body_text: body });
  if (!items.length) return [section("brief-items", "Roadmap items", BOARD_NO_ITEMS)];
  const sorted = [...items].sort((a, b) => a.position - b.position);
  const leftOut = sorted.filter((i) => i.no_goal && i.horizon in HORIZONS).length;
  const out: S[] = [];
  for (const [horizon, heading] of Object.entries(HORIZONS)) {
    const rows = sorted
      .filter((i) => i.horizon === horizon && !i.no_goal)
      .sort((a, b) => (a.rank === null ? 1 : 0) - (b.rank === null ? 1 : 0) || (a.rank ?? 0) - (b.rank ?? 0) || a.position - b.position)
      .slice(0, 7);
    if (!rows.length) continue;
    out.push(section(horizon, heading, ""));
    goalGroups(rows).forEach(([title, group], n) => {
      const lines = [joinRow(BOARD_COLUMNS), "|" + "---|".repeat(BOARD_COLUMNS.length)];
      for (const i of group) lines.push(joinRow([i.title, i.outcome, i.confidence, groupGoal(i).join(", ")].map(cell)));
      out.push({ ...section(`${horizon}-group-${n + 1}`, title, lines.join("\n")), level: 3 });
    });
  }
  if (leftOut) {
    const note = leftOutLine(leftOut);
    if (out.length) out[0] = { ...out[0], body_md: note, body_text: note };
    else out.push(section("brief-items", "Roadmap items", note));
  }
  return out;
}

/**
 * Whether a rebuilt section is a goal group (Board's, holding its item table, and Team's, a heading over its
 * item cards), as the API's variants.spans_row: the themed export marks it full width (section-wide), so the
 * roadmap-board theme spans it across its card grid instead of one card column. Engineering has none.
 */
export function spansRow(key: string): boolean {
  return /^(now|next|later)-group-\d+$/.test(key);
}

/** The sections of one rendering in `audience` (see the file comment); Board is built from `items` alone. */
export function audienceSections<S extends Section>(sections: S[], audience: Audience, items: BoardItem[] = []): S[] {
  if (audience === "board") return boardSections(sections, items);
  const hidden = new Set(AUDIENCES.find((a) => a.key === audience)!.hidden_sections);
  const out: S[] = [];
  let skip: number | null = null;
  let area: number | null = null;
  const sorted = [...items].sort((a, b) => a.position - b.position);
  for (const s of sections) {
    if (skip !== null) {
      if (s.level > skip) continue;
      skip = null;
    }
    if (area !== null && s.level <= area) area = null;
    if (audience === "team" && items.length && s.section_key in HORIZONS && !hidden.has(s.section_key)) {
      // Team's horizon, rebuilt from the items (as the API's variants._layout): a card per item under its goal group.
      const horizon = s.section_key;
      const body_md = redact(s.body_md, audience);
      out.push(body_md === s.body_md ? s : { ...s, body_md, body_text: body_md });
      const cards = sections.filter((x) => x.level >= 3);
      goalGroups(sorted.filter((i) => i.horizon === horizon)).forEach(([title, group], n) => {
        out.push({ ...s, section_key: `${horizon}-group-${n + 1}`, level: s.level + 1, heading: title, body_md: "", body_text: "" });
        for (const i of group) {
          const written = cards.find((x) => x.section_key === `${horizon}-${i.key}`) ?? cards.find((x) => x.heading.trim().toLowerCase() === i.title.trim().toLowerCase());
          const why = written ? redact(written.body_md, audience) : "";
          const lines = [
            i.outcome && !why.includes(i.outcome) ? i.outcome : "",
            groupGoal(i).length ? `Goal: ${groupGoal(i).join(", ")}` : "",
            i.confidence ? `Confidence: ${i.confidence}` : "",
            why,
            i.no_goal && !why.toLowerCase().includes("serves no confirmed goal") ? NO_GOAL_FLAG : "",
          ].filter(Boolean);
          const body = lines.join("\n\n");
          out.push({ ...s, section_key: `${horizon}-${i.key}`, level: s.level + 2, heading: i.title, body_md: body, body_text: body });
        }
      });
      skip = s.level;
      continue;
    }
    if (area === null && ITEM_AREAS.has(s.section_key)) area = s.level;
    if (hidden.has(s.section_key)) {
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
  return out;
}
