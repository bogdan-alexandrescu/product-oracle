import { MOCK_SCENARIO_KEY } from '../lib/api/mock/server';
import { login } from './helpers';
import { test } from './test';
import { writeFileSync } from 'node:fs';

test('probe', async ({ page }) => {
  const sc = process.env.PROBE_SCENARIO ?? 'simple-plan';
  await page.context().addInitScript(([k, v]) => localStorage.setItem(k, v), [MOCK_SCENARIO_KEY, sc] as const);
  await login(page);
  await page.goto('/simple/priorities');
  await page.getByTestId('prio-row').first().waitFor();
  for (const [name, url] of [['prio', '/v1/simple/priorities'], ['roadmap', '/v1/simple/roadmap']]) {
    const body = await page.evaluate(async (u) => {
      const f = (globalThis as any).__poMockFetch;
      const r = await f(new Request(new URL(u, location.origin)));
      return await r.text();
    }, url);
    writeFileSync(`${process.env.TMPDIR}/probe/${sc}-${name}.json`, body);
  }
});
