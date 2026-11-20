import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { expect, test } from 'vitest';

/*
 * #1580: every page is a client view, ready for the move off Next (#1581).
 * protects=a server page (awaited params, a redirect, `metadata`) the router cannot serve;
 * fails_when=a page.tsx under app/ does not start with "use client";
 * no_claim=layouts and not-found files (the root layout stays a server file).
 */

const APP = __dirname;

function pages(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return pages(full);
    return name === 'page.tsx' ? [full] : [];
  });
}

test('every page under app/ is a client view', () => {
  const all = pages(APP);
  expect(all.length).toBeGreaterThan(80);
  const server = all
    .filter((f) => !/^\s*['"]use client['"];?/.test(readFileSync(f, 'utf8')))
    .map((f) => relative(APP, f));
  expect(server, 'pages without "use client"').toEqual([]);
});
