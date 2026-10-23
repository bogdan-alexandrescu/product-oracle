/**
 * Named codes in agent-written text (#305). PRD sections, proposals and checkpoint notes
 * use codes such as `F-28`, `F-30a`, `R1–R10`, `M2` and `G-B` with nothing beside them. The
 * reader recognises the codes it knows when the text is shown; nothing stored changes.
 *
 * Known codes come from the document's own headings (`F-28 Some feature name`) and lines
 * that start with a code (`R1 (F-28) Title.`, `D2 — Decision`, `Q1: Open question`), and
 * from the company's goals. A slice (`F-30a`) with no line of its own takes its parent's
 * name; a range (`R1–R10`) is one reference to its known members. Code blocks, code spans
 * and URLs are never read.
 *
 * The index is built once per version (`buildCodeIndex`), then each text node is split
 * with `splitCodes`. No React here: the module is unit-tested on its own.
 */

/** A code: `F-28`, `G-B`, `OKR-2`, `R1`, `M2`; a slice adds a lower-case letter (`F-30a`). */
const CODE = String.raw`[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+[a-z]?|[A-Z]{1,4}\d+[a-z]?`;
/** A line that names a code: `F-28 Name`, `**R1** (F-28) Title.`, `D2 — Use one card`. */
const DEFINES = new RegExp(String.raw`^(?:[-*+]\s+|\d+[.)]\s+|#{1,6}\s+)?(\*\*)?(${CODE})\1?(?:\s*\(([^)]{1,40})\))?(?:\*\*)?\s*(?:[:.·–—-]\s*|\s+)(\S.*)$`);
/** A code (or a range of two) in running text, not inside a word, a path or a key. */
const TOKEN = new RegExp(String.raw`(?<![\w./:#@=&?-])(${CODE})(?:\s?[–—]\s?(${CODE}))?(?![\w-]|\.\w)`, "g");
const URL_RE = /\b(?:https?:\/\/|www\.)\S+/g;
/** A code followed by a mark: `Q1: …`, `D2 — …`, `F-28. …`. */
const MARKED = new RegExp(String.raw`^(?:${CODE})\s*[:.·–—-]\s`);
const WHOLE = new RegExp(String.raw`^(?:${CODE})$`);
const SPLIT_NUM = /^([A-Z][A-Z0-9]*?-?)(\d+)$/;

export type CodeKind = "Feature" | "Milestone" | "Requirement" | "Decision" | "Open question" | "Goal" | "Risk" | "Section";

export type CodeEntry = {
  code: string;
  kind: CodeKind;
  name: string;
  /** Where the document names it: the section "Go to section" opens. */
  sectionKey?: string;
  /** The goal or feature the card's "Open" goes to. */
  entityId?: string;
  /** One line under the name: the parent of a requirement, "slice a", the goal's state. */
  line?: string;
  /** A range's known members, in order. */
  members?: CodeEntry[];
  /** "this PRD" for a document's own codes. */
  from?: string;
};

export type CodeIndex = Map<string, CodeEntry>;

export type CodeSection = { section_key: string; heading: string; body_md: string };
/** A company goal or feature with its own code (`G-B Growth`, a feature keyed `F-2`). */
export type CodeEntity = { id: string; kind: "Goal" | "Feature"; code: string; name: string; status?: string | null };

const KINDS: [RegExp, CodeKind][] = [
  [/^F/, "Feature"],
  [/^M/, "Milestone"],
  [/^R(?!ISK)/, "Requirement"],
  [/^(?:D|ADR)/, "Decision"],
  [/^(?:Q|OQ)/, "Open question"],
  [/^RISK/, "Risk"],
  [/^G/, "Goal"],
];

function kindOf(code: string): CodeKind {
  return KINDS.find(([re]) => re.test(code))?.[1] ?? "Section";
}

/** The name a line gives: its first sentence, without trailing markup. */
function cleanName(text: string): string {
  const t = text
    .replace(/\[c:[\w.:-]+\]/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[*_`]/g, "")
    .trim();
  const first = t.match(/^(.+?[.!?])(?:\s|$)/);
  return (first ? first[1].replace(/[.]$/, "") : t).trim().slice(0, 160);
}

/** The body's lines outside fenced code blocks. */
function proseLines(md: string): string[] {
  const out: string[] = [];
  let fenced = false;
  for (const line of md.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (!fenced) out.push(line.trim());
  }
  return out;
}

/**
 * The codes a document names, then the company's goals (a document's own code wins). Built
 * once per version.
 */
export function buildCodeIndex(sections: readonly CodeSection[], entities: readonly CodeEntity[] = []): CodeIndex {
  const index: CodeIndex = new Map();
  const add = (e: CodeEntry) => {
    if (!index.has(e.code)) index.set(e.code, e);
  };
  const parents: [CodeEntry, string][] = [];
  const define = (s: CodeSection, code: string, rest: string, parent?: string) => {
    const under = parent && WHOLE.test(parent.trim()) ? parent.trim() : null;
    // `G2 (retention): more repeat orders`: the words in brackets are the name.
    const named = parent && !under ? cleanName(parent) : "";
    const name = named || cleanName(rest);
    if (!name || index.has(code)) return;
    const e: CodeEntry = { code, kind: kindOf(code), name, sectionKey: s.section_key, from: "this PRD" };
    if (named) e.line = cleanName(rest);
    if (under) parents.push([e, under]);
    add(e);
  };
  // Headings first: a heading names its code wherever a line mentions it earlier.
  for (const s of sections) {
    const m = s.heading.trim().match(DEFINES);
    if (m) define(s, m[2], m[4], m[3]);
  }
  for (const s of sections) {
    for (const line of proseLines(s.body_md)) {
      const cells = line.startsWith("|") ? line.split("|").map((c) => c.trim()) : null;
      if (cells) {
        // A table row: `| F-28 | Name | ... |`.
        const code = cells[1]?.replace(/\*\*/g, "");
        if (code && WHOLE.test(code) && cells[2]) define(s, code, cells[2]);
        continue;
      }
      const m = line.match(DEFINES);
      // A line names its code when it is listed, bold, under a parent or followed by a mark
      // ("R1 (F-28) Title.", "- D2 — Use one card", "Q1: Who signs off?"), not in prose.
      if (m && (/^(?:[-*+]|\d+[.)]|#)/.test(line) || m[1] || m[3] || MARKED.test(line))) {
        define(s, m[2], m[4], m[3]);
      }
    }
  }
  for (const [e, p] of parents) {
    const parent = index.get(p);
    e.line = parent ? `${parent.kind} ${parent.code} ${parent.name}` : `Under ${p}`;
  }
  for (const g of entities) {
    if (g.code) add({ code: g.code, kind: g.kind, name: g.name, entityId: g.id, from: g.status ?? undefined });
  }
  return index;
}

/** A slice's entry (`F-30a`): its parent's name, "slice a". */
function slice(code: string, index: CodeIndex): CodeEntry | undefined {
  const m = code.match(/^(.*\d)([a-z])$/);
  const parent = m ? index.get(m[1]) : undefined;
  if (!m || !parent) return undefined;
  return { ...parent, code, line: `${parent.kind} ${parent.code}, slice ${m[2]}`, members: undefined };
}

/** A range's entry (`R1–R10`, `R1-R10`): its known members, in order. */
function range(a: string, b: string, written: string, index: CodeIndex): CodeEntry | undefined {
  const x = a.match(SPLIT_NUM);
  const y = b.match(SPLIT_NUM);
  if (!x || !y || x[1] !== y[1]) return undefined;
  const lo = Number(x[2]);
  const hi = Number(y[2]);
  if (!(hi > lo) || hi - lo > 200) return undefined;
  const members: CodeEntry[] = [];
  for (let n = lo; n <= hi; n++) {
    const e = index.get(`${x[1]}${n}`);
    if (e) members.push(e);
  }
  if (!members.length) return undefined;
  const kind = members[0].kind;
  return {
    code: written,
    kind,
    name: `${members.length} ${kind === "Open question" ? "open questions" : `${kind.toLowerCase()}s`}`,
    sectionKey: members[0].sectionKey,
    from: members[0].from,
    members,
  };
}

/** The entry a code written in text reads as, or undefined when it is not known. */
export function lookupCode(written: string, index: CodeIndex): CodeEntry | undefined {
  const hit = index.get(written) ?? slice(written, index);
  if (hit) return hit;
  // `R1-R10` reads as one hyphenated code; it is a range when both ends are.
  const parts = written.match(new RegExp(`^(${CODE})-(${CODE})$`));
  return parts ? range(parts[1], parts[2], written, index) : undefined;
}

export type CodePiece = string | { text: string; entry: CodeEntry };

/** Text cut into plain pieces and known codes; joined, the pieces are the text unchanged. */
export function splitCodes(text: string, index: CodeIndex): CodePiece[] {
  if (!index.size || !text) return [text];
  const urls = [...text.matchAll(URL_RE)].map((m) => [m.index!, m.index! + m[0].length]);
  const out: CodePiece[] = [];
  let at = 0;
  for (const m of text.matchAll(TOKEN)) {
    const start = m.index!;
    const end = start + m[0].length;
    if (urls.some(([a, b]) => start < b && end > a)) continue;
    const entry = m[2] ? range(m[1], m[2], m[0], index) : lookupCode(m[1], index);
    if (!entry) {
      // A range of unknown codes: its first end alone may still be known.
      const first = m[2] ? lookupCode(m[1], index) : undefined;
      if (!first) continue;
      if (start > at) out.push(text.slice(at, start));
      out.push({ text: m[1], entry: first });
      at = start + m[1].length;
      continue;
    }
    if (start > at) out.push(text.slice(at, start));
    out.push({ text: m[0], entry });
    at = end;
  }
  if (!out.length) return [text];
  if (at < text.length) out.push(text.slice(at));
  return out;
}
