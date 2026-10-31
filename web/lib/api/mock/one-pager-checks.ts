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
 * first, a story only when no line names people, the excluded never.
 */
const LABEL = /^(?:(primary|main|core|target)(?:\s+(?:users?|personas?|segments?|audiences?))?|(not\b.*|non[- ]target.*|anti[- ]personas?|out of scope|excluded)|((?:job\s+)?stor(?:y|ies)|jobs?(?:\s+to\s+be\s+done)?|jtbd|scenarios?|quotes?)|(secondary|tertiary|also|other|owners?|buyers?|segments?|personas?|users?|audiences?|customers?|who(?:\s+has\s+it)?)(?:\s+(?:users?|personas?|segments?))?)$/i;
const firstSentence = (t: string) => sentences(t.trim())[0]?.replace(/\.$/, "").split(/\s+/).filter(Boolean).slice(0, 30).join(" ") ?? "";

/** Who has it from labelled lines ("" when no line names people), null when no line is labelled. */
function labelled(pairs: [string, string][]): string | null {
  const kinds: Record<string, string[]> = { primary: [], people: [], story: [], out: [] };
  if (!pairs.some(([label]) => LABEL.test(label.trim()))) return null;
  for (const [label, words] of pairs) {
    const m = LABEL.exec(label.trim());
    // A lead among labelled lines ("New admins: ...") names its people.
    if (!m) {
      kinds.people.push(label.split(/\s+/).filter(Boolean).slice(0, 12).join(" "));
      continue;
    }
    const w = firstSentence(words);
    // The groups in LABEL's order: primary, out, story, people.
    if (w) kinds[["primary", "out", "story", "people"][[m[1], m[2], m[3], m[4]].findIndex((v) => v !== undefined)]].push(w);
  }
  const named = kinds.primary.length ? kinds.primary : kinds.people.length ? kinds.people : kinds.story;
  return named.join("; ").split(/\s+/).filter(Boolean).slice(0, 30).join(" ");
}

export function whoHasIt(secs: Sec[]): string | null {
  const heads = secs.filter((s) => WHO_HEAD.test(s.heading) && !WHO_NOT.test(s.heading));
  heads.sort((a, b) => Number(!WHO_BEST.test(a.heading)) - Number(!WHO_BEST.test(b.heading)));
  for (const s of heads) {
    const { bullets, cells, prose } = rows(guidanceless(s.body));
    const split = bullets.map((b) => /^(.*?)\s*(?::|—|–| - )\s*([\s\S]*)$/.exec(b)).map((m) => (m ? [m[1], m[2]] as [string, string] : null));
    const pairs = [...split.filter((p): p is [string, string] => !!p), ...cells.filter((r) => r.length > 1 && r[0]).map((r) => [r[0], r.slice(1).join(" ")] as [string, string])];
    if (pairs.length && pairs.length === bullets.length + cells.filter((r) => r[0]).length) {
      const who = labelled(pairs);
      if (who !== null) {
        if (who) return who;
        continue;
      }
    }
    let named = [...bullets.map((b) => b.split(/\s*(?::|—|–| - )\s*/)[0]), ...cells.map((r) => r[0]).filter(Boolean)];
    if (!named.length && prose.length) named = [sentences(prose.join(" "))[0].replace(/\.$/, "")];
    named = named.filter((n) => n.trim()).map((n) => n.split(/\s+/).slice(0, 12).join(" "));
    if (named.length) return named.join("; ").split(/\s+/).slice(0, 30).join(" ");
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

function measures(secs: Sec[], cites: Cites): Measure[] {
  const out: Measure[] = [];
  for (const s of secs) {
    const { bullets, cells, prose } = rows(s.body, true);
    for (const t of [...bullets, ...sentences(prose.join(" "))]) {
      const m = cited(t, cites);
      if (m) out.push(m);
    }
    const lines = s.body.split("\n");
    const at = lines.findIndex((l, i) => i > 0 && TABLE_SEP.test(l) && l.includes("-") && lines[i - 1].trim().startsWith("|"));
    const head = at > 0 ? lines[at - 1].trim().replace(/^\||\|$/g, "").split("|").map((c) => plain(c).toLowerCase()) : [];
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
        const m = cited(r.join(" · "), cites);
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
const NAMED = /^\s*(?:[:=—–]|\s-\s|\()\s*([A-Za-z][^.;,()|:\n]*)/;
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
    return after.toLowerCase().startsWith(name.toLowerCase()) ? code : `${code} ${name}`;
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
const COUNT = new RegExp(`\\b(${NUM})\\s+(?:(?:more|other|new|open|big|small|planned)\\s+)?(features|items|bets|ideas|requests|tickets|stories|epics|projects|risks)\\b((?:\\s+[a-z]+){0,3})`, "gi");
const PER = new RegExp(`\\b(?:each|every|per)\\s+([a-z]+?)s?\\s+(?:[a-z]+\\s+){0,2}?(${NUM})\\s+([a-z]+(?:\\s+[a-z]+)?)`, "gi");
const TOTAL = /company[- ]wide|across the company|company target|whole company|in total|overall/i;

function said(s: Sec): string[] {
  const { bullets, cells, prose } = rows(s.body);
  return [...sentences(prose.join(" ")), ...bullets, ...cells.map((r) => r.join(" · "))];
}

function numbers(secs: Sec[]): Look[] {
  const looks: Look[] = [];
  for (const s of secs) {
    const { bullets, cells, prose } = rows(s.body);
    const listed = bullets.length + cells.length;
    const head = plain(s.heading);
    const hm = /(?:·|\()\s*(\d+)\s+items?\b/i.exec(head);
    const shown = hm ? Number(hm[1]) : null;
    if (shown !== null && listed && shown !== listed) looks.push({ kind: "numbers", text: `“${head}” says ${shown} items, but it lists ${listed}.`, where: [head], source_keys: [s.key] });
    const target = shown ?? listed;
    if (!target) continue;
    for (const t of [head, ...sentences(prose.join(" "))]) {
      for (const m of t.matchAll(COUNT)) {
        const n = num(m[1]);
        if (n === null || n === target) continue;
        looks.push({ kind: "numbers", text: `“${`${m[1]} ${m[2]}${m[3]}`.trim()}” says ${n}, but “${head}” shows ${target} items.`, where: [head], source_keys: [s.key] });
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
        if (total === null || total === per * count[0]) continue;
        const where = [sec, count[1], ts];
        looks.push({
          kind: "numbers",
          text: `${per} ${m[3]} per ${thing} × ${count[2]} is ${per * count[0]}, but the company-wide target says ${total}.`,
          where: [...new Set(where.map((x) => plain(x.heading)))],
          source_keys: [...new Set(where.map((x) => x.key))],
        });
        break;
      }
    }
  }
  return looks;
}

/** one_pager_checks.annotate: fills the blocks' clear-reading fields in place; the "Needs a look" items. */
export function annotate(blocks: Block[], secs: Sec[], cites: Cites = {}): Look[] {
  const names = glossary(secs), notes = footnoteNotes(secs), found = measures(secs, cites), who = whoHasIt(secs);
  const unnamed = new Map<string, string[]>();
  for (const b of blocks) {
    if (b.key === "problem") b.who = who;
    for (const x of b.lines ?? []) {
      const said = x.full ?? x.text;
      let missing: string[];
      [x.text, missing] = withNames(x.text, names);
      if (x.full) x.full = withNames(x.full, names)[0];
      for (const c of missing) unnamed.set(c, [...(unnamed.get(c) ?? []), ...x.source_keys]);
      [x.text, x.footnotes] = marked(x.text, notes);
      if (x.full) x.full = marked(x.full, notes)[0];
      if (x.metric) x.metric = { ...x.metric, name: marked(withNames(x.metric.name, names)[0], notes)[0], to: marked(x.metric.to, notes)[0] };
      // The Edit box starts from the PRD's words, not the names and marks put in.
      x.words = (x.full ?? x.text) !== said ? said : null;
      if (b.kind === "metrics") {
        const m = measureFor(x.full ?? x.text, x.metric?.name ?? null, found);
        x.measure = m?.measure ?? null;
        x.measure_source = m?.source ?? null;
      }
    }
  }
  const heads = Object.fromEntries(secs.map((s) => [s.key, plain(s.heading)]));
  const looks: Look[] = [...unnamed].map(([code, keys]) => {
    const k = [...new Set(keys)];
    return { kind: "code", text: `${code} has no name in the PRD.`, where: k.map((x) => heads[x] ?? x), source_keys: k };
  });
  return [...looks, ...numbers(secs)];
}
