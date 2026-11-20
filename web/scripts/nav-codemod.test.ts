// #1579: npm run test:unit (Vitest). The codemod on a fixture, run twice: the first run
// re-points every next/link and next/navigation import, the second changes nothing.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, test } from 'vitest';

const SCRIPT = fileURLToPath(new URL('./nav-codemod.mjs', import.meta.url));
const NAV = readFileSync(fileURLToPath(new URL('../lib/nav.ts', import.meta.url)), 'utf8');

const FIXTURE: Record<string, [before: string, after: string]> = {
  'app/page.tsx': [
    `"use client";\n\nimport Link from "next/link";\nimport { usePathname, useRouter } from "next/navigation";\nimport { useState } from "react";\n`,
    `"use client";\n\nimport { Link, usePathname, useRouter } from "@/lib/nav";\nimport { useState } from "react";\n`,
  ],
  'app/items/[id]/page.tsx': [
    `import { notFound, redirect } from "next/navigation";\n\nexport default function Page() {\n  notFound();\n}\n`,
    `import { notFound, redirect } from "@/lib/nav";\n\nexport default function Page() {\n  notFound();\n}\n`,
  ],
  // Already half moved: the rest merges into the file's own @/lib/nav import.
  'components/menu.tsx': [
    `import NextLink from "next/link";\nimport { useRouter } from "@/lib/nav";\nimport { useSearchParams as useParamsOfUrl } from 'next/navigation';\n`,
    `import { Link as NextLink, useRouter, useSearchParams as useParamsOfUrl } from "@/lib/nav";\n`,
  ],
  'components/link-row.tsx': [
    `import type { LinkProps } from "next/link";\n\nexport type RowProps = LinkProps;\n`,
    `import { type LinkProps } from "@/lib/nav";\n\nexport type RowProps = LinkProps;\n`,
  ],
  'lib/plain.ts': [`export const plain = 1;\n`, `export const plain = 1;\n`],
  // The module itself keeps its next/* imports.
  'lib/nav.ts': [NAV, NAV],
};

let root = '';
afterEach(() => rmSync(root, { recursive: true, force: true }));

function run(...args: string[]): string {
  return execFileSync(process.execPath, [SCRIPT, root, ...args], { encoding: 'utf8' });
}

function snapshot(): Record<string, string> {
  return Object.fromEntries(
    Object.keys(FIXTURE).map((f) => [f, readFileSync(join(root, f), 'utf8')]),
  );
}

test('the codemod re-points next/link and next/navigation to @/lib/nav, and a second run changes nothing', () => {
  root = mkdtempSync(join(tmpdir(), 'nav-codemod-'));
  for (const [file, [before]] of Object.entries(FIXTURE)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), before);
  }

  assert.match(run(), /NAV-CODEMOD: OK 4 file\(s\) changed/);
  const once = snapshot();
  assert.deepEqual(
    once,
    Object.fromEntries(Object.entries(FIXTURE).map(([f, [, after]]) => [f, after])),
  );

  assert.match(run(), /NAV-CODEMOD: OK 0 file\(s\) changed/);
  assert.deepEqual(snapshot(), once);
  assert.match(run('--check'), /NAV-CODEMOD: OK nothing to change/);
});

test('a name lib/nav.ts does not export fails the run and writes nothing', () => {
  root = mkdtempSync(join(tmpdir(), 'nav-codemod-'));
  mkdirSync(join(root, 'lib'));
  writeFileSync(join(root, 'lib/nav.ts'), NAV);
  const before = `import { useServerInsertedHTML } from "next/navigation";\n`;
  writeFileSync(join(root, 'lib/a.ts'), before);
  assert.throws(run, (err: { status: number; stdout: string }) => {
    assert.equal(err.status, 1);
    assert.match(
      err.stdout,
      /NAV-CODEMOD: FAIL lib\/a.ts: lib\/nav.ts does not export useServerInsertedHTML/,
    );
    return true;
  });
  assert.equal(readFileSync(join(root, 'lib/a.ts'), 'utf8'), before);
});
