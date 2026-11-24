// MOCK-HOOK (whole file): drives each mk-linked-pr proposal through the mock app as a person
// would and snapshots its frames. Run: swarm-test-browsers npx playwright test -c mk/mk.config.ts
import type { Browser, Page } from '@playwright/test';

import { test } from '../e2e/test';
import { login } from '../e2e/helpers';
import { snap } from './snap';

const D = { width: 1440, height: 900 };
const W = { width: 1512, height: 900 };
const P = { width: 390, height: 844 };
const DIGEST = 'Weekly alert digest';
const PRIO = '/simple/priorities';
const INBOX = '/simple/inbox';

async function start(browser: Browser, url: string, size = D, role?: string): Promise<Page> {
  const ctx = await browser.newContext({ viewport: size, hasTouch: size.width < 500 });
  if (role) await ctx.addInitScript((r) => localStorage.setItem('po-mock-role', r), role);
  const page = await ctx.newPage();
  await login(page);
  await page.goto(url);
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(800);
  return page;
}

async function panel(page: Page, name = DIGEST) {
  await page.getByTestId('prio-title').filter({ hasText: name }).first().click();
  await page.getByTestId('mk-panel-prs').or(page.getByTestId('mk-section')).first().waitFor();
  await page.waitForTimeout(400);
}
async function reveal(page: Page, testId: string) {
  await page.getByTestId(testId).first().scrollIntoViewIfNeeded();
}
async function rowInView(page: Page, name = DIGEST) {
  await page.getByTestId('prio-title').filter({ hasText: name }).first().scrollIntoViewIfNeeded();
}

type Story = {
  id: string;
  url: string;
  run: (p: Page, s: (state: string, note?: string) => Promise<void>) => Promise<void>;
  hard: { url: string; role?: string; prep: (p: Page) => Promise<void> };
  phone: { url: string; prep: (p: Page) => Promise<void> };
};

const STORIES: Story[] = [
  {
    id: 'lp1-a',
    url: `${PRIO}?lp1=a`,
    run: async (p, s) => {
      await rowInView(p);
      await s('rest');
      await panel(p);
      await p.getByRole('button', { name: 'Link a pull request' }).click();
      await s('open');
      await p.getByLabel('Find a pull request').pressSequentially('unsub', { delay: 40 });
      await s('mid');
      await p.getByRole('button', { name: `Link #503 to ${DIGEST}` }).click();
      await s('done', 'Cost: 3 clicks + 5 keys · today: no way to link one');
    },
    hard: { url: `${PRIO}?lp1=a&data=many`, prep: (p) => panel(p) },
    phone: { url: `${PRIO}?lp1=a`, prep: (p) => panel(p) },
  },
];

for (const st of STORIES) {
  test(st.id, async ({ browser }) => {
    const p = await start(browser, st.url);
    await st.run(p, (state, note) => snap(p, `${st.id}-${state}`, note));
    await p.context().close();
    for (const size of [D, W]) {
      const h = await start(browser, st.hard.url, size, st.hard.role);
      await st.hard.prep(h);
      await snap(h, `${st.id}-hard${size === W ? '-1512' : ''}`);
      await h.context().close();
    }
    const ph = await start(browser, st.phone.url, P);
    await st.phone.prep(ph);
    await snap(ph, `${st.id}-phone-390`);
    await ph.context().close();
  });
}
