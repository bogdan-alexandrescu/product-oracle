import fs from 'node:fs';
import path from 'node:path';

import * as ts from 'typescript';
import { expect, test } from 'vitest';

/**
 * #1724: the prose guard (e2e/prose-guard.spec.ts) counts each page's first render only, so
 * how-to text in an inspector, a dialog or an empty state that shows once something is opened
 * goes unseen there. This holds it at the source: a JSX text of MIN_WORDS or more words in
 * app/ or components/ is prose, unless it sits inside a tip (InfoTip) or an element marked
 * must-stay (data-owner-copy: copy the owner picked word for word; data-user-content).
 * Each file may keep at most the prose it had when this landed (jsx-prose-baseline.json); a file
 * not listed has none. JSX_PROSE_WRITE=1 lowers the baseline to today's counts, never raising one.
 * fails_when = a file's JSX prose outside a tip or a must-stay marker is above its baseline.
 */

const WEB = path.resolve(__dirname, '..');
const BASELINE = path.join(__dirname, 'jsx-prose-baseline.json');
export const MIN_WORDS = 9;
const TIPS = new Set(['InfoTip']);
const MUST_STAY = new Set(['data-owner-copy', 'data-user-content']);

function* sources(dir: string): Generator<string> {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* sources(p);
    else if (e.name.endsWith('.tsx') && !e.name.endsWith('.test.tsx')) yield p;
  }
}

const words = (text: string) => text.split(/\s+/).filter((w) => /\p{L}/u.test(w)).length;

function exempt(opening: ts.JsxOpeningLikeElement): boolean {
  if (TIPS.has(opening.tagName.getText())) return true;
  return opening.attributes.properties.some(
    (a) => ts.isJsxAttribute(a) && MUST_STAY.has(a.name.getText()),
  );
}

/** The JSX texts of MIN_WORDS or more words outside a tip or a must-stay marker, as "line: text". */
export function jsxProse(file: string, code: string): string[] {
  const source = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found: string[] = [];
  const visit = (node: ts.Node, outerHeld: boolean) => {
    const held = outerHeld || (ts.isJsxElement(node) && exempt(node.openingElement));
    if (ts.isJsxText(node) && !held) {
      const text = node.text.replace(/\s+/g, ' ').trim();
      if (words(text) >= MIN_WORDS) {
        const { line } = source.getLineAndCharacterOfPosition(node.getStart());
        found.push(`${line + 1}: ${text}`);
      }
    }
    node.forEachChild((child) => visit(child, held));
  };
  visit(source, false);
  return found;
}

function today(): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const dir of ['app', 'components'])
    for (const file of sources(path.join(WEB, dir))) {
      const found = jsxProse(file, fs.readFileSync(file, 'utf8'));
      if (found.length) out[path.relative(WEB, file)] = found;
    }
  return out;
}

test('no file has more JSX prose outside a tip or a must-stay marker than its baseline', () => {
  const baseline = JSON.parse(fs.readFileSync(BASELINE, 'utf8')) as Record<string, number>;
  const now = today();
  if (process.env.JSX_PROSE_WRITE === '1') {
    const lowered = Object.fromEntries(
      Object.keys(baseline)
        .sort()
        .filter((f) => now[f]?.length)
        .map((f) => [f, Math.min(baseline[f], now[f].length)]),
    );
    fs.writeFileSync(BASELINE, `${JSON.stringify(lowered, null, 2)}\n`);
  }
  const over = Object.entries(now)
    .filter(([file, found]) => found.length > (baseline[file] ?? 0))
    .map(
      ([file, found]) =>
        `${file}: ${found.length}, baseline ${baseline[file] ?? 0}. Put the explanation behind an InfoTip:\n  ${found.join('\n  ')}`,
    );
  expect(over, 'JSX prose above its baseline').toEqual([]);
});

test('the rule finds prose and spares tips, must-stay copy and short labels', () => {
  const long = 'Everyone who can comment is asked to comment on the latest version.';
  expect(jsxProse('a.tsx', `export const A = () => <p>${long}</p>;`)).toEqual([`1: ${long}`]);
  expect(jsxProse('a.tsx', `export const A = () => <p>Who is asked</p>;`)).toEqual([]);
  expect(
    jsxProse(
      'a.tsx',
      `export const A = () => <p>Who<InfoTip label="x"><b>${long}</b></InfoTip></p>;`,
    ),
  ).toEqual([]);
  expect(jsxProse('a.tsx', `export const A = () => <p data-owner-copy>${long}</p>;`)).toEqual([]);
  expect(
    jsxProse('a.tsx', `export const A = () => <div data-user-content><p>${long}</p></div>;`),
  ).toEqual([]);
});
