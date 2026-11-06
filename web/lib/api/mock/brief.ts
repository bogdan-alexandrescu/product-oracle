/**
 * Mock of the brief and full layers (O1f): which sections are brief, presenter notes,
 * the deck Present mode shows, and the Brief / Full / Deck exports. The real API
 * renders slides server-side (oracle.export.deck); this is a small stand-in with the
 * same shape.
 */
import type { Schemas } from "@/lib/api/client";
import { parseBlocks, type Block, type Inline } from "@/lib/markdown";

import { companyZone } from "./connections";

type Section = { section_key: string; level: number; heading: string; body_md: string; layer?: Schemas["SectionOut"]["layer"] };
type Layered = { brief_source: Schemas["VersionOut"]["brief_source"]; brief: Set<string> };

const NOTES = /^```[ \t]*notes[ \t]*\n([\s\S]*?)^```[ \t]*$\n?/gm;
const COMMENT = /<!--([\s\S]*?)-->/g;
const LINK = /\]\(#([A-Za-z0-9][\w.:-]*)\)/g;

/** Front matter brief, else the sections before a level-1 {#full} heading (minus the title). */
export function resolveBrief(sections: { section_key: string; level: number }[], brief?: string[]): Layered {
  const keys = sections.map((s) => s.section_key);
  const sources = keys.indexOf("sources");
  const excluded = new Set(["full", ...(sources >= 0 ? keys.slice(sources) : [])]);
  if (brief) return { brief_source: "draft", brief: new Set(brief.filter((k) => keys.includes(k) && !excluded.has(k))) };
  const full = sections.findIndex((s) => s.section_key === "full" && s.level === 1);
  if (full > 0) {
    const before = sections.slice(sections[0].level === 1 ? 1 : 0, full).map((s) => s.section_key);
    if (before.length) return { brief_source: "full_heading", brief: new Set(before) };
  }
  return { brief_source: "none", brief: new Set() };
}

export function slideBody(md: string): string {
  return md.replace(NOTES, "").replace(COMMENT, "").trim();
}

/** Presenter notes come only from ```notes blocks (O1g); guidance is never used. */
export function presenterNotes(md: string): string | null {
  const notes = [...md.matchAll(NOTES)].map((m) => m[1].trim()).filter(Boolean);
  return notes.length ? notes.join("\n\n") : null;
}

function linked(md: string): string[] {
  return [...new Set([...slideBody(md).matchAll(LINK)].map((m) => m[1]))];
}

/** The section and the deeper sections after it. */
export function subtree<T extends { section_key: string; level: number }>(sections: T[], key: string): T[] {
  const i = sections.findIndex((s) => s.section_key === key);
  if (i < 0) return [];
  const out = [sections[i]];
  for (const s of sections.slice(i + 1)) {
    if (s.level <= sections[i].level) break;
    out.push(s);
  }
  return out;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** A calendar day standing alone in prose reads month first, "Nov 1, 2026" (export/render.py days_in_words). */
const PROSE_DAY = /(?<![\w./-])(\d{4})-(\d{2})-(\d{2})(?![\w/-]|:\d)/g;
export function daysInWords(text: string): string {
  return text.replace(PROSE_DAY, (all, y: string, m: string, d: string) => {
    const month = Number(m);
    const day = Number(d);
    const valid = month >= 1 && month <= 12 && day >= 1 && day <= new Date(Date.UTC(Number(y), month, 0)).getUTCDate();
    return valid ? heldTogether(`${MONTHS[month - 1]} ${day}, ${Number(y)}`) : all;
  });
}
/** A date's parts joined by no-break spaces, so it never wraps mid-date (export/render.py held_together, E-11). */
export const heldTogether = (words: string) => words.replace(/ /g, "\u00a0");

/** A goal's code and its name where the PRD names it, "**G2 (retention)**" (export/deck.py goal_names). */
const GOAL_NAMED = /\b(G\d{1,3})\b\**\s*\(([A-Za-z][^()\n]{0,40})\)/g;
const GOAL_CELL = /(?<=\|)([ \t]*)(G\d{1,3})([ \t]*)(?=\|)/g;
export function goalNames(sections: { heading: string; body_md: string }[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const s of sections)
    for (const m of `${s.heading}\n${s.body_md ?? ""}`.matchAll(GOAL_NAMED)) {
      const name = m[2].trim();
      if (!out.has(m[1])) out.set(m[1], name.charAt(0).toUpperCase() + name.slice(1));
    }
  return out;
}
/** A table cell holding only a goal's code shows its name too: "G2 Retention" (export/deck.py with_goal_names). */
export function withGoalNames(body: string, names: Map<string, string>): string {
  return names.size ? body.replace(GOAL_CELL, (all, a: string, code: string, b: string) => (names.has(code) ? `${a}${code} ${names.get(code)}${b}` : all)) : body;
}

// A section past what a slide holds goes on continuation slides, "Top risks (2 of 2)" (export/deck.py slide_pages).
const SLIDE_LINES = 15;
const LINE_CHARS = 95;
// A piece of a unit longer than a slide carries the glue that joins it to the piece before it
// when both land on one slide (" " within a line, "\n" between lines); "" otherwise.
type Unit = { text: string; cost: number; group: number; kind: "block" | "item" | "row"; header: string; glue?: string };
const lineCost = (text: string) =>
  text
    .replace(/\]\([^)]*\)/g, "]")
    .replace(/\[c:[^\]]*\]/g, "")
    .split("\n")
    .filter((l) => l.trim())
    .reduce((n, l) => n + Math.max(1, Math.ceil(l.trim().length / LINE_CHARS)), 0);
const SENTENCE_END = /(?<=[.!?])\s+(?=\S)/;
/** Atoms ([glue, text]) packed into pieces each within room(i) by cost (export/deck.py _fill). */
function fill(atoms: [string, string][], room: (i: number) => number, cost: (t: string) => number): [string, string][] {
  const pieces: [string, string][] = [];
  let glue = "";
  let text = "";
  for (const [g, atom] of atoms) {
    if (!text) [glue, text] = [g, atom];
    else if (cost(text + g + atom) > room(pieces.length)) {
      pieces.push([glue, text]);
      [glue, text] = [g, atom];
    } else text += g + atom;
  }
  if (text) pieces.push([glue, text]);
  return pieces;
}
/** A paragraph or list item longer than a slide, cut between sentences, else words (export/deck.py _prose_pieces). */
function prosePieces(heading: string, text: string, group: number, kind: Unit["kind"], budget: number): Unit[] {
  const lead = heading ? 1.5 : 0;
  const cost = lineCost(text) + 0.4 + lead;
  if (cost <= budget) return [{ text: heading + text, cost, group, kind, header: "" }];
  const atoms: [string, string][] = [];
  text.split("\n").forEach((line, n) =>
    line.split(SENTENCE_END).forEach((sentence, m) => {
      const glue = n === 0 && m === 0 ? "" : m ? " " : "\n";
      if (lineCost(sentence) + 0.4 + lead > budget) sentence.split(" ").forEach((w, k) => atoms.push([k === 0 ? glue : " ", w]));
      else atoms.push([glue, sentence]);
    }),
  );
  return fill(atoms, (i) => budget - 0.4 - (i === 0 ? lead : 0), lineCost).map(([glue, piece], i) => ({
    text: (i === 0 ? heading : "") + piece,
    cost: lineCost(piece) + 0.4 + (i === 0 ? lead : 0),
    group,
    kind: i === 0 || glue === "\n" ? kind : "block",
    header: "",
    glue,
  }));
}
/** A deck shows no code (owner, Nov 5): each fenced block is one line, "Code: 40 lines, in the full PRD", a link to that place in the full PRD (export/deck.py code_left_out). */
export function codeLeftOut(body: string, href: string): string {
  const lines = body.split("\n");
  const out: string[] = [];
  const fence = (l: string) => /^\s*(```|~~~)/.test(l);
  for (let i = 0; i < lines.length; ) {
    if (!fence(lines[i])) {
      out.push(lines[i++]);
      continue;
    }
    let j = i + 1;
    while (j < lines.length && !fence(lines[j])) j++;
    const n = j - i - 1;
    out.push(`${/^\s*/.exec(lines[i])![0]}[Code: ${n} ${n === 1 ? "line" : "lines"}, in the full PRD](${href})`);
    i = j + 1;
  }
  return out.join("\n");
}
const cellsOf = (row: string) => row.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
/** Characters a line each column is shown at, as a browser lays the table out: a column whose text fits its share keeps it, the others share the rest by their text (export/deck.py column_widths). */
function columnWidths(rows: string[][]): number[] {
  const cols = Math.max(1, ...rows.map((r) => r.length));
  const natural = Array.from({ length: cols }, (_, c) => Math.max(0, ...rows.map((r) => (r[c] ?? "").length)) + 2);
  const widths = new Array<number>(cols).fill(0);
  let left = [...natural.keys()];
  let room = LINE_CHARS;
  while (left.length) {
    const share = room / left.length;
    const fixed = left.filter((c) => natural[c] <= share);
    if (!fixed.length) {
      const total = left.reduce((n, c) => n + natural[c], 0);
      for (const c of left) widths[c] = Math.floor((room * natural[c]) / total);
      break;
    }
    for (const c of fixed) {
      widths[c] = natural[c];
      room -= natural[c];
    }
    left = left.filter((c) => !fixed.includes(c));
  }
  return widths.map((w) => Math.max(1, w - 2));
}
const rowCost = (cells: string[], widths: number[]) => 1.2 * Math.max(1, ...cells.slice(0, widths.length).map((t, c) => Math.ceil(t.length / widths[c])));
/** A table row longer than a slide as rows that each fit, each cell's text cut in turn (export/deck.py _row_pieces). */
function rowPieces(lead: string, row: string, extra: number, widths: number[], group: number, header: string, budget: number): Unit[] {
  const cells = cellsOf(row);
  const lines = Math.min(Math.max(1, Math.floor((budget - extra) / 1.2)), Math.max(1, Math.floor(budget / 1.2)));
  const width = cells.map((_, c) => widths[c] ?? widths[widths.length - 1]);
  const cut = (cell: string, room: number): string[] => {
    let atoms: [string, string][] = cell.split(SENTENCE_END).map((a, k) => [k ? " " : "", a]);
    if (atoms.some(([, a]) => a.length > room)) atoms = cell.split(" ").map((w, k) => [k ? " " : "", w]);
    const pieces = fill(atoms, () => room, (t) => t.length).map(([, p]) => p);
    return pieces.length ? pieces : [""];
  };
  const parts = cells.map((c, i) => cut(c, lines * width[i]));
  const count = Math.max(...parts.map((p) => p.length));
  return Array.from({ length: count }, (_, r) => {
    const texts = parts.map((p) => p[r] ?? "");
    const cost = rowCost(texts, width) + (r === 0 ? extra : 0);
    return { text: (r === 0 ? lead : "") + `| ${texts.join(" | ")} |`, cost, group, kind: "row" as const, header };
  });
}
function units(body: string, budget = SLIDE_LINES): Unit[] {
  const out: Unit[] = [];
  const lines = body.split("\n");
  let group = 0;
  let heading = "";
  let i = 0;
  const item = (l: string) => /^(?:[-*+]|\d{1,3}[.)])\s/.test(l);
  const fence = (l: string) => /^\s*(```|~~~)/.test(l);
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      group++;
      i++;
    } else if (fence(line)) {
      let j = i + 1;
      while (j < lines.length && !fence(lines[j])) j++;
      const block = lines.slice(i, j + 1);
      out.push({ text: heading + block.join("\n"), cost: block.length + 0.4, group, kind: "block", header: "" });
      heading = "";
      i = j + 1;
      group++;
    } else if (line.trimStart().startsWith("#")) {
      heading += line + "\n\n";
      i++;
      group++;
    } else if (line.trimStart().startsWith("|")) {
      let j = i;
      while (j < lines.length && lines[j].trimStart().startsWith("|")) j++;
      const rows = lines.slice(i, j);
      const head = rows.length > 1 && /^\s*\|?\s*:?-{2,}/.test(rows[1]) ? rows.slice(0, 2) : [];
      const header = head.join("\n");
      const widths = columnWidths(rows.filter((r) => !/^\s*\|?\s*:?-{2,}/.test(r)).map(cellsOf));
      rows.slice(head.length).forEach((row, k) => {
        const extra = k === 0 && header ? 1.2 : 0;
        const cost = rowCost(cellsOf(row), widths) + extra;
        const lead = k === 0 && header ? heading + header + "\n" : "";
        if (cost <= budget) out.push({ text: lead + row, cost, group, kind: "row", header });
        else out.push(...rowPieces(lead, row, extra, widths, group, header, budget));
        heading = "";
      });
      i = j;
      group++;
    } else {
      let j = i + 1;
      const kind = item(line) ? "item" : "block";
      if (kind === "item") while (j < lines.length && lines[j].trim() && /^\s/.test(lines[j])) j++;
      else while (j < lines.length && lines[j].trim() && !/^\s*[|#]/.test(lines[j]) && !item(lines[j]) && !fence(lines[j])) j++;
      out.push(...prosePieces(heading, lines.slice(i, j).join("\n"), group, kind, budget));
      heading = "";
      i = j;
    }
  }
  if (heading) out.push({ text: heading.trim(), cost: 1.5, group: group + 1, kind: "block", header: "" });
  return out;
}
function pack(us: Unit[], budget: number): Unit[][] {
  const pages: Unit[][] = [[]];
  let used = 0;
  for (const u of us) {
    if (pages[pages.length - 1].length && used + u.cost > budget) {
      pages.push([]);
      used = 0;
    }
    pages[pages.length - 1].push(u);
    used += u.cost;
  }
  return pages;
}
function join(page: Unit[]): string {
  let out = "";
  let prev: Unit | null = null;
  for (const u of page) {
    let text = u.text;
    if (!prev && u.kind === "row" && u.header && !text.includes(u.header)) text = `${u.header}\n${text}`;
    if (prev && u.glue) out += u.glue;
    else if (prev) out += prev.group === u.group && u.kind === prev.kind && u.kind !== "block" ? "\n" : "\n\n";
    out += text;
    prev = u;
  }
  return out;
}
export function slidePages(body: string, budget = SLIDE_LINES): string[] {
  const us = units(body, budget);
  const total = us.reduce((n, u) => n + u.cost, 0);
  if (total <= budget || us.length < 2) return [body];
  const count = pack(us, budget).length;
  let even = Math.max(total / count, ...us.map((u) => u.cost));
  let pages = pack(us, even);
  while (pages.length > count) pages = pack(us, (even = Math.min(even + 0.5, budget)));
  return pages.filter((p) => p.length).map(join);
}

function inline(nodes: Inline[], links: (key: string, inner: string) => string): string {
  return nodes
    .map((n) => {
      switch (n.t) {
        case "text":
          return esc(daysInWords(n.v));
        case "code":
          return `<code>${esc(n.v)}</code>`;
        case "strong":
          return `<strong>${inline(n.c, links)}</strong>`;
        case "em":
          return `<em>${inline(n.c, links)}</em>`;
        case "link":
          return n.href.startsWith("#") ? links(n.href.slice(1), inline(n.c, links)) : `<a href="${esc(n.href)}">${inline(n.c, links)}</a>`;
        case "img":
          return /^https:\/\//i.test(n.src) ? `<img src="${esc(n.src)}" alt="${esc(n.alt)}">` : "";
        case "cite":
          return "";
      }
    })
    .join("");
}

export function toHtml(md: string, links: (key: string, inner: string) => string): string {
  const blocks: Block[] = parseBlocks(slideBody(md));
  return blocks
    .map((b) => {
      switch (b.t) {
        case "p":
          return `<p>${inline(b.c, links)}</p>`;
        case "h":
          return `<h4>${inline(b.c, links)}</h4>`;
        case "quote":
          return `<blockquote>${inline(b.c, links)}</blockquote>`;
        case "pre":
          return "";
        case "ul":
        case "ol":
          return `<${b.t}>${b.items.map((it) => `<li>${inline(it, links)}</li>`).join("")}</${b.t}>`;
        case "table":
          return `<table><thead><tr>${b.head.map((c) => `<th>${inline(c, links)}</th>`).join("")}</tr></thead><tbody>${b.rows
            .map((r) => `<tr>${r.map((c) => `<td>${inline(c, links)}</td>`).join("")}</tr>`)
            .join("")}</tbody></table>`;
      }
    })
    .join("");
}

const DECK_CSS = `
.deck { --font-body: "DejaVu Sans", Helvetica, Arial, sans-serif; --color-text: #1f2933; --color-heading: #111827;
  --color-muted: #5b6472; --color-accent: #2f5bd3; --color-background: #ffffff; --color-rule: #d9dde3; --color-surface: #f3f4f6;
  color: var(--color-text); font-family: var(--font-body); }
.deck .slide { box-sizing: border-box; position: relative; width: 960px; height: 540px; overflow: hidden; background: var(--color-background);
  font-size: 21px; line-height: 1.4; padding: 44px 60px 56px; display: flex; flex-direction: column; }
.deck .slide-inner { flex: 1; min-height: 0; overflow: hidden; }
.deck .slide-title { color: var(--color-heading); font-size: 34px; line-height: 1.15; margin: 0 0 22px; font-weight: 700; }
.deck h1.slide-title { font-size: 46px; }
.deck .slide-kicker { margin: 120px 0 10px; font: 600 15px/1 var(--font-body); text-transform: uppercase; letter-spacing: .12em; color: var(--color-accent); }
.deck .slide-subtitle { color: var(--color-muted); font-size: 19px; margin: 0; }
.deck .slide-source { color: var(--color-muted); font-size: 16px; margin: 8px 0 0; }
.deck .slide-body p, .deck .slide-body ul, .deck .slide-body ol { margin: 0 0 12px; }
.deck .slide-dense { font-size: 17px; }
.deck .slide-dense .slide-title { font-size: 28px; margin-bottom: 14px; }
.deck .slide-dense .slide-body table { font-size: 14px; }
.deck .slide-dense .slide-body th, .deck .slide-dense .slide-body td { padding: 4px 8px; }
.deck .slide-body table { border-collapse: collapse; width: 100%; font-size: 17px; }
.deck .slide-body th, .deck .slide-body td { text-align: left; padding: 6px 10px; border-bottom: 1px solid var(--color-rule); }
.deck .slide-body th { color: var(--color-muted); font-size: 14px; text-transform: uppercase; }
.deck .slide-body .slide-subheading { color: var(--color-heading); font-size: 20px; margin: 10px 0 6px; }
.deck .slide-body a { color: var(--color-accent); text-decoration: none; }
.deck .expand { margin-left: 6px; font: 600 12px/1 var(--font-body); color: var(--color-accent); background: transparent;
  border: 1px solid var(--color-rule); border-radius: 4px; padding: 3px 6px; cursor: pointer; }
.deck .slide-footer { position: absolute; left: 60px; right: 60px; bottom: 18px; display: flex; justify-content: space-between;
  font-size: 12px; color: var(--color-muted); border-top: 1px solid var(--color-rule); padding-top: 8px; }
.deck .slide-sources { font-size: 16px; }
.deck .expand-section h3, .deck .expand-section h4 { color: var(--color-heading); margin: 0 0 10px; }
.theme-clean-document .slide-title { border-top: 4px solid var(--color-accent); padding-top: 14px; }
.theme-clean-document h1.slide-title { border-top: 0; padding-top: 0; }
`;

type DeckInput = {
  document_id: string;
  slug: string;
  title: string;
  /** The document's kind: the title slide's kicker (export/deck.py KICKER, qa-docs-63). */
  kind?: string;
  number: number;
  latest: number;
  status: string;
  created_at: string;
  /** Provenance (O4b): the PRD version a roadmap version was built from. */
  source?: Schemas["VersionSource"] | null;
  sections: Section[];
  citations: { cite_key: string; title?: string | null; ref: string; source: string }[];
  /**
   * H8: front matter `slides`, groups of brief section keys; a group is one slide (its first
   * section's heading and body, then each further section as a sub-heading and body). Brief
   * sections in no group keep a slide each, after the groups.
   */
  slides?: string[][];
};

const KICKER: Record<string, string> = {
  prd: "PRD",
  roadmap: "Roadmap",
  spec: "Spec",
  vision: "Vision",
  strategy: "Strategy",
  update: "Update",
  pricing: "Pricing memo",
};

const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** "Oct 18, 2026, 1:30 AM PDT": the Company time zone, in words, as the API's deck banner (export/deck.py _moment). */
function momentInWords(at: string): string {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: companyZone(),
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
      timeZoneName: "short",
    })
      .formatToParts(new Date(at))
      .map((x) => [x.type, x.value]),
  );
  // Each part held on one line (E-11): "Oct 18, 2026," then "1:30 AM PDT".
  return `${heldTogether(`${p.month} ${p.day}, ${p.year}`)}, ${heldTogether(`${p.hour}:${p.minute} ${p.dayPeriod} ${p.timeZoneName}`)}`;
}

export function deckOut(d: DeckInput): Schemas["DeckOut"] {
  const sections = d.sections;
  const brief = sections.filter((s) => s.layer === "brief");
  const briefKeys = new Set(brief.map((s) => s.section_key));
  const detail = new Set(sections.filter((s) => s.layer !== "brief").map((s) => s.section_key));
  const sourceLabel = d.source ? `From ${d.source.title} v${d.source.version}` : null;
  const banner = [
    d.title,
    `Version ${d.number}`,
    capitalise(d.status.replace("_", " ")),
    `Imported ${momentInWords(d.created_at)}`,
    ...(sourceLabel ? [sourceLabel] : []),
  ].join(" · ");
  const slideLinks = (key: string, inner: string) =>
    briefKeys.has(key)
      ? `<a href="#${esc(key)}">${inner}</a>`
      : detail.has(key)
        ? `<span class="detail-ref" data-section-ref="${esc(key)}">${inner}</span><button type="button" class="expand" data-expand="${esc(key)}" aria-label="Expand ${esc(inner.replace(/<[^>]+>/g, ""))}">Expand</button>`
        : inner;
  const plainLinks = (_key: string, inner: string) => inner;
  // dense: the smaller type of a long or continued slide (export/deck.py DENSE_CHARS, DENSE_ROWS).
  type Raw = Omit<Schemas["SlideOut"], "html"> & { inner: string; dense?: boolean };
  const raw: Raw[] = [
    {
      index: 1,
      kind: "title",
      heading: d.title,
      expand: [],
      inner: `<p class="slide-kicker">${esc(KICKER[d.kind ?? ""] ?? "Brief")}</p><h1 class="slide-title">${esc(d.title)}</h1><p class="slide-subtitle">Version ${d.number} · ${esc(capitalise(d.status.replace("_", " ")))}</p>${sourceLabel ? `<p class="slide-source">${esc(sourceLabel)}</p>` : ""}`,
    },
  ];
  const grouped = new Set<string>();
  const groups: Section[][] = [];
  for (const keys of d.slides ?? []) {
    const group = keys.map((k) => brief.find((s) => s.section_key === k)).filter((s): s is Section => !!s && !grouped.has(s.section_key));
    group.forEach((s) => grouped.add(s.section_key));
    if (group.length) groups.push(group);
  }
  for (const s of brief) if (!grouped.has(s.section_key)) groups.push([s]);
  // In document order: a group sits where its first section does.
  const order = new Map(brief.map((s, i) => [s.section_key, i]));
  if (d.slides?.length) groups.sort((a, b) => order.get(a[0].section_key)! - order.get(b[0].section_key)!);
  const goals = goalNames(sections);
  for (const [s, ...rest] of groups) {
    const all = [s, ...rest];
    const notes = all.map((x) => presenterNotes(x.body_md)).filter(Boolean);
    // As the API: a section's code is one line linking to it in the full PRD (export/deck.py code_left_out).
    const shown = (x: Section) => codeLeftOut(slideBody(x.body_md), `/documents/${d.slug}/v/${d.number}#s-${x.section_key}`);
    const whole = withGoalNames([shown(s), ...rest.map((x) => `### ${x.heading}\n\n${shown(x)}`)].join("\n\n"), goals);
    // As the API: a spec part's state label takes two lines of the slide (export/deck.py build_deck).
    const states = (s as { spec_states?: { label: string }[] }).spec_states ?? [];
    const pages = slidePages(whole, SLIDE_LINES - (states.length ? 2 : 0));
    pages.forEach((body, p) => {
    const heading = daysInWords(s.heading) + (pages.length > 1 ? ` (${p + 1} of ${pages.length})` : "");
    raw.push({
      index: raw.length + 1,
      kind: "section",
      heading,
      section_key: s.section_key,
      ...(states.length ? { state: states[0].label } : {}),
      dense: pages.length > 1 || body.length > 520 || body.split("\n|").length - 1 > 6,
      notes: p === 0 && notes.length ? daysInWords(notes.join("\n\n")) : null,
      expand: [...new Set(linked(body))]
        .filter((k) => detail.has(k))
        .map((k) => ({
          section_key: k,
          heading: sections.find((x) => x.section_key === k)!.heading,
          html: subtree(sections, k)
            .map((x) => `<section class="expand-section" data-section-key="${esc(x.section_key)}"><h3>${esc(x.heading)}</h3>${toHtml(x.body_md, plainLinks)}</section>`)
            .join(""),
        })),
      inner: `<h2 class="slide-title">${esc(heading)}</h2><div class="slide-body">${toHtml(body, slideLinks)}</div>`,
    });
    });
  }
  if (d.citations.length) {
    raw.push({
      index: raw.length + 1,
      kind: "sources",
      heading: "Sources and data points",
      expand: [],
      inner: `<h2 class="slide-title">Sources and data points</h2><ol class="slide-sources">${d.citations
        .map((c) => `<li>${esc(c.title ?? c.ref)} <span class="src-kind">${esc(c.source)}</span></li>`)
        .join("")}</ol>`,
    });
  }
  const total = raw.length;
  return {
    document_id: d.document_id,
    slug: d.slug,
    title: d.title,
    number: d.number,
    latest_number: d.latest,
    status: d.status,
    as_of: momentInWords(d.created_at),
    banner,
    source: d.source ?? null,
    theme: "clean-document",
    theme_name: "Clean document",
    theme_class: "theme-clean-document",
    css: DECK_CSS,
    slides: raw.map(({ inner, dense, ...s }) => ({
      ...s,
      expand: s.expand ?? [],
      notes: s.notes ?? null,
      section_key: s.section_key ?? null,
      html: `<section class="slide slide--${s.kind}${dense ? " slide-dense" : ""}" data-slide="${s.index}"${s.section_key ? ` data-section-key="${esc(s.section_key)}"` : ""} aria-label="Slide ${s.index} of ${total}: ${esc(s.heading)}"><div class="slide-inner">${inner}</div><footer class="slide-footer"><span class="slide-banner">${esc(banner)}</span><span class="slide-number">${s.index} / ${total}</span></footer></section>`,
    })),
  };
}

export const LAYER_FORMATS: Record<string, string[]> = {
  full: ["html", "pdf", "md"],
  brief: ["html", "pdf"],
  deck: ["html", "pdf", "pptx"],
};

export const PPTX_TYPE = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
