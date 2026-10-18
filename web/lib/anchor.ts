import type { Schemas } from "@/lib/api/client";

export type TextQuoteSelector = Schemas["TextQuoteSelector"];

/** How many characters of context are stored on each side of the quote. */
const CONTEXT = 32;

/**
 * Subtrees marked with this attribute (citation chips, Expand controls, detail shown in
 * place inside a brief section) are not part of the anchorable text of the section
 * body that contains them; a section body nested inside one keeps its own text.
 */
export const IGNORE_ATTR = "data-anchor-ignore";

function countedTextNodes(container: Node): Text[] {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => {
      const ignored = n.parentElement?.closest(`[${IGNORE_ATTR}]`);
      return ignored && container.contains(ignored) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
    },
  });
  const out: Text[] = [];
  while (walker.nextNode()) out.push(walker.currentNode as Text);
  return out;
}

/** Character offset of a DOM boundary point within the container's anchorable text. */
function offsetOf(container: Node, nodes: Text[], node: Node, offset: number): number {
  const probe = document.createRange();
  probe.setStart(container, 0);
  probe.setEnd(node, offset);
  let total = 0;
  for (const t of nodes) {
    if (t === node) return total + offset;
    if (probe.comparePoint(t, t.length) === 0) total += t.length;
    else break;
  }
  return total;
}

export function containerText(container: Node): string {
  return countedTextNodes(container)
    .map((t) => t.data)
    .join("");
}

/** Builds a W3C TextQuoteSelector for a range inside `container`, trimming outer whitespace. */
export function selectorFromRange(container: Node, range: Range): TextQuoteSelector | null {
  const nodes = countedTextNodes(container);
  const text = nodes.map((t) => t.data).join("");
  let start = offsetOf(container, nodes, range.startContainer, range.startOffset);
  let end = offsetOf(container, nodes, range.endContainer, range.endOffset);
  while (start < end && /\s/.test(text[start])) start++;
  while (end > start && /\s/.test(text[end - 1])) end--;
  if (end <= start) return null;
  return {
    exact: text.slice(start, end),
    prefix: text.slice(Math.max(0, start - CONTEXT), start),
    suffix: text.slice(end, end + CONTEXT),
  };
}

function commonSuffixLength(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
  return n;
}

function commonPrefixLength(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n;
}

/**
 * Finds the selector's quote in `text`. When the quote occurs more than once, the
 * occurrence whose surrounding text best matches the stored prefix/suffix wins.
 */
export function resolveSelector(text: string, sel: TextQuoteSelector): { start: number; end: number } | null {
  if (!sel.exact) return null;
  let best: { start: number; score: number } | null = null;
  for (let at = text.indexOf(sel.exact); at >= 0; at = text.indexOf(sel.exact, at + 1)) {
    const score =
      commonSuffixLength(text.slice(0, at), sel.prefix) +
      commonPrefixLength(text.slice(at + sel.exact.length), sel.suffix);
    if (!best || score > best.score) best = { start: at, score };
  }
  return best && { start: best.start, end: best.start + sel.exact.length };
}
