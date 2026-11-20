import { expect, test } from './test';

import { login } from './helpers';

/*
 * #1580: every page a client view, ready for the move off Next.
 * protects=the fonts, the public links' tab title and privacy tags, and the old addresses,
 * once next/font, `metadata` and the redirect pages are gone;
 * fails_when=a font is not served from /fonts, /i/ or /s/ loses its title or its noindex and
 * no-referrer tags, or an old address no longer lands where it did;
 * no_claim=each page's own content (its own spec drives that).
 */

test('the type is self-hosted: Inter Tight and DM Mono load from /fonts', async ({ page }) => {
  const fonts: string[] = [];
  page.on('response', (r) => {
    if (r.url().endsWith('.woff2') && r.ok()) fonts.push(new URL(r.url()).pathname);
  });
  await page.goto('/login');
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  const loaded = await page.evaluate(() =>
    [...document.fonts]
      .filter((f) => f.status === 'loaded')
      .map((f) => `${f.family.replace(/"/g, '')} ${f.weight}`),
  );
  expect(loaded).toContain('Inter Tight 100 900');
  expect(await page.evaluate(() => getComputedStyle(document.body).fontFamily)).toMatch(
    /^"?Inter Tight"?, "?Inter Tight Fallback"?/,
  );
  expect(fonts).toContain('/fonts/inter-tight-latin.woff2');
  // The figures' face, both weights.
  for (const weight of [400, 500]) {
    const faces = await page.evaluate(
      async (w) =>
        (await document.fonts.load(`${w} 15px "DM Mono"`)).map(
          (f) => `${f.family.replace(/"/g, '')} ${f.weight}`,
        ),
      weight,
    );
    expect(faces).toEqual([`DM Mono ${weight}`]);
    await expect.poll(() => fonts).toContain(`/fonts/dm-mono-latin-${weight}.woff2`);
  }
});

for (const [path, title] of [
  ['/i/i-not-a-real-link', 'Interview'],
  ['/s/s-not-a-real-link', 'Shared roadmap'],
] as const) {
  test(`${path} names the tab "${title}" and is never indexed nor sent on`, async ({ page }) => {
    await page.goto(path);
    await expect(page).toHaveTitle(title);
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute(
      'content',
      'noindex, nofollow',
    );
    await expect(page.locator('meta[name="referrer"]')).toHaveAttribute('content', 'no-referrer');
  });
}

test('old addresses land where they did (one redirect table)', async ({ page }) => {
  await login(page);
  await page.goto('/roadmap');
  await expect(page).toHaveURL(/\/plan$/);
  await page.goto('/baseline?tab=proposals');
  await expect(page).toHaveURL(/\/ground-truth\?tab=proposals$/);
  await page.goto('/requests/new');
  await expect(page).toHaveURL(/\/requests\?compose=request$/);
  await page.goto('/requests/new?request=r-example');
  await expect(page).toHaveURL(/\/requests\/to-decide\?request=r-example$/);
  await page.goto('/simple/prds/guided-setup');
  await expect(page).toHaveURL(/\/simple\/one-pagers\/guided-setup$/);
});
