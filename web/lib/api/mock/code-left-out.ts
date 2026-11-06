// Kept apart, with no imports, so api/tests/test_export_visual_e.py can run it through node and
// check it gives what export/deck.py code_left_out gives for the same input.
const LIST_ITEM = /^( {0,3}(?:[-*+]|\d{1,9}[.)]))( +|\t|$)/;
const BREAK = /^ {0,3}(?:(?:\* *){3,}|(?:- *){3,}|(?:_ *){3,})$/;
const SETEXT = /^ {0,3}(?:=+|-+) *$/;
const HEADING = /^ {0,3}#{1,6}(?:\s|$)/;
/**
 * A deck shows no code (owner, Nov 5): each code block, fenced or indented, found as CommonMark finds it (export/deck.py
 * code_left_out reads markdown-it's fence and code_block tokens), is one line in a paragraph of its own, "Code: 40 lines,
 * in the full PRD", a link to that place in the full PRD; an empty block is dropped. A block that opens on a list item's
 * line stays that item ("- Code: 1 line, ..."); a fence in a list item or a quote ends where the item or quote ends.
 */
export function codeLeftOut(body: string, href: string): string {
  const lines = body.replace(/\r\n?/g, "\n").split("\n");
  // A final line break ends the last line; it opens no line of its own.
  const stop = lines.length > 1 && lines[lines.length - 1] === "" ? lines.length - 1 : lines.length;
  const quoteOf = (l: string) => /^(?: {0,3}> ?)*/.exec(l)![0];
  const depth = (l: string) => quoteOf(l).split(">").length - 1;
  const blank = (l: string) => !l.replace(/[ \t>]/g, "");
  const indentOf = (l: string) => /^ */.exec(l.replace(/^\t+/, (t) => "    ".repeat(t.length)))![0].length;
  const out: string[] = [];
  const leaveOut = (n: number, prefix: string, end: number) => {
    // The line setting it apart continues the container: quote markers only, a list marker as spaces.
    const gap = prefix.replace(/[^>]/g, " ").trimEnd();
    const after = end < lines.length && !blank(lines[end]);
    if (n) {
      if (out.length && !blank(out[out.length - 1])) out.push(gap);
      out.push(`${prefix}[Code: ${n} ${n === 1 ? "line" : "lines"}, in the full PRD](${href})`);
      if (after) out.push(gap);
    } else if (out.length && !blank(out[out.length - 1]) && after) out.push(gap);
  };
  // The open list items' content columns and quote depths, innermost last: an item's code is indented four more than
  // its column. A paragraph line cannot start an indented block.
  const items: { col: number; depth: number }[] = [];
  let para = false;
  let paraDepth = 0;
  for (let i = 0; i < lines.length; ) {
    const line = lines[i];
    const quote = quoteOf(line);
    const rest = line.slice(quote.length).replace(/^[ \t]+/, (w) => w.replace(/\t/g, "    "));
    if (blank(line)) {
      // A blank line in another quote (or out of one) ends the items opened in that quote.
      while (items.length && depth(line) !== items[items.length - 1].depth) items.pop();
      out.push(line);
      para = false;
      i++;
      continue;
    }
    const indent = indentOf(rest);
    // A line left of an item's column, or in another quote, ends the item unless it carries on a paragraph (a break,
    // heading, fence or new quote never does).
    const lazy = para && !quote && !BREAK.test(rest) && !HEADING.test(rest) && !/^ {0,3}(`{3,}|~{3,})/.test(rest);
    const d = depth(line);
    const carried = lazy && items.length > 0 && indent < items[items.length - 1].col;
    while (items.length && !lazy && (indent < items[items.length - 1].col || d !== items[items.length - 1].depth)) items.pop();
    const base = items.length ? items[items.length - 1].col : 0;
    // The line's own content, past its container: a list item opening here moves the column to its content.
    let col = Math.min(indent, base);
    let text = rest.slice(col);
    const item = indent < base + 4 && !BREAK.test(text) ? LIST_ITEM.exec(text) : null;
    if (item) {
      const w = item[2] && item[2] !== "\t" && item[2].length < 5 ? item[2].length : 1;
      col += item[1].length + w;
      text = rest.slice(col);
      items.push({ col, depth: d });
      para = false;
    }
    const lead = quote + rest.slice(0, col);
    const own = indentOf(text) - (item ? 0 : base - Math.min(indent, base));
    const fence = /^ *(`{3,}|~{3,})(.*)$/.exec(text);
    if (fence && own <= 3 && !(fence[1][0] === "`" && fence[2].includes("`"))) {
      const close = new RegExp(`^ {0,3}${fence[1][0]}{${fence[1].length},} *$`);
      const inner = item ? col : base;
      let j = i + 1;
      let closed = false;
      for (; j < stop; j++) {
        // The line past the fence's own quotes; a deeper ">" is code.
        let r = lines[j];
        for (let k = 0; k < d && /^ {0,3}>/.test(r); k++) r = r.replace(/^ {0,3}> ?/, "");
        if (depth(lines[j]) < d || (r.trim() && indentOf(r) < inner)) break;
        if (close.test(r.slice(Math.min(indentOf(r), inner)))) {
          closed = true;
          break;
        }
      }
      // As markdown-it reads it, a quoted fence left open to the last line ends at its last line with text.
      if (!closed && d && j === lines.length) while (j > i + 1 && blank(lines[j - 1])) j--;
      leaveOut(j - i - 1, line.slice(0, line.indexOf(fence[1])), closed ? j + 1 : j);
      para = false;
      i = closed ? j + 1 : j;
      continue;
    }
    if (own >= 4 && !para) {
      const inner = item ? col : base;
      let last = i;
      for (let j = i + 1; j < lines.length && quoteOf(lines[j]) === quote; j++) {
        if (blank(lines[j])) continue;
        if (indentOf(lines[j].slice(quote.length)) < inner + 4) break;
        last = j;
      }
      leaveOut(last - i + 1, item ? lead : quote + " ".repeat(base), last + 1);
      para = false;
      i = last + 1;
      continue;
    }
    // After a thematic break, a setext underline or a heading, an indented line is code again.
    // A line in fewer quotes than its paragraph carries it on: there "===" is text, not an underline.
    if (!text.trim() || BREAK.test(text) || HEADING.test(text) || (para && d === paraDepth && !carried && SETEXT.test(text))) para = false;
    else if (!para || d > paraDepth) [para, paraDepth] = [true, d];
    out.push(line);
    i++;
  }
  return out.join("\n");
}
