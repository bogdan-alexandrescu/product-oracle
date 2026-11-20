import { login } from './helpers';
import { expect, test, type Locator } from './test';

/*
 * QA Nov 17: one code names one feature. The Ground Truth gives F-01 to Setup checklist and F-06 to Setup error
 * report; Simple's Priorities showed "F-06 Weekly alert digest" (a PRD section's code shown as the feature's code)
 * and flagged Setup checklist "Not in the Ground Truth". Default mock scenario (invented data), as the owner.
 */

async function tap(l: Locator) {
  await l.evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await l.click();
}

test('Priorities names each feature by its own Ground Truth code', async ({ page }) => {
  // protects: Setup checklist reads "F-01 Setup checklist" on its row and in its panel; no row reads F-06 with a name
  // other than Setup error report's
  // fails_when: Setup checklist has no code and carries "Not in the Ground Truth", or Weekly alert digest reads F-06
  // no_claim: Detailed Priorities and the Ground Truth page (they read the Ground Truth's features)
  await login(page);
  await page.goto('/simple/priorities');
  const row = page.locator('[data-testid="prio-row"][data-code="setup-checklist"]');
  await expect(row.getByTestId('prio-own-key')).toHaveText('F-01');
  await expect(row).not.toContainText('Not in the Ground Truth');
  const rows = page.getByTestId('prio-row');
  await expect(rows.first()).toBeVisible();
  const named = await rows.evaluateAll((els) =>
    els.map((el) => ({
      code: el.querySelector('[data-testid="prio-own-key"]')?.textContent?.trim() ?? '',
      title: el.querySelector('[data-testid="prio-title"]')?.textContent?.trim() ?? '',
    })),
  );
  expect(named.filter((r) => r.code === 'F-06' && r.title !== 'Setup error report')).toEqual([]);

  await tap(row.getByTestId('prio-title'));
  const panel = page.getByTestId('floating-card');
  await expect(panel.getByTestId('card-name')).toHaveText(/^F-01\s*Setup checklist/);
  await expect(panel).not.toContainText('Not in the Ground Truth');
});

test("the mock's Simple roadmap codes name the Ground Truth's features", async ({ page }) => {
  // protects: every Simple roadmap item whose code is a Ground Truth feature's has that feature's name, and Setup
  // checklist reads F-01 (mock parity: one code names one feature, docs/ground-truth.md)
  // fails_when: an item shows a PRD section's code another Ground Truth feature has (F-06 Weekly alert digest)
  // no_claim: items whose code no Ground Truth feature has (they are flagged elsewhere)
  await login(page);
  await page.goto('/simple/priorities');
  await expect(page.getByTestId('prio-row').first()).toBeVisible();
  const got = await page.evaluate(async () => {
    const f = (globalThis as { __poMockFetch?: (r: Request) => Promise<Response> }).__poMockFetch!;
    const get = async (path: string) =>
      (await f(new Request(new URL(path, location.origin)))).json();
    const features = (await get('/v1/baseline/entities?type=feature')) as {
      key: string;
      title: string;
    }[];
    const items = ((await get('/v1/simple/roadmap')).items ?? []) as {
      key: string;
      code: string | null;
      title: string;
    }[];
    return {
      features: features.map((x) => ({ key: x.key, title: x.title })),
      items: items.map((x) => ({ key: x.key, code: x.code, title: x.title })),
    };
  });
  const byCode = new Map(got.features.map((x) => [x.key.toUpperCase(), x.title]));
  expect(byCode.get('F-01')).toBe('Setup checklist');
  const clashes = got.items.filter(
    (x) =>
      x.code && byCode.has(x.code.toUpperCase()) && byCode.get(x.code.toUpperCase()) !== x.title,
  );
  expect(clashes).toEqual([]);
  expect(got.items.find((x) => x.key === 'setup-checklist')?.code).toBe('F-01');
});
