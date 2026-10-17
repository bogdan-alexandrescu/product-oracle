import type { Schemas } from "@/lib/api/client";

type WordOp = Schemas["WordOp"];

/** Splits text into words and the whitespace between them, keeping both. */
function tokenize(text: string): string[] {
  return text.split(/(\s+)/).filter((t) => t.length > 0);
}

/** Word-level diff (LCS over word tokens), merged into runs of equal / insert / delete. */
export function wordDiff(from: string, to: string): WordOp[] {
  const a = tokenize(from);
  const b = tokenize(to);
  const n = a.length;
  const m = b.length;
  // lcs[i][j] = LCS length of a[i:] and b[j:]
  const lcs: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const ops: WordOp[] = [];
  const push = (op: WordOp["op"], text: string) => {
    const last = ops[ops.length - 1];
    if (last && last.op === op) last.text += text;
    else ops.push({ op, text });
  };
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      push("equal", a[i]);
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      push("delete", a[i++]);
    } else {
      push("insert", b[j++]);
    }
  }
  while (i < n) push("delete", a[i++]);
  while (j < m) push("insert", b[j++]);
  return ops;
}

/** Indexes (into `seq`) of one longest increasing subsequence. */
function longestIncreasing(seq: number[]): Set<number> {
  const tails: number[] = [];
  const prev: number[] = new Array(seq.length).fill(-1);
  for (let i = 0; i < seq.length; i++) {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (seq[tails[mid]] < seq[i]) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) prev[i] = tails[lo - 1];
    tails[lo] = i;
  }
  const keep = new Set<number>();
  let k = tails.length ? tails[tails.length - 1] : -1;
  while (k >= 0) {
    keep.add(k);
    k = prev[k];
  }
  return keep;
}

interface DiffableSection {
  section_key: string;
  ordinal: number;
  heading: string;
  body_text: string;
  content_hash: string;
}

/**
 * Section-level diff keyed by section id, in the order of the target version, with
 * removed sections placed after the section that preceded them. A section counts as
 * moved when it is outside the longest run of sections that kept their relative order.
 */
export function sectionDiff(from: DiffableSection[], to: DiffableSection[]): Schemas["SectionDiff"][] {
  const fromByKey = new Map(from.map((s) => [s.section_key, s]));
  const toKeys = new Set(to.map((s) => s.section_key));
  const common = to.filter((s) => fromByKey.has(s.section_key));
  const stay = longestIncreasing(common.map((s) => fromByKey.get(s.section_key)!.ordinal));
  const moved = new Set(common.filter((_, i) => !stay.has(i)).map((s) => s.section_key));

  const out: Schemas["SectionDiff"][] = to.map((t) => {
    const f = fromByKey.get(t.section_key);
    if (!f) {
      return {
        section_key: t.section_key,
        status: "added",
        moved: false,
        to_ordinal: t.ordinal,
        to_heading: t.heading,
        words: [{ op: "insert", text: t.body_text }],
      };
    }
    const changed = f.content_hash !== t.content_hash || f.heading !== t.heading;
    return {
      section_key: t.section_key,
      status: changed ? "changed" : "unchanged",
      moved: moved.has(t.section_key),
      from_ordinal: f.ordinal,
      to_ordinal: t.ordinal,
      from_heading: f.heading,
      to_heading: t.heading,
      words: changed ? wordDiff(f.body_text, t.body_text) : null,
    };
  });

  from.forEach((f, idx) => {
    if (toKeys.has(f.section_key)) return;
    const removed: Schemas["SectionDiff"] = {
      section_key: f.section_key,
      status: "removed",
      moved: false,
      from_ordinal: f.ordinal,
      from_heading: f.heading,
      words: [{ op: "delete", text: f.body_text }],
    };
    // Insert after the closest preceding section (from the source order) still in the output.
    let at = 0;
    for (let k = idx - 1; k >= 0; k--) {
      const pos = out.findIndex((d) => d.section_key === from[k].section_key);
      if (pos >= 0) {
        at = pos + 1;
        break;
      }
    }
    out.splice(at, 0, removed);
  });
  return out;
}
