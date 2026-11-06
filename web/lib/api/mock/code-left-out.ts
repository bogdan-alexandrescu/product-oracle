// Kept apart, with no imports, so api/tests/test_export_visual_e.py can run it through node and
// check it gives what export/deck.py code_left_out gives for the same input.
const LIST_ITEM = /^( {0,3}(?:[-*+]|\d{1,9}[.)]))( {1,4}(?! )|\t|$)/;
/**
 * A deck shows no code (owner, Nov 5): each code block, fenced or indented, found as CommonMark finds it (export/deck.py
 * code_left_out reads markdown-it's fence and code_block tokens), is one line in a paragraph of its own, "Code: 40 lines,
 * in the full PRD", a link to that place in the full PRD; an empty block is dropped.
 */
export function codeLeftOut(body: string, href: string): string {
  const lines = body.replace(/\r\n?/g, "\n").split("\n");
  const quoteOf = (l: string) => /^(?: {0,3}> ?)*/.exec(l)![0];
  const blank = (l: string) => !l.replace(/[ \t>]/g, "");
  const indentOf = (l: string) => /^ */.exec(l.replace(/^\t+/, (t) => "    ".repeat(t.length)))![0].length;
  const out: string[] = [];
  const leaveOut = (n: number, prefix: string, end: number) => {
    const gap = prefix.trimEnd();
    const after = end < lines.length && !blank(lines[end]);
    if (n) {
      if (out.length && !blank(out[out.length - 1])) out.push(gap);
      out.push(`${prefix}[Code: ${n} ${n === 1 ? "line" : "lines"}, in the full PRD](${href})`);
      if (after) out.push(gap);
    } else if (out.length && !blank(out[out.length - 1]) && after) out.push(gap);
  };
  // A list item's content column: its code is indented four more; a paragraph line cannot start an indented block.
  let list = -1;
  let para = false;
  for (let i = 0; i < lines.length; ) {
    const line = lines[i];
    const quote = quoteOf(line);
    const rest = line.slice(quote.length);
    if (blank(line)) {
      out.push(line);
      para = false;
      i++;
      continue;
    }
    const indent = indentOf(rest);
    const base = Math.max(list, 0);
    const fence = /^ *(`{3,}|~{3,})(.*)$/.exec(rest);
    if (fence && indent <= base + 3 && !(fence[1][0] === "`" && fence[2].includes("`"))) {
      const close = new RegExp(`^ *${fence[1][0]}{${fence[1].length},} *$`);
      let j = i + 1;
      while (j < lines.length && !close.test(lines[j].slice(quoteOf(lines[j]).length))) j++;
      leaveOut(j - i - 1, quote + " ".repeat(indent), Math.min(j + 1, lines.length));
      para = false;
      i = j + 1;
      continue;
    }
    if (indent >= base + 4 && !para) {
      let last = i;
      let j = i;
      for (; j < lines.length && quoteOf(lines[j]) === quote; j++) {
        if (blank(lines[j])) continue;
        if (indentOf(lines[j].slice(quote.length)) < base + 4) break;
        last = j;
      }
      leaveOut(last - i + 1, quote + " ".repeat(base), last + 1);
      i = last + 1;
      continue;
    }
    const item = LIST_ITEM.exec(rest);
    if (item) list = item[1].length + (item[2] && item[2] !== "\t" ? item[2].length : 1);
    else if (indent === 0 && (!para || /^#{1,6}\s/.test(rest))) list = -1;
    para = !/^#{1,6}(\s|$)/.test(rest);
    out.push(line);
    i++;
  }
  return out.join("\n");
}
