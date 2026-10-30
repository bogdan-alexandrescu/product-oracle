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

const plain = (t: string) => (t ?? "").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[*_`]+|\{#[^}]*\}|<!--.*?-->/g, "").split(/\s+/).filter(Boolean).join(" ");
const sentences = (t: string) => t.split(/(?<=[.!?])\s+/).filter(Boolean);

function rows(body: string): { bullets: string[]; cells: string[][]; prose: string[] } {
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

export function whoHasIt(secs: Sec[]): string | null {
  for (const s of secs) {
    if (!/\b(?:users?|personas?|who\b|audiences?|customers?)/i.test(s.heading) || /problem/i.test(s.heading)) continue;
    const { bullets, cells, prose } = rows(s.body);
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

function measureIn(text: string): Measure | null {
  const m = MEASURE.exec(text);
  if (!m) return null;
  const rest = text.slice(m.index + m[0].length);
  const s = SOURCE.exec(rest);
  const measure = trimP(s ? rest.slice(0, s.index) : rest);
  return measure ? { name: trimP(text.slice(0, m.index)), measure, source: s ? trimP(s[1]) || null : null } : null;
}

function measures(secs: Sec[]): Measure[] {
  const out: Measure[] = [];
  for (const s of secs) {
    const { bullets, cells, prose } = rows(s.body);
    for (const t of [...bullets, ...sentences(prose.join(" "))]) {
      const m = measureIn(t);
      if (m) out.push(m);
    }
    const lines = s.body.split("\n");
    const at = lines.findIndex((l, i) => i > 0 && TABLE_SEP.test(l) && l.includes("-") && lines[i - 1].trim().startsWith("|"));
    const head = at > 0 ? lines[at - 1].trim().replace(/^\||\|$/g, "").split("|").map((c) => plain(c).toLowerCase()) : [];
    const mcol = head.findIndex((h, i) => i > 0 && /defin|measure|counted|how/.test(h));
    const scol = head.findIndex((h, i) => i > 0 && /source|data|where/.test(h));
    for (const r of cells) {
      if (mcol > 0 && r[mcol]) out.push({ name: r[0], measure: r[mcol], source: scol > 0 && r[scol] ? r[scol] : null });
      else {
        const m = measureIn(r.join(" · "));
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

const CODE = /\b(?:[A-Z]{1,3}-\d{1,4}|P[0-3])\b/g;
const PRIORITY: Record<string, string> = { P0: "top priority", P1: "high priority", P2: "medium priority", P3: "low priority" };
const NAMED = /^\s*(?:[:=—–]|\s-\s|\()\s*([A-Za-z][^.;,()|:\n]*)/;
const CAPITAL = /^\s+([A-Z][^.;,()|:\n]*)/;
const nameOf = (t: string) => t.split(/\s+/).filter(Boolean).slice(0, 5).join(" ").replace(/^[\s\-—–]+|[\s\-—–]+$/g, "");
const isCode = (t: string) => new RegExp(`^${CODE.source}$`).test(t);

function glossary(secs: Sec[]): Record<string, string> {
  const out: Record<string, string> = {};
  const put = (c: string, n: string) => { if (!(c in out) && n) out[c] = n; };
  for (const s of secs) {
    for (const raw of [s.heading, ...s.body.split("\n")]) {
      if (raw.trim().startsWith("|")) {
        const cells = raw.trim().replace(/^\||\|$/g, "").split("|").map(plain);
        cells.slice(0, -1).forEach((c, i) => { if (isCode(c) && cells[i + 1] && !isCode(cells[i + 1])) put(c, nameOf(cells[i + 1])); });
        continue;
      }
      const m = BULLET.exec(raw);
      const text = plain((m ? m[1] : raw).replace(/^[#\s]+/, ""));
      for (const c of text.matchAll(CODE)) {
        const rest = text.slice(c.index! + c[0].length);
        const n = NAMED.exec(rest) ?? (c.index === 0 ? CAPITAL.exec(rest) : null);
        if (n) put(c[0], nameOf(n[1]));
      }
    }
  }
  return out;
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
  for (const s of secs) for (const raw of s.body.split("\n")) {
    const m = /^\s*(?:[-*+]\s+)?([†‡§])\s*(\S.*)$/.exec(raw);
    if (m && !(m[1] in out)) out[m[1]] = plain(m[2]);
  }
  return out;
}

function marked(text: string, notes: Record<string, string>): [string, string[]] {
  const kept: string[] = [];
  const out = text.replace(/(?<=\S)([†‡§])/g, (mark: string) => {
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
export function annotate(blocks: Block[], secs: Sec[]): Look[] {
  const names = glossary(secs), notes = footnoteNotes(secs), found = measures(secs), who = whoHasIt(secs);
  const unnamed = new Map<string, string[]>();
  for (const b of blocks) {
    if (b.key === "problem") b.who = who;
    for (const x of b.lines ?? []) {
      let missing: string[];
      [x.text, missing] = withNames(x.text, names);
      if (x.full) x.full = withNames(x.full, names)[0];
      for (const c of missing) unnamed.set(c, [...(unnamed.get(c) ?? []), ...x.source_keys]);
      [x.text, x.footnotes] = marked(x.text, notes);
      if (x.full) x.full = marked(x.full, notes)[0];
      if (x.metric) x.metric = { ...x.metric, name: marked(withNames(x.metric.name, names)[0], notes)[0], to: marked(x.metric.to, notes)[0] };
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
