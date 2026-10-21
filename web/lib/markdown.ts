/**
 * A deliberately small markdown subset for PRD section bodies: paragraphs, lists,
 * blockquotes, fenced code, tables, minor headings, and inline code / strong /
 * emphasis / links / `[c:<id>]` citations. Fenced ```notes blocks (presenter notes)
 * are left out.
 *
 * The UI renders this tree itself (rather than via an HTML string) so comment
 * highlights can be placed by text offset: the text of a section is the
 * concatenation of its text and code leaves, in order. Citations add no text.
 */

export type Inline =
  | { t: "text"; v: string }
  | { t: "code"; v: string }
  | { t: "strong"; c: Inline[] }
  | { t: "em"; c: Inline[] }
  | { t: "link"; href: string; c: Inline[] }
  | { t: "img"; src: string; alt: string }
  | { t: "cite"; key: string };

export type Block =
  | { t: "p"; c: Inline[] }
  | { t: "h"; level: number; c: Inline[] }
  | { t: "ul" | "ol"; items: Inline[][] }
  | { t: "quote"; c: Inline[] }
  | { t: "pre"; v: string }
  | { t: "table"; head: Inline[][]; rows: Inline[][][] };

// Citation ids are those the API accepts ([A-Za-z0-9_.:-]); an image is matched before a
// link, so its alt text never shows as link text. Alt and link text, a destination and
// emphasized text are length-bounded, so many unclosed `![`, `[`, `*` or `_` scan a bounded
// stretch each (linear overall, not quadratic); a longer one reads as plain text.
const INLINE =
  /\[c:([\w.:-]+)\]|!\[([^\]]{0,500})\]\(([^)\s]{1,1000})\)|`([^`]+)`|\*\*(.{1,500}?)\*\*|\[([^\]]{1,500})\]\(([^)\s]{1,1000})\)|(?<![\w*])\*(?!\s)(.{1,500}?)(?<!\s)\*(?![\w*])|(?<!\w)_(?!\s)(.{1,500}?)(?<!\s)_(?!\w)/g;

/**
 * Owner decision (2026-10-20): an image loads only when Oracle stores it, a path of this
 * app under STORED_IMAGES. The path a stored image loads from, or null for anything else:
 * a backslash or control character (a browser reads `/\evil.com/p.png` as evil.com), another
 * origin, or a path that leaves the prefix once resolved (`/uploads/../v1/me`, `%2e%2e`).
 */
export const STORED_IMAGES = "/uploads/";

export function storedImageSrc(src: string): string | null {
  if (!src.startsWith(STORED_IMAGES) || /[\\\u0000-\x20\u007f-\u009f]/.test(src)) return null;
  const origin = typeof window !== "undefined" ? window.location.origin : "http://oracle.invalid";
  let url: URL;
  try {
    url = new URL(src, origin);
  } catch {
    return null;
  }
  if (url.origin !== origin || !url.pathname.startsWith(STORED_IMAGES)) return null;
  return url.pathname + url.search;
}

/**
 * Whether a link destination may render as a link: http, https, mailto, or relative or an
 * anchor (no scheme). Any other scheme (javascript:, vbscript:, data:, ...) is plain text.
 * Control characters and spaces inside the scheme are ignored, as a browser does.
 */
export function isSafeHref(href: string): boolean {
  const head = href.replace(/[\u0000-\u0020\u007f-\u009f]/g, "");
  const m = /^([a-z][a-z0-9+.-]*):/i.exec(head);
  return !m || ["http", "https", "mailto"].includes(m[1].toLowerCase());
}

export function parseInline(src: string): Inline[] {
  const out: Inline[] = [];
  let last = 0;
  const pushText = (v: string) => {
    if (!v) return;
    const prev = out[out.length - 1];
    if (prev?.t === "text") prev.v += v;
    else out.push({ t: "text", v });
  };
  for (const m of src.matchAll(new RegExp(INLINE))) {
    pushText(src.slice(last, m.index));
    last = m.index + m[0].length;
    if (m[1] !== undefined) out.push({ t: "cite", key: m[1] });
    else if (m[3] !== undefined) out.push({ t: "img", alt: m[2], src: m[3] });
    else if (m[4] !== undefined) out.push({ t: "code", v: m[4] });
    else if (m[5] !== undefined) out.push({ t: "strong", c: parseInline(m[5]) });
    else if (m[6] !== undefined) out.push({ t: "link", href: m[7], c: parseInline(m[6]) });
    else if (m[8] !== undefined) out.push({ t: "em", c: parseInline(m[8]) });
    else if (m[9] !== undefined) out.push({ t: "em", c: parseInline(m[9]) });
  }
  pushText(src.slice(last));
  return out;
}

const UL = /^\s*[-*+]\s+(.*)$/;
const OL = /^\s*\d+[.)]\s+(.*)$/;
// As CommonMark: a block starts with at most three spaces of indentation (more continues
// the paragraph), and a list interrupts a paragraph only with a non-empty item, an
// ordered one only when it starts at 1.
const UL_START = /^ {0,3}[-*+][ \t]+\S/;
const OL_START = /^ {0,3}0*1[.)][ \t]+\S/;
const HEADING = /^(#{1,6})\s+(.*?)\s*(\{#[\w.-]+\})?\s*$/;
const NOTES_FENCE = /^```[ \t]*notes[ \t]*$/;
const TABLE_SEP = /^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

function rawCells(row: string): string[] {
  return row.trim().replace(/^\|/, "").replace(/\|$/, "").split("|");
}

/** A row's cells, as many as the header has (GFM: extra cells are dropped, missing ones empty). */
function cells(row: string, width?: number): Inline[][] {
  const raw = rawCells(row);
  const n = width ?? raw.length;
  return Array.from({ length: n }, (_, i) => parseInline((raw[i] ?? "").trim()));
}

/** A table starts at `line` when the next line is a delimiter row with as many cells (GFM). */
function startsTable(line: string, next?: string): boolean {
  return (
    line.trim().startsWith("|") &&
    next !== undefined &&
    TABLE_SEP.test(next) &&
    rawCells(line).length === rawCells(next).length
  );
}

function startsBlock(line: string, next?: string): boolean {
  return (
    line.startsWith("```") ||
    HEADING.test(line) ||
    UL_START.test(line) ||
    OL_START.test(line) ||
    line.startsWith(">") ||
    startsTable(line, next)
  );
}

export function parseBlocks(md: string): Block[] {
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    if (line.startsWith("```")) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) body.push(lines[i++]);
      i++;
      // Presenter notes (O1f) belong to Present mode, not to the document.
      if (!NOTES_FENCE.test(line)) blocks.push({ t: "pre", v: body.join("\n") });
      continue;
    }
    const h = HEADING.exec(line);
    if (h) {
      blocks.push({ t: "h", level: h[1].length, c: parseInline(h[2]) });
      i++;
      continue;
    }
    if (startsTable(line, lines[i + 1])) {
      const head = cells(line);
      const rows: Inline[][][] = [];
      i += 2;
      while (i < lines.length && lines[i].trim().startsWith("|")) rows.push(cells(lines[i++], head.length));
      blocks.push({ t: "table", head, rows });
      continue;
    }
    // Four or more spaces of indentation: not a list (an indented code block in CommonMark,
    // shown here as paragraph text).
    const list = /^ {4}/.test(line) ? null : UL.test(line) ? "ul" : OL.test(line) ? "ol" : null;
    if (list) {
      const re = list === "ul" ? UL : OL;
      const items: string[] = [];
      while (i < lines.length && lines[i].trim()) {
        const m = re.exec(lines[i]);
        if (m) items.push(m[1]);
        else if (/^\s+/.test(lines[i]) && items.length) items[items.length - 1] += " " + lines[i].trim();
        else break;
        i++;
      }
      blocks.push({ t: list, items: items.map(parseInline) });
      continue;
    }
    if (line.startsWith(">")) {
      const body: string[] = [];
      while (i < lines.length && lines[i].startsWith(">")) body.push(lines[i++].replace(/^>\s?/, ""));
      blocks.push({ t: "quote", c: parseInline(body.join(" ")) });
      continue;
    }
    const para: string[] = [line.trim()];
    i++;
    while (i < lines.length && lines[i].trim() && !startsBlock(lines[i], lines[i + 1])) {
      para.push(lines[i++].trim());
    }
    blocks.push({ t: "p", c: parseInline(para.join(" ")) });
  }
  return blocks;
}

function inlineText(nodes: Inline[]): string {
  return nodes
    .map((n) => (n.t === "text" || n.t === "code" ? n.v : n.t === "cite" || n.t === "img" ? "" : inlineText(n.c)))
    .join("");
}

/** The anchorable text of a body: exactly the characters the renderer emits, in order. */
export function blocksText(blocks: Block[]): string {
  return blocks
    .map((b) => {
      switch (b.t) {
        case "p":
        case "h":
        case "quote":
          return inlineText(b.c);
        case "ul":
        case "ol":
          return b.items.map(inlineText).join("");
        case "pre":
          return b.v;
        case "table":
          return [b.head, ...b.rows].flat().map(inlineText).join("");
      }
    })
    .join("");
}

/** Readable plain text (blocks separated by blank lines), e.g. for diffs and exports. */
export function plainText(md: string): string {
  // Drop citation markers together with the space before them ("appears [c:c1]." → "appears.").
  return parseBlocks(md.replace(/[ \t]*\[c:[\w.:-]+\]/g, ""))
    .map((b) => {
      switch (b.t) {
        case "p":
        case "h":
        case "quote":
          return inlineText(b.c);
        case "ul":
        case "ol":
          return b.items.map((it) => "• " + inlineText(it)).join("\n");
        case "pre":
          return b.v;
        case "table":
          return [b.head, ...b.rows].map((r) => r.map(inlineText).join(" | ")).join("\n");
      }
    })
    .join("\n\n");
}
