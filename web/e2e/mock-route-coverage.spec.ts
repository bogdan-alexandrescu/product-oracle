import fs from 'node:fs';
import path from 'node:path';

import { expect, test } from './test';

/**
 * #1587: the mock API (web/lib/api/mock) answers every route a page reads. A page's read is
 * each `.GET("/route")` in web/app, web/components and web/lib (the mock aside); a mock
 * answers it when one of its replies names the route, `reply(path, "get", body)` (typed
 * against schema.d.ts, so its body cannot drift from the API's) or `rawReply` for a body that
 * is not JSON (lib/api/mock/typed.ts).
 * fails_when = a page reads a route the mock has no typed reply for, or a page reads a route that
 * is not in openapi.json.
 */

const WEB = path.resolve(__dirname, '..');
const MOCK_SOURCES = ['lib/api/mock', 'app/oauth/consent/mock.ts'];

function sources(rel: string): string[] {
  const full = path.join(WEB, rel);
  if (fs.statSync(full).isFile()) return [full];
  return fs.readdirSync(full, { withFileTypes: true }).flatMap((e) => {
    if (e.name === 'node_modules' || e.name.startsWith('.')) return [];
    const child = path.join(rel, e.name);
    if (e.isDirectory()) return sources(child);
    return /\.tsx?$/.test(e.name) && !e.name.endsWith('.d.ts') ? [path.join(WEB, child)] : [];
  });
}

const isMock = (file: string) => MOCK_SOURCES.some((m) => file.startsWith(path.join(WEB, m)));

function pageReads(): Set<string> {
  const reads = new Set<string>();
  for (const file of ['app', 'components', 'lib'].flatMap(sources).filter((f) => !isMock(f))) {
    for (const m of fs.readFileSync(file, 'utf8').matchAll(/\.GET\(\s*(["'])([^"']+)\1/g))
      reads.add(m[2]);
  }
  return reads;
}

function mockedReads(): Set<string> {
  const mocked = new Set<string>();
  for (const file of MOCK_SOURCES.flatMap(sources)) {
    const text = fs.readFileSync(file, 'utf8');
    for (const m of text.matchAll(
      /\b(?:\w*[rR]eply|bodyOf)\(\s*(["'])(\/[^"']*)\1,\s*([^,()]*?)(["'])get\4/g,
    ))
      mocked.add(m[2]);
  }
  return mocked;
}

test("every route a page reads is in the API's schema", () => {
  const api = new Set(
    Object.keys(JSON.parse(fs.readFileSync(path.join(WEB, 'lib/api/openapi.json'), 'utf8')).paths),
  );
  const reads = [...pageReads()];
  expect(reads.length).toBeGreaterThan(100);
  expect(reads.filter((r) => !api.has(r))).toEqual([]);
});

test('every route a page reads has a typed mock reply', () => {
  const mocked = mockedReads();
  const missing = [...pageReads()].filter((r) => !mocked.has(r)).sort();
  expect(missing).toEqual([]);
});
