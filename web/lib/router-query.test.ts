import { expect, test } from 'vitest';

import { parseQuery, stringifyQuery } from './router-query';

/*
 * #1581: the router keeps the query as text.
 * protects=links whose query the router rewrote (`?latest` became `?latest=`, numbers parsed as JSON);
 * fails_when=a query does not come back as it went in;
 * no_claim=the encoding of a character URLSearchParams writes another way.
 */
test.each([
  '?latest',
  '?item=usage-alerts:alert-quiet-hours',
  '?from=%2Fdocuments%2Fannual-billing',
  '?request=r-1',
  '?tab=proposals&x=1',
  '?a=1&a=2',
  '?q=two+words',
  '',
])('%s comes back unchanged', (query) => {
  expect(stringifyQuery(parseQuery(query))).toBe(query);
});

test('values stay strings', () => {
  expect(parseQuery('?n=2&ok=true')).toEqual({ n: '2', ok: 'true' });
});
