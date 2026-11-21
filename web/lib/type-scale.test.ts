import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

import { ESLint } from 'eslint';
import { expect, test } from 'vitest';

/*
 * #1589: one type scale. Text sizes are the steps in app/globals.css (@theme), never an
 * arbitrary pixel size.
 * protects=the type scale: no page sets its own text size;
 * fails_when=a source or style file has an arbitrary pixel text size, the lint rule that bans it
 * is off or not an error for some files, or a suppression or disable comment names it;
 * no_claim=fluid sizes (text-[clamp(...)]) and the Simple size tokens (text-[length:var(--simple-*)]).
 */

const WEB = join(__dirname, '..');
const RULE = 'typography/no-arbitrary-text-size';
// Built from parts, so this file does not match itself.
const ARBITRARY = new RegExp(['text-', '\\[\\d+(?:\\.\\d+)?px\\]'].join(''));

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const full = join(dir, d.name);
    if (d.isDirectory()) return d.name === 'node_modules' ? [] : sources(full);
    return /\.(tsx?|css|mjs)$/.test(d.name) ? [full] : [];
  });
}

const files = ['app', 'components', 'lib', 'e2e'].flatMap((d) => sources(join(WEB, d)));

test('no source or style file sets an arbitrary pixel text size', () => {
  const hits = files
    .filter((f) => ARBITRARY.test(readFileSync(f, 'utf8')))
    .map((f) => relative(WEB, f));
  expect(hits).toEqual([]);
});

test('nothing suppresses the arbitrary text size rule', () => {
  const suppressions = JSON.parse(readFileSync(join(WEB, 'eslint-suppressions.json'), 'utf8'));
  const suppressed = Object.entries(suppressions as Record<string, object>)
    .filter(([, rules]) => RULE in rules)
    .map(([file]) => file);
  expect(suppressed).toEqual([]);
  const disabled = [...files, join(WEB, 'eslint.config.mjs')]
    .filter((f) => /eslint-disable[^\n]*typography\//.test(readFileSync(f, 'utf8')))
    .map((f) => relative(WEB, f));
  expect(disabled).toEqual([]);
});

test.each(['components/x.tsx', 'app/x/page.tsx', 'lib/api/mock/x.ts', 'e2e/x.spec.ts'])(
  'lint fails an arbitrary text size in %s',
  async (filePath) => {
    const eslint = new ESLint({ cwd: WEB });
    const size = ['text-', '[13px]'].join('');
    const code = `export const a = '${size}';\nexport const b = \`p-2 ${size}\`;\n`;
    const [result] = await eslint.lintText(code, { filePath });
    const errors = result.messages.filter((m) => m.ruleId === RULE && m.severity === 2);
    expect(errors.map((m) => m.line)).toEqual([1, 2]);
  },
  30_000,
);
