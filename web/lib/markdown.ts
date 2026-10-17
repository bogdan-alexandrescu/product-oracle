/**
 * A deliberately small markdown subset for PRD section bodies: paragraphs, lists,
 * blockquotes, fenced code, tables, minor headings, and inline code / strong /
 * emphasis / links / `[c:<id>]` citations.
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
  | { t: "cite"; key: string };

export type Block =
  | { t: "p"; c: Inline[] }
  | { t: "h"; level: number; c: Inline[] }
  | { t: "ul" | "ol"; items: Inline[][] }
  | { t: "quote"; c: Inline[] }
  | { t: "pre"; v: string }
  | { t: "table"; head: Inline[][]; rows: Inline[][][] };

const INLINE =
  /\[c:([\w.-]+)\]|`([^`]+)`|\*\*(.+?)\*\*|\[([^\]]+)\]\(([^)\s]+)\)|(?<![\w*])\*(?!\s)(.+?)(?<!\s)\*(?![\w*])|(?<!\w)_(?!\s)(.+?)(?<!\s)_(?!\w)/g;

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
    else if (m[2] !== undefined) out.push({ t: "code", v: m[2] });
    else if (m[3] !== undefined) out.push({ t: "strong", c: parseInline(m[3]) });
    else if (m[4] !== undefined) out.push({ t: "link", href: m[5], c: parseInline(m[4]) });
    else if (m[6] !== undefined) out.push({ t: "em", c: parseInline(m[6]) });
    else if (m[7] !== undefined) out.push({ t: "em", c: parseInline(m[7]) });
  }
  pushText(src.slice(last));
  return out;
}

const UL = /^\s*[-*+]\s+(.*)$/;
const OL = /^\s*\d+[.)]\s+(.*)$/;
const HEADING = /^(#{1,6})\s+(.*?)\s*(\{#[\w.-]+\})?\s*$/;
const TABLE_SEP = /^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

function cells(row: string): Inline[][] {
  return row
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => parseInline(c.trim()));
}

function startsBlock(line: string, next?: string): boolean {
  return (
    line.startsWith("```") ||
    HEADING.test(line) ||
    UL.test(line) ||
    OL.test(line) ||
    line.startsWith(">") ||
    (line.trim().startsWith("|") && next !== undefined && TABLE_SEP.test(next))
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
      blocks.push({ t: "pre", v: body.join("\n") });
      continue;
    }
    const h = HEADING.exec(line);
    if (h) {
      blocks.push({ t: "h", level: h[1].length, c: parseInline(h[2]) });
      i++;
      continue;
    }
    if (line.trim().startsWith("|") && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1])) {
      const head = cells(line);
      const rows: Inline[][][] = [];
      i += 2;
      while (i < lines.length && lines[i].trim().startsWith("|")) rows.push(cells(lines[i++]));
      blocks.push({ t: "table", head, rows });
      continue;
    }
    const list = UL.test(line) ? "ul" : OL.test(line) ? "ol" : null;
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
    .map((n) => (n.t === "text" || n.t === "code" ? n.v : n.t === "cite" ? "" : inlineText(n.c)))
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
  return parseBlocks(md.replace(/[ \t]*\[c:[\w.-]+\]/g, ""))
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
