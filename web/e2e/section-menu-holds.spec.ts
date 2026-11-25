import { MOCK_SCENARIO_KEY, MOCK_SLOW_KEY } from '../lib/api/mock/server';

import { login, openSection } from './helpers';
import { expect, test } from './test';

/*
 * A section's Actions menu stays open while the page finishes loading.
 *
 * Card (E2E): protects=a person who opens a section's Actions menu the moment the section shows
 * keeps the menu open and finds Start a discussion in it once the document's read lands (the
 * document's read says it is a PRD, which draws the sections another way: the menu had been
 * closed by that switch, so a first click was lost); fails_when=the menu closes when the
 * document's read lands; no_claim=the real API's timing (the mock delays the read 1.5 s).
 */
test("a section's Actions menu stays open when the document's read lands after it", async ({
  page,
}) => {
  await page.addInitScript(([k, s]) => localStorage.setItem(k, s), [
    MOCK_SCENARIO_KEY,
    'discussion-replies',
  ] as const);
  await login(page, 'commenter@example.com');
  await page.evaluate(([k, v]) => localStorage.setItem(k, v), [
    MOCK_SLOW_KEY,
    '/v1/documents/annual-billing',
  ] as const);
  await page.goto('/documents/annual-billing/v/2');
  const problem = await openSection(page, 'problem');
  const actions = problem.getByRole('button', { name: /^Actions for .*Problem$/ });
  await actions.click();
  await expect(actions).toHaveAttribute('aria-expanded', 'true');
  await expect(problem.getByRole('menuitem', { name: 'Start a discussion' })).toBeVisible();
  await expect(actions).toHaveAttribute('aria-expanded', 'true');
});
