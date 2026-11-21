import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test } from 'vitest';

import { REDIRECTS, resolveRedirect } from './redirects';

/*
 * #1580: the one redirect table (lib/redirects.ts) and the helper that applies it.
 * protects=an old link that lands on a missing page, or a table entry nginx never answers;
 * fails_when=an entry's `to` (or `bare`) names no page under app/, an entry does not resolve,
 * or nginx/default.conf.template has no location for an entry;
 * no_claim=the redirect over HTTP (the specs that open an old address drive that).
 */

const APP = join(__dirname, '..', 'app');

/** Whether a path (no query) is served by a page under app/, taking any $param folder. */
function hasPage(path: string, dir = APP): boolean {
  const [head, ...rest] = path.split('/').filter(Boolean);
  if (head === undefined) return existsSync(join(dir, 'page.tsx'));
  const names = readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory());
  const groups = names.filter((d) => /^\(.*\)$/.test(d.name));
  const exact = names.filter((d) => d.name === head);
  const params = names.filter((d) => /^\$\w/.test(d.name));
  return [...exact, ...params, ...groups].some((d) =>
    hasPage(/^\(.*\)$/.test(d.name) ? path : `/${rest.join('/')}`, join(dir, d.name)),
  );
}

/** The entry's `from` with each `:name` filled in with an example. */
const example = (from: string) => from.replace(/:\w+\*/g, 'a/b').replace(/:\w+/g, 'example-1');

test.each(REDIRECTS.map((r) => [r.from, r] as const))('%s resolves to a page', (from, r) => {
  const withQuery = resolveRedirect(example(from), '?x=1');
  expect(withQuery?.permanent).toBe(r.permanent);
  const target = withQuery!.to.split('?')[0];
  // A rest-of-path entry: its bare form must land on a page (its sub-paths are the target's own).
  const bareFrom = from.replace(/\/:\w+\*$/, '');
  const bare = resolveRedirect(bareFrom, '');
  expect(bare, bareFrom).not.toBeNull();
  for (const to of [from.includes('*') ? bare!.to : target, bare!.to])
    expect(hasPage(to.split('?')[0]), `${from} -> ${to}`).toBe(true);
});

test('the helper carries segments and the query, and sends a bare request to `bare`', () => {
  expect(resolveRedirect('/roadmap', '')).toEqual({ to: '/plan', permanent: true });
  expect(resolveRedirect('/baseline', '?tab=proposals')).toEqual({
    to: '/ground-truth?tab=proposals',
    permanent: true,
  });
  expect(resolveRedirect('/baseline/a/b', '')?.to).toBe('/ground-truth/a/b');
  expect(resolveRedirect('/simple/prds/guided-setup', '')?.to).toBe(
    '/simple/one-pagers/guided-setup',
  );
  expect(resolveRedirect('/requests/new', '?request=r-1')).toEqual({
    to: '/requests/to-decide?request=r-1',
    permanent: false,
  });
  expect(resolveRedirect('/requests/new', '')?.to).toBe('/requests?compose=request');
  expect(resolveRedirect('/requests', '')).toBeNull();
  expect(resolveRedirect('/baselines', '')).toBeNull();
});

test('nginx answers each entry, as the router does', () => {
  const conf = readFileSync(join(__dirname, '..', 'nginx', 'default.conf.template'), 'utf8');
  // One location per entry, by its literal path (the dynamic part is nginx's own pattern).
  for (const r of REDIRECTS) {
    const head = r.from.replace(/\/:\w+\*?$/, '');
    expect(conf, r.from).toContain(head);
    const at = new RegExp(
      `location [=~^ ]*\\^?${head.replace(/\//g, '\\/')}[^{]*\\{[^}]*return ${r.permanent ? 308 : 307} `,
    );
    expect(conf, r.from).toMatch(at);
  }
});
