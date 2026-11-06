// Kept apart, with no imports, so api/tests/test_export_visual_e.py can run it through node and
// check it gives what export/deck.py code_left_out gives for the same input.
const LIST_ITEM = /^( {0,3}(?:[-*+]|\d{1,9}[.)]))( +|\t|$)/;
const BREAK = /^ {0,3}(?:(?:\* *){3,}|(?:- *){3,}|(?:_ *){3,})$/;
const SETEXT = /^ {0,3}(?:=+|-+) *$/;
const HEADING = /^ {0,3}#{1,6}(?:\s|$)/;
// A list marker alone on its line: code indented past it is that item's, on the marker's line.
const BARE_ITEM = /^[ \t>]*(?:[-*+]|\d{1,9}[.)])[ \t]*$/;
/**
 * A deck shows no code (owner, Nov 5): each code block, fenced or indented, found as CommonMark finds it (export/deck.py
 * code_left_out reads markdown-it's fence and code_block tokens), is one line in a paragraph of its own, "Code: 40 lines,
 * in the full PRD", a link to that place in the full PRD; an empty block is dropped. A block that opens on a list item's
 * line stays that item ("- Code: 1 line, ..."); a fence in a list item or a quote ends where the item or quote ends.
 */
export function codeLeftOut(body: string, href: string): string {
  const raw = body.replace(/\r\n?/g, "\n").split("\n");
  // Each line with the tabs in its quote and list markers and its indent widened to the next multiple of four columns,
  // as CommonMark counts them; a line kept is kept as written.
  const lines = raw.map((l) =>
    l.replace(/^[ \t>*+\-.)\d]*/, (w) => {
      let s = "";
      for (const c of w) s += c === "\t" ? " ".repeat(4 - (s.length % 4)) : c;
      return s;
    }),
  );
  // A final line break ends the last line; it opens no line of its own, nor do spaces after it.
  const stop = lines.length > 1 && !lines[lines.length - 1].trim() ? lines.length - 1 : lines.length;
  const quoteOf = (l: string) => /^(?: {0,3}> ?)*/.exec(l)![0];
  const depth = (l: string) => quoteOf(l).split(">").length - 1;
  const blank = (l: string) => !l.replace(/[ \t>]/g, "");
  const indentOf = (l: string) => /^ */.exec(l.replace(/^\t+/, (t) => "    ".repeat(t.length)))![0].length;
  const out: string[] = [];
  const columns = (l: string) => {
    let n = 0;
    for (const c of l) n = c === "\t" ? n + 4 - (n % 4) : n + 1;
    return n;
  };
  const leaveOut = (n: number, prefix: string, end: number) => {
    // The line setting it apart continues the container: quote markers only, a list marker as spaces.
    const gap = prefix.replace(/[^>]/g, " ").trimEnd();
    const after = end < lines.length && !blank(lines[end]);
    if (n) {
      const text = `[Code: ${n} ${n === 1 ? "line" : "lines"}, in the full PRD](${href})`;
      const last = out.length ? out[out.length - 1] : "";
      if (BARE_ITEM.test(last) && columns(prefix) > columns(last.trimEnd())) out[out.length - 1] = `${last.trimEnd()} ${text}`;
      else {
        if (out.length && !blank(last)) out.push(gap);
        out.push(prefix + text);
      }
      if (after) out.push(gap);
    } else if (out.length && !blank(out[out.length - 1]) && after) out.push(gap);
  };
  // The open list items' content columns and quote depths, innermost last: an item's code is indented four more than
  // its column. A paragraph line cannot start an indented block.
  const items: { col: number; depth: number; empty?: boolean }[] = [];
  let para = false;
  let paraDepth = 0;
  for (let i = 0; i < lines.length; ) {
    const line = lines[i];
    const written = raw[i];
    const quote = quoteOf(line);
    const rest = line.slice(quote.length).replace(/^[ \t]+/, (w) => w.replace(/\t/g, "    "));
    if (blank(line)) {
      // A blank line in another quote (or out of one) ends the items opened in that quote.
      while (items.length && depth(line) !== items[items.length - 1].depth) items.pop();
      // An item with nothing on its marker's line ends at a blank line.
      while (items.length && items[items.length - 1].empty) items.pop();
      out.push(written);
      para = false;
      i++;
      continue;
    }
    const indent = indentOf(rest);
    // A line left of an item's column, or in another quote, ends the item unless it carries on a paragraph (a break,
    // heading, fence or new quote never does).
    // A new item of an open list is not either.
    const within = items.filter((it) => it.col <= indent && it.depth === depth(line)).pop()?.col ?? 0;
    const lazy =
      para &&
      !quote &&
      !BREAK.test(rest) &&
      !HEADING.test(rest) &&
      !/^ {0,3}(`{3,}|~{3,})/.test(rest) &&
      !(items.length && LIST_ITEM.test(rest.slice(within)));
    const d = depth(line);
    // An empty item, or a list counting from other than 1, cannot break into a paragraph in its own container.
    const inPara = para && d === paraDepth && (!items.length || indent >= items[items.length - 1].col);
    const carried = lazy && items.length > 0 && indent < items[items.length - 1].col;
    // A line carrying on a paragraph from outside its item or quote opens nothing.
    const adrift = lazy && items.length > 0 && (indent < items[items.length - 1].col || d !== items[items.length - 1].depth);
    while (items.length && !lazy && (indent < items[items.length - 1].col || d !== items[items.length - 1].depth)) items.pop();
    if (items.length) items[items.length - 1].empty = false;
    const base = items.length ? items[items.length - 1].col : 0;
    // The line's own content, past its container: each list item opening here ("- 1. text" opens two) moves the column
    // to its content.
    let col = Math.min(indent, base);
    let text = rest.slice(col);
    let item = !adrift && indent < base + 4 && !BREAK.test(text) ? LIST_ITEM.exec(text) : null;
    const number = item && /\d+/.exec(item[1]);
    if (item && inPara && (!text.slice(item[0].length).trim() || (number && Number(number[0]) !== 1))) item = null;
    const opened = !!item;
    while (item) {
      const w = item[2] && item[2] !== "\t" && item[2].length < 5 ? item[2].length : 1;
      col += item[1].length + w;
      text = rest.slice(col);
      items.push({ col, depth: d, empty: !text.trim() });
      para = false;
      item = !BREAK.test(text) ? LIST_ITEM.exec(text) : null;
    }
    const own = indentOf(text) - (opened ? 0 : base - Math.min(indent, base));
    const fence = adrift ? null : /^ *(`{3,}|~{3,})(.*)$/.exec(text);
    if (fence && own <= 3 && !(fence[1][0] === "`" && fence[2].includes("`"))) {
      const close = new RegExp(`^ {0,3}${fence[1][0]}{${fence[1].length},} *$`);
      const inner = opened ? col : base;
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
      leaveOut(j - i - 1, written.slice(0, written.indexOf(fence[1])), closed ? j + 1 : j);
      para = false;
      i = closed ? j + 1 : j;
      continue;
    }
    if (!adrift && own >= 4 && (!para || d > paraDepth)) {
      const inner = opened ? col : base;
      let last = i;
      for (let j = i + 1; j < lines.length && quoteOf(lines[j]) === quote; j++) {
        if (blank(lines[j])) continue;
        if (indentOf(lines[j].slice(quote.length)) < inner + 4) break;
        last = j;
      }
      // As export/deck.py takes it: the line before markdown-it's code, less four columns of indent.
      const code = line.slice(quote.length + inner + 4);
      const before = written.endsWith(code) ? written.slice(0, written.length - code.length) : "";
      leaveOut(last - i + 1, before.endsWith("    ") ? before.slice(0, -4) : before.replace(/\t$/, ""), last + 1);
      para = false;
      i = last + 1;
      continue;
    }
    // After a thematic break, a setext underline or a heading, an indented line is code again.
    // A line in fewer quotes than its paragraph carries it on: there "===" is text, not an underline.
    if (!text.trim() || BREAK.test(text) || HEADING.test(text) || (para && d === paraDepth && !carried && SETEXT.test(text))) para = false;
    else if (!para || d > paraDepth) [para, paraDepth] = [true, d];
    out.push(written);
    i++;
  }
  return out.join("\n");
}
