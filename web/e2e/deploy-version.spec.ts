import { expect, test } from './test';

// #1569: the web image serves the commit it was built from (web/Dockerfile's GIT_SHA build
// argument) at /version, without signing in, for the deploy's containment check
// (web/scripts/deploy-serves.ts). The mock build carries no stamp: "unknown".
test('the web serves its build commit at /version without signing in', async ({ request }) => {
  const r = await request.get('/version');
  expect(r.status()).toBe(200);
  expect(r.headers()['cache-control']).toContain('no-store');
  expect(await r.json()).toEqual({ git_sha: 'unknown' });
});
