/**
 * The one-pager reads clearly (the owner's pick, 2026-10-30), as
 * api/oracle/simple/one_pager_checks.py reads a PRD's sections: who has the problem, each
 * outcome's measure and source, codes with names, footnote marks with their notes, and the
 * "Needs a look" items (numbers that disagree, a code with no name) for the PRD's owners.
 */
import type { Schemas } from "@/lib/api/client";

type Look = Schemas["OnePagerLook"];
type Block = Schemas["OnePagerBlock"];
interface Sec { key: string; heading: string; body: string }

const BULLET = /^\s*(?:[-*+]|\d+[.)])\s+(.*\S)\s*$/;
const TABLE_SEP = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;
const STOP = new Set(
  "this that them they their with from have will when what which into than then more most some only also each every week month year days were been does done they're there here about after before over under people".split(" "),
);

/**
 * The text as the PRD's PDF reads it (one_pager_checks.resolved): no [c:id] marker left
 * (oracle.docs.parser.strip_citations), and none an older quick read cut at its end.
 */
export const resolved = (t: string) => (t ?? "").replace(/(?<![ \t])[ \t]*\[c:[^\]\s[]+\]/g, "").replace(/[ \t]*\[c(?:(?=…$)|:[^\]\s…]*(?=…?$))/, "");
const plainKeep = (t: string) => (t ?? "").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[*_`]+|\{#[^}]*\}|<!--.*?-->/g, "").split(/\s+/).filter(Boolean).join(" ");
const plain = (t: string) => plainKeep(resolved(t));
const plainOf = (t: string) => plain(t);
const sentences = (t: string) => t.split(/(?<=[.!?])\s+/).filter(Boolean);

function rows(body: string, cites = false): { bullets: string[]; cells: string[][]; prose: string[] } {
  const plain = cites ? plainKeep : plainOf;
  const bullets: string[] = [], cells: string[][] = [], prose: string[] = [];
  const lines = (body ?? "").split("\n");
  lines.forEach((raw, i) => {
    if (TABLE_SEP.test(raw) && raw.includes("-")) return;
    if (raw.trim().startsWith("|")) {
      const next = lines[i + 1] ?? "";
      if (!(TABLE_SEP.test(next) && next.includes("-"))) cells.push(raw.trim().replace(/^\||\|$/g, "").split("|").map(plain));
      return;
    }
    const m = BULLET.exec(raw);
    if (m) bullets.push(plain(m[1]));
    else if (raw.trim()) prose.push(plain(raw));
  });
  return { bullets, cells, prose };
}

/** one_pager_checks._header: a table's header cells, lower-case. */
function header(body: string): string[] {
  const lines = (body ?? "").split("\n");
  const at = lines.findIndex((l, i) => i > 0 && TABLE_SEP.test(l) && l.includes("-") && lines[i - 1].trim().startsWith("|"));
  return at > 0 ? lines[at - 1].trim().replace(/^\||\|$/g, "").split("|").map((c) => plain(c).toLowerCase()) : [];
}

const terms = (t: string) => new Set((t.match(/[A-Za-z][A-Za-z'-]{3,}/g) ?? []).filter((w) => !STOP.has(w.toLowerCase())).map((w) => w.toLowerCase().replace(/s+$/, "")));
const overlap = (a: Set<string>, b: Set<string>) => [...a].filter((x) => b.has(x)).length;

/** A template's guidance is never who has it (one_pager.template_only): comments, placeholder-only lines, arrows. */
const guidanceless = (body: string) =>
  body.replace(/<!--[\s\S]*?(?:-->|$)/g, "").split("\n").filter((l) => /[^\W_]/.test(l.replace(/<[^<>\n]*>/g, "").replace(/^\s*(?:[-*+]|\d+[.)])\s+/, ""))).join("\n");

/** ad-onepager review: a heading naming the people (personas, users, who has it) first; never "User stories" or "Customer quotes". */
const WHO_HEAD = /\b(?:users?|personas?|who\b|audiences?|customers?)/i;
const WHO_BEST = /\b(?:personas?|users?|who has it)\b/i;
const WHO_NOT = /\b(?:stor(?:y|ies)|flows?|quotes?|journeys?|scenarios?|problems?)\b/i;

/**
 * A users section of labelled lines (a run's PRD: "Primary: …", "Job story: …", "Owner: …",
 * "Not the target: …"): the label says what the line is, its words who. The primary people
 * first, the excluded never, a job story never (it names no one).
 */
const LABEL = /^(?:(primary|main|core|target)(?:\s+(?:users?|personas?|segments?|audiences?))?|(not\b.*|non[- ]target.*|anti[- ]personas?|out of scope|excluded)|((?:job\s+)?stor(?:y|ies)|jobs?(?:\s+to\s+be\s+done)?|jtbd|scenarios?|quotes?)|(secondary|tertiary|also|other|owners?|buyers?|segments?|personas?|users?|audiences?|customers?|who(?:\s+has\s+it)?)(?:\s+(?:users?|personas?|segments?))?)$/i;

// A job story ("When ..., I want ...") or a note on the people ("The primary segment is a
// hypothesis ...") says what they do or how sure we are, never who they are (CLD's walk B, 2026-11-01).
const STORY = /^\s*(?:when\b.*\bI\b|as an?\b.*,\s*I\b|I\s+want\b)/i;
const NOTE_LINE = /\bhypothes|\bassum|\bto be (?:confirmed|validated|tested)\b/i;
const WHO_WORDS = 30;
const saidNotWho = (t: string) => STORY.test(t) || NOTE_LINE.test(t);
const wordCount = (t: string) => t.split(/\s+/).filter(Boolean).length;

/** one_pager_checks._whole: a sentence whole, never cut mid-way; over 30 words its first clause, "" when even that is too long. */
function whole(text: string, words = WHO_WORDS): string {
  const t = text.split(/\s+/).filter(Boolean).join(" ").replace(/\.+$/, "");
  if (wordCount(t) <= words) return t;
  const clause = t.split(/\s*(?:[,;]|—|–| - )\s*/)[0];
  return wordCount(clause) <= words ? clause : "";
}

/** A labelled line's words as who has it: its first sentence, whole. */
const sentence = (t: string) => whole(t.trim().split(/(?<=[.!?])\s+/)[0] ?? "");

/** one_pager_checks._joined: names joined with "; ", as many whole ones as fit in 30 words. */
function joined(names: string[]): string {
  const out: string[] = [];
  for (const n of names) {
    if (out.length && wordCount([...out, n].join(" ")) > WHO_WORDS) break;
    out.push(n);
  }
  return out.join("; ");
}

/** Who has it from labelled lines ("" when no line names people), null when no line is labelled. */
function labelled(pairs: [string, string][]): string | null {
  const kinds: Record<string, string[]> = { primary: [], people: [], story: [], out: [] };
  if (!pairs.some(([label]) => LABEL.test(label.trim()))) return null;
  for (const [label, words] of pairs) {
    const m = LABEL.exec(label.trim());
    // A lead among labelled lines ("New admins: ...") names its people; a long lead is a sentence.
    if (!m) {
      if (wordCount(label) <= 8 && !saidNotWho(label)) kinds.people.push(label.trim());
      continue;
    }
    const w = sentence(words);
    // The groups in LABEL's order: primary, out, story, people.
    if (w) kinds[["primary", "out", "story", "people"][[m[1], m[2], m[3], m[4]].findIndex((v) => v !== undefined)]].push(w);
  }
  // A job story names no one ("When ..., I want ..."): never who has it.
  return joined(kinds.primary.length ? kinds.primary : kinds.people);
}

/**
 * one_pager_checks.who_has_it: one plain line, labelled lines by the primary people's words,
 * else each bullet's lead, else a sentence naming people, whole. Never a label, a job story
 * or a note on the people.
 */
export function whoHasIt(secs: Sec[]): string | null {
  const heads = secs.filter((s) => WHO_HEAD.test(s.heading) && !WHO_NOT.test(s.heading));
  heads.sort((a, b) => Number(!WHO_BEST.test(a.heading)) - Number(!WHO_BEST.test(b.heading)));
  const split = (b: string) => { const m = /^(.*?)\s*(?::|—|–| - )\s*([\s\S]*)$/.exec(b); return m ? [m[1], m[2]] as [string, string] : null; };
  for (const s of heads) {
    const r = rows(guidanceless(s.body));
    // A bold lead in prose ("**Job story:** When ...") is a labelled line too.
    const lines = [...r.bullets, ...r.prose.filter((p) => /^[A-Z][\w ]{0,30}:\s/.test(p))];
    const prose = r.prose.filter((p) => !lines.includes(p));
    const pairs = [...lines.map(split).filter((p): p is [string, string] => !!p), ...r.cells.filter((c) => c.length > 1 && c[0]).map((c) => [c[0], c.slice(1).join(" ")] as [string, string])];
    if (pairs.some(([label]) => LABEL.test(label.trim()))) {
      const who = labelled(pairs);
      if (who) return who;
      continue;
    }
    let named: string[] = [];
    for (const b of lines) {
      const p = split(b);
      if (p && wordCount(p[0]) <= 8) named.push(p[0]);
      else if (!saidNotWho(b)) named.push(sentence(b));
    }
    named.push(...r.cells.map((c) => c[0]).filter(Boolean));
    if (!named.length) named = prose.join(" ").split(/(?<=[.!?])\s+/).filter((x) => x && !saidNotWho(x)).map(sentence).slice(0, 1);
    named = named.filter((n) => n.trim());
    if (named.length) return joined(named);
  }
  return null;
}

interface Measure { name: string; measure: string; source: string | null }
const MEASURE = /\b(?:counted as|measured as|measured by|measured on|defined as|definition|we count)\b\s*:?\s*/i;
const SOURCE = /(?:\bsources?\s*:?\s*|[;·,|]\s*from\s+|\bfrom\s+(?=(?:the|our)\b)|\bvia\s+)([^.;·|]+)/i;
const trimP = (t: string) => t.replace(/^[\s:,;·\-—–.]+|[\s:,;·\-—–.]+$/g, "");

/** A source named only by its citation ("source: [c:c1]") leaves its word behind. */
const SOURCE_LEFT = /[\s;,·|]*\b(?:sources?|from|via)\s*:?\s*$/i;
/** Each citation's title and excerpt, by its id (the API's Citation rows). */
export type Cites = Record<string, { title: string | null; excerpt: string | null }>;

function measureIn(text: string): Measure | null {
  const m = MEASURE.exec(text);
  if (!m) return null;
  const rest = text.slice(m.index + m[0].length);
  const s = SOURCE.exec(rest);
  const measure = trimP((s ? rest.slice(0, s.index) : rest).replace(SOURCE_LEFT, ""));
  return measure ? { name: trimP(text.slice(0, m.index)), measure, source: s ? trimP(s[1]) || null : null } : null;
}

const keysOf = (raw: string, cites: Cites) =>
  [...(raw ?? "").matchAll(/\[c:\s*([^[\]]*?)\s*\]/g)].flatMap((g) => g[1].split(",")).map((k) => k.trim()).filter((k) => k && k in cites);

/** one_pager_checks._excerpt: a citation's excerpt as a measure, at most 20 words, cut with "…". */
function excerpt(t: string): string {
  const words = plain(t).split(/\s+/).filter(Boolean);
  return words.slice(0, 20).join(" ") + (words.length > 20 ? "…" : "");
}

/** one_pager_checks._cited: a measure with its citations resolved; ids alone are the cited source's words, else no measure. */
function cited(raw: string, cites: Cites): Measure | null {
  const keys = keysOf(raw, cites);
  const m = measureIn(plain(raw));
  if (!m) {
    const at = MEASURE.exec(raw);
    const src = keys.map((k) => cites[k]).find((c) => c.excerpt);
    if (!at || !src) return null;
    return { name: trimP(plain(raw.slice(0, at.index))), measure: excerpt(src.excerpt ?? ""), source: src.title };
  }
  if (m.source === null) m.source = keys.map((k) => cites[k].title).find(Boolean) ?? null;
  return m;
}

// A success measures section (CLD's walk B, 2026-11-01): its lines say how each outcome is
// measured in their own words ("from 55% to 80% by Mar 31, recomputed daily"), with no
// "counted as". A clause that is the target, the baseline or the time frame is not how.
const SUCCESS_HEAD = /\b(?:success|outcomes?|measures?|metrics?|kpis?)\b/i;
const TARGET_CLAUSE = /(?:→|->|\bfrom\b[^,;]*\d[^,;]*\bto\b|^\s*(?:by|before|target|baseline|goal|today|now|up|down|at least|at most|no more|no less|within)\b|^[\s~<>≥≤$€£]*\d[\d.,%]*\s*\S{0,8}\s*$)/i;
const TARGET = /\s(?:from\s+)?[~<>]?[$€£]?\d[\d.,]*\s?\S*\s*(?:→|->|\bto\b)\s*[~<>]?[$€£]?\d/i;
const LEAD = /^([^:—–]{2,80}?)\s*(?::|—|–| - )\s*(.+)$/;
const trimS = (t: string) => t.replace(/^[\s:,;·\-—–.]+|[\s:,;·\-—–.]+$/g, "");

/** one_pager_checks._stated: how a success line measures its outcome in its own words, less its name, target and time frame. */
function stated(raw: string): Measure | null {
  const text = plain(raw).replace(/(?<=\d),(?=\d{3}\b)/g, "").replace(/\.+$/, "");
  const lead = LEAD.exec(text);
  let [name, rest] = lead ? [lead[1], lead[2]] : ["", text];
  if (!lead) {
    const at = TARGET.exec(text);
    if (!at) return null;
    [name, rest] = [text.slice(0, at.index), text.slice(at.index)];
  }
  // "from 55% to 80% by Mar 31": the target, its time frame with it.
  rest = rest.replace(/\bfrom\b[^,;(]*?\d[^,;(]*?(?:\bto\b|→|->)[^,;(]*/gi, ";");
  const s = SOURCE.exec(rest);
  const source = s ? trimS(s[1]) : null;
  if (s) rest = rest.slice(0, s.index);
  const kept = rest.split(/[,;·]|\s—\s|\s–\s|\(|\)/).map(trimS).filter((c) => /[A-Za-z]{3}/.test(c) && !TARGET_CLAUSE.test(c));
  if (!kept.length || !name.trim()) return null;
  return { name: trimS(name), measure: kept.join(", "), source: source || null };
}

function measures(secs: Sec[], cites: Cites): Measure[] {
  const out: Measure[] = [];
  for (const s of secs) {
    const { bullets, cells, prose } = rows(s.body, true);
    const success = SUCCESS_HEAD.test(s.heading);
    for (const t of [...bullets, ...sentences(prose.join(" "))]) {
      const m = cited(t, cites) ?? (success && !MEASURE.test(t) ? stated(t) : null);
      if (m) out.push(m);
    }
    const head = header(s.body);
    const mcol = head.findIndex((h, i) => i > 0 && /defin|measure|counted|how/.test(h));
    const scol = head.findIndex((h, i) => i > 0 && /source|data|where/.test(h));
    for (const r of cells) {
      if (mcol > 0 && r[mcol]) {
        const said = scol > 0 ? r[scol] ?? "" : "";
        const keys = [...keysOf(r[mcol], cites), ...keysOf(said, cites)];
        const measure = plain(r[mcol]) || excerpt(keys.map((k) => cites[k].excerpt).find(Boolean) ?? "");
        const src = plain(said) || (keys.map((k) => cites[k].title).find(Boolean) ?? null);
        if (measure) out.push({ name: plain(r[0]), measure: plain(measure), source: src || null });
      } else {
        const m = cited(r.join(" · "), cites) ?? (success && r[0] ? stated(`${r[0]}: ${r.slice(1).join("; ")}`) : null);
        if (m) out.push(m);
      }
    }
  }
  return out;
}

function measureFor(text: string, name: string | null, found: Measure[]): Measure | null {
  const own = measureIn(text);
  if (own) return own;
  const want = terms(name ?? text);
  let best: Measure | null = null, score = 0;
  for (const m of found) {
    const have = terms(m.name);
    const n = overlap(want, have);
    if (n > score && (n >= 2 || n === have.size || n === want.size)) [best, score] = [m, n];
  }
  return best;
}

// A standard's name (ISO-8601, RFC-3339) is not a feature or ticket code.
const CODE = /\b(?!(?:ISO|RFC|UTF|IEC|SHA|CVE|EN|IEEE)-)(?:[A-Z]{1,3}-\d{1,4}|P[0-3])\b/g;
const PRIORITY: Record<string, string> = { P0: "top priority", P1: "high priority", P2: "medium priority", P3: "low priority" };
// A name starts with a capital: "F-01: every newly connected account gets a plan" says what
// F-01 does, never its name (CLD's walk B, 2026-11-01).
const NAMED = /^\s*(?:[:=—–]|\s-\s|\()\s*([A-Z][^.;,()|:\n]*)/;
const CAPITAL = /^\s+([A-Z][^.;,()|:\n]*)/;
const nameOf = (t: string) => t.split(/\s+/).filter(Boolean).slice(0, 5).join(" ").replace(/^[\s\-—–]+|[\s\-—–]+$/g, "");
const isCode = (t: string) => new RegExp(`^${CODE.source}$`).test(t);

/** A name written right after its code in prose ("so F-11 Photo editing is out"): its words up to the first that is not a name's, at most four. */
const NOT_NAME = "(?:is|are|was|were|be|been|will|would|can|could|may|might|must|shall|should|has|have|had|do|does|did|gets?|stays?|waits?|goes|go|moves?|ships?|comes?|lands?|slips?|starts?|ends?|needs?|and|or|but|nor|to|in|on|at|by|of|for|from|with|without|until|because|so|which|that|who|as|into|after|before|than|then|also|too|now|later|first|next|out|not|no|the|a|an|it|its|this|these|those|we|our|you|they|here|there)\\b";
const AFTER = new RegExp(`^\\s+((?!${NOT_NAME})[A-Za-z][\\w'’-]*(?:\\s+(?!${NOT_NAME})[A-Za-z][\\w'’-]*){0,3})`, "i");

function glossary(secs: Sec[]): Record<string, string> {
  const out: Record<string, string> = {}, after: Record<string, string> = {};
  const put = (c: string, n: string) => { if (!(c in out) && n) out[c] = n; };
  const scan = (text: string) => {
    for (const c of text.matchAll(CODE)) {
      const rest = text.slice(c.index! + c[0].length);
      const n = NAMED.exec(rest) ?? (c.index === 0 ? CAPITAL.exec(rest) : null);
      if (n && nameOf(n[1])) put(c[0], nameOf(n[1]));
      else {
        const a = AFTER.exec(rest);
        // Its first word starts with a capital ("F-50 requires login" names nothing).
        if (a && /^[A-Z]/.test(a[1]) && nameOf(a[1]) && !(c[0] in after)) after[c[0]] = nameOf(a[1]);
      }
    }
  };
  // A feature's own section names it best: "### F-01 Pacing plan {#f-01}".
  for (const s of secs) {
    const head = plain(s.heading.replace(/^[#\s]+/, ""));
    const c = new RegExp(`^${CODE.source}`).exec(head);
    const n = c ? CAPITAL.exec(head.slice(c[0].length)) ?? NAMED.exec(head.slice(c[0].length)) : null;
    if (c && n) put(c[0], nameOf(n[1]));
  }
  for (const s of secs) {
    for (const raw of [s.heading, ...s.body.split("\n")]) {
      if (raw.trim().startsWith("|")) {
        const cells = raw.trim().replace(/^\||\|$/g, "").split("|").map(plain);
        cells.slice(0, -1).forEach((c, i) => { if (isCode(c) && cells[i + 1] && !isCode(cells[i + 1])) put(c, nameOf(cells[i + 1])); });
        cells.filter((c) => !isCode(c)).forEach(scan);
        continue;
      }
      const m = BULLET.exec(raw);
      scan(plain((m ? m[1] : raw).replace(/^[#\s]+/, "")));
    }
  }
  return { ...after, ...out };
}

function withNames(text: string, names: Record<string, string>): [string, string[]] {
  const missing: string[] = [];
  const out = text.replace(CODE, (code, at: number) => {
    const name = names[code] ?? PRIORITY[code];
    if (!name) {
      if (!missing.includes(code)) missing.push(code);
      return code;
    }
    const after = text.slice(at + code.length).replace(/^[\s:—–\-(]+/, "");
    if (after.toLowerCase().startsWith(name.toLowerCase())) return code;
    // Already named where it stands: "Pacing plan (F-01)", "F-01 Pace gives ...".
    const before = text.slice(0, at).replace(/[\s(—–\-:]+$/, "").toLowerCase();
    const here = !(code in PRIORITY) && AFTER.exec(text.slice(at + code.length));
    return before.endsWith(name.toLowerCase()) || (here && /^[A-Z]/.test(here[1])) ? code : `${code} ${name}`;
  });
  return [out, missing];
}

function footnoteNotes(secs: Sec[]): Record<string, string> {
  const out: Record<string, string> = {};
  const star = /^\s*(\\)?\*\s+(\S.*)$/;
  for (const s of secs) s.body.split("\n").forEach((raw, i, lines) => {
    const m = /^\s*(?:[-*+]\s+)?([†‡§])\s*(\S.*)$/.exec(raw);
    if (m && !(m[1] in out)) out[m[1]] = plain(m[2]);
    const st = m ? null : star.exec(raw);
    // "\\* note", or a lone "* note" (a list of "*" bullets is no note).
    if (st && !("*" in out) && (st[1] || ![lines[i - 1], lines[i + 1]].some((x) => x !== undefined && star.test(x)))) out["*"] = plain(st[2]);
  });
  return out;
}

function marked(text: string, notes: Record<string, string>): [string, string[]] {
  const kept: string[] = [];
  // A trailing "*" is a mark too ("40%*"), never emphasis (an odd count of "*" before it opens one).
  const out = text.replace(/(?<=[^\s*])([†‡§]|\\?\*(?![*\w]))/g, (found: string, _m: string, at: number) => {
    const mark = found.replace(/^\\/, "");
    if (mark === "*" && text.slice(0, at).split("*").length % 2 === 0) return found;
    if (!(mark in notes)) return "";
    const n = `${mark} ${notes[mark]}`;
    if (!kept.includes(n)) kept.push(n);
    return mark;
  });
  return [out, kept];
}

const WORDS = "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty".split(" ");
const NUM = `(?:\\d[\\d,]*(?:\\.\\d+)?|${WORDS.join("|")})`;
const num = (t: string) => { const w = WORDS.indexOf(t.toLowerCase()); if (w >= 0) return w; const n = Number(t.replace(/,/g, "")); return Number.isNaN(n) ? null : n; };
/** one_pager_checks._n: `x` as a person writes it: thousands separators, no float noise ("0.3", "1,234,567.5"). */
const plainNum = (x: number) => Number(x.toFixed(6)).toLocaleString("en-US", { maximumFractionDigits: 6 });
const COUNT = new RegExp(`\\b(${NUM})\\s+(?:(?:more|other|new|open|big|small|planned)\\s+)?(features|items|bets|ideas|requests|tickets|stories|epics|projects|risks)\\b((?:\\s+[a-z]+){0,3})`, "gi");
const PER = new RegExp(`\\b(?:each|every|per)\\s+([a-z]+?)s?\\s+(?:[a-z]+\\s+){0,2}?(${NUM})\\s+([a-z]+(?:\\s+[a-z]+)?)`, "gi");
const FIELD = /^[A-Z][\w ]{0,24}:\s/;
const TOTAL = /company[- ]wide|across the company|company target|whole company|in total|overall/i;

function said(s: Sec): string[] {
  const { bullets, cells, prose } = rows(s.body);
  return [...sentences(prose.join(" ")), ...bullets, ...cells.map((r) => r.join(" · "))];
}

const esc = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** one_pager_checks._number_at: the first number in `body` that reads `said` (its first word the number, the words after it in order). */
function numberAt(body: string, said: string): RegExpExecArray | null {
  const [first, ...rest] = said.split(/\s+/).filter(Boolean);
  const after = rest.map((w) => `[\\W_]+${esc(w)}`).join("");
  return new RegExp(`(?<![\\w.,])${esc(first)}(?!\\w)(?=${after}(?!\\w))`, "i").exec(body ?? "");
}

/** one_pager_checks.set_number: `body` with the number of `said` set to `value`; null when it holds no such words. */
export function setNumber(body: string, said: string, value: string): string | null {
  const m = numberAt(body, said);
  return m ? body.slice(0, m.index) + asWritten(m[0], value) + body.slice(m.index + m[0].length) : null;
}

/** one_pager_checks._as_written: a count in words stays in words ("Eight" -> "Six", its case kept); a numeral, or a value with no word for it, as a numeral. */
export function asWritten(old: string, value: string): string {
  if (/^\d+$/.test(old) || !WORDS.includes(old.toLowerCase())) return value;
  const word = WORDS[Number(value)];
  if (!/^\d+$/.test(value) || !word) return value;
  if (old === old.toUpperCase()) return word.toUpperCase();
  return old[0] === old[0].toUpperCase() ? word[0].toUpperCase() + word.slice(1) : word;
}

/** one_pager_checks._like: `value` written as `before` is: its thousands separators ("1,200,000") and at least its places after the point ("2.75" -> "2.50"), more when the value needs them. */
function like(before: string, value: number): string {
  const v = Number(value.toFixed(6));
  const places = Math.max(before.split(".")[1]?.length ?? 0, v.toFixed(6).replace(/0+$/, "").split(".")[1]?.length ?? 0);
  return before.includes(",") ? v.toLocaleString("en-US", { minimumFractionDigits: places, maximumFractionDigits: places }) : v.toFixed(places);
}

/** one_pager_checks._fix: a numbers item's fix (its document_id filled by the read); `heading`: the number is in the section's heading (part "heading"). */
function fixOf(s: Sec, said: string, before: string, value: number, heading = false): Look["fix"] {
  if (!numberAt(heading ? s.heading : s.body, said)) return null;
  const shown = like(before, value);
  return { action: "set_section_number", target: { document_id: "", section: s.key, said, ...(heading ? { part: "heading" } : {}) }, before, value: shown, words: `Use ${shown}`, proposal: null };
}

function numbers(secs: Sec[]): Look[] {
  const looks: Look[] = [];
  for (const s of secs) {
    const { bullets, cells, prose } = rows(s.body);
    const listed = bullets.length + cells.length;
    const head = plain(s.heading);
    const hm = /(?:·|\()\s*(\d+)\s+items?\b/i.exec(head);
    const shown = hm ? Number(hm[1]) : null;
    if (hm && shown !== null && listed && shown !== listed)
      looks.push({ kind: "numbers", text: `“${head}” says ${shown} items, but it lists ${listed}.`, where: [head], source_keys: [s.key], fix: fixOf(s, head.slice(hm.index + hm[0].indexOf(hm[1]), hm.index + hm[0].length), hm[1], listed, true) });
    const target = shown ?? listed;
    if (!target) continue;
    // A count disagrees only with a list of the same things (CLD's walk B, 2026-11-01):
    // "M1 ships two features" above its scope, exit and date lines ("Scope: ...") is no
    // list of features. Such a list counts only when its heading or header names them.
    const listing = `${head} ${header(s.body).join(" ")}`.toLowerCase();
    const fields = bullets.length > 0 && !cells.length && bullets.every((b) => FIELD.test(b));
    for (const t of [head, ...sentences(prose.join(" "))]) {
      for (const m of t.matchAll(COUNT)) {
        const n = num(m[1]);
        if (n === null || n === target) continue;
        const noun = m[2].toLowerCase().replace(/s$/, "").replace(/ie$/, "");
        if (hm === null && fields && !listing.includes(noun)) continue;
        // Every word from the number on ("two more features"), as numberAt reads it.
        const words = m[0].split(/\s+/).filter(Boolean).join(" ");
        looks.push({ kind: "numbers", text: `“${words}” says ${plainNum(n)}, but “${head}” shows ${target} items.`, where: [head], source_keys: [s.key], fix: fixOf(s, words, m[1], target, t === head) });
      }
    }
  }
  const all = secs.flatMap((s) => said(s).map((t) => [s, t] as const));
  for (const [sec, t] of all) {
    if (TOTAL.test(t)) continue;
    for (const m of t.matchAll(PER)) {
      const per = num(m[2]), thing = m[1].toLowerCase(), unit = m[3].toLowerCase().split(" ").filter((w) => w.length > 3);
      if (per === null || !unit.length || ["month", "week", "day", "year", "quarter"].includes(thing)) continue;
      let count: [number | null, Sec, string] | null = null;
      for (const [cs, ct] of all) {
        const c = new RegExp(`\\b(${NUM})\\s+${thing}s\\b`, "i").exec(ct);
        if (c) { count = [num(c[1]), cs, c[0]]; break; }
      }
      if (!count || count[0] === null) continue;
      for (const [ts, tt] of all) {
        if (!TOTAL.test(tt)) continue;
        const tm = new RegExp(`\\b(${NUM})\\s+(?:[a-z]+\\s+){0,2}?(?:${unit.join("|")})`, "i").exec(tt);
        const total = tm ? num(tm[1]) : null;
        // Equal as written, rounded as plainNum and the API's _round: 0.1 × 3 is 0.3.
        if (total === null || Number(total.toFixed(6)) === Number((per * count[0]).toFixed(6))) continue;
        const where = [sec, count[1], ts];
        looks.push({
          kind: "numbers",
          text: `${plainNum(per)} ${m[3]} per ${thing} × ${count[2]} is ${plainNum(per * count[0])}, but the company-wide target says ${tm![1]}.`,
          where: [...new Set(where.map((x) => plain(x.heading)))],
          source_keys: [...new Set(where.map((x) => x.key))],
          fix: fixOf(ts, tm![0], tm![1], per * count[0]),
        });
        break;
      }
    }
  }
  return looks;
}

const MONTHS = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split(" ");
const ISO = /\b(20\d\d)-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])(?:T[\d:.]+Z?)?\b/g;
// An internal pointer: a link's or heading's anchor ("(#feature-pacing-plan)", "{#f-01}").
const POINTER = /\(\s*#[\w-]+\s*\)|\{#[^}]*\}/g;

/** one_pager_checks.month_first: an ISO date month first ("2027-03-31" -> "Mar 31, 2027"), no anchor or pointer left. */
export function monthFirst(text: string): string {
  if (!text) return text;
  const t = text.replace(ISO, (_m, y: string, mo: string, d: string) => `${MONTHS[Number(mo) - 1]} ${Number(d)}, ${y}`).replace(/\[([^\]]*)\]\(#[^)]*\)/g, "$1");
  return t.replace(POINTER, "").split(/\s+/).filter(Boolean).join(" ");
}

/** one_pager_checks.whole_word: a target an older build cut mid-word ("80% of acc") whole again from its line's words. */
export function wholeWord(cut: string, said: string): string {
  const c = (cut ?? "").replace(/…+$/, "").trim();
  if (!c) return c;
  const esc = c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp(esc + "[^\\s,;.)]*").exec(said ?? "");
  return m ? m[0] : c;
}

/** one_pager_checks.annotate: fills the blocks' clear-reading fields in place; the "Needs a look" items. */
export function annotate(blocks: Block[], secs: Sec[], cites: Cites = {}, checked: Sec[] = secs): Look[] {
  const names = glossary(secs), notes = footnoteNotes(secs), found = measures(secs, cites), who = whoHasIt(secs);
  const unnamed = new Map<string, string[]>();
  for (const b of blocks) {
    if (b.key === "problem") b.who = who ? monthFirst(who) : who;
    for (const x of b.lines ?? []) {
      const said = x.full ?? x.text;
      let missing: string[];
      [x.text, missing] = withNames(x.text, names);
      if (x.full) x.full = withNames(x.full, names)[0];
      for (const c of missing) unnamed.set(c, [...(unnamed.get(c) ?? []), ...x.source_keys]);
      [x.text, x.footnotes] = marked(x.text, notes);
      if (x.full) x.full = marked(x.full, notes)[0];
      x.text = monthFirst(x.text);
      if (x.full) x.full = monthFirst(x.full);
      if (x.metric) x.metric = { ...x.metric, name: monthFirst(marked(withNames(x.metric.name, names)[0], notes)[0]), to: monthFirst(marked(wholeWord(x.metric.to, plain(said)), notes)[0]) };
      // The Edit box starts from the PRD's words, not the names and marks put in.
      x.words = (x.full ?? x.text) !== said ? said : null;
      if (b.kind === "metrics") {
        const m = measureFor(x.full ?? x.text, x.metric?.name ?? null, found);
        x.measure = m ? monthFirst(withNames(m.measure, names)[0]) : null;
        x.measure_source = m?.source ? monthFirst(m.source) : null;
      }
    }
  }
  const heads = Object.fromEntries(secs.map((s) => [s.key, plain(s.heading)]));
  const looks: Look[] = [...unnamed].map(([code, keys]) => {
    const k = [...new Set(keys)];
    return { kind: "code", text: `${code} has no name in the PRD.`, where: k.map((x) => heads[x] ?? x), source_keys: k };
  });
  return [...looks, ...numbers(checked)];
}
