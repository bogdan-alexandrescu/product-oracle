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
  {
    id: 'lp1-b',
    url: `${PRIO}?lp1=b`,
    run: async (p, s) => {
      await rowInView(p);
      await s('rest');
      await panel(p);
      await p.getByRole('button', { name: 'About Link by code' }).click();
      await s('open');
      await p.getByRole('button', { name: 'About Link by code' }).click();
      await p.getByRole('button', { name: 'Copy F-79' }).click();
      await s('mid');
      // The result: Lena opens #503 with F-79 in its title; Oracle links it by itself.
      await p.goto(`${PRIO}?lp1=b&phase=done`);
      await p.waitForLoadState('networkidle');
      await panel(p);
      await s('done', 'Cost: 1 click in Oracle + 4 keys in the title · today: no way to link one');
    },
    hard: { url: `${PRIO}?lp1=b`, prep: (p) => panel(p, 'Mobile alert push') },
    phone: { url: `${PRIO}?lp1=b`, prep: (p) => panel(p) },
  },
  {
    id: 'lp1-c',
    url: `${PRIO}?lp1=c`,
    run: async (p, s) => {
      await rowInView(p);
      await s('rest');
      await panel(p);
      await p.getByLabel('Paste a pull request link').click();
      await s('open');
      await p.getByLabel('Paste a pull request link').fill('https://github.com/alertly/web/pull/503');
      await s('mid');
      await p.getByLabel('Paste a pull request link').press('Enter');
      await s('done', 'Cost: copy the link in GitHub, 2 clicks + paste · today: no way to link one');
    },
    hard: { url: `${PRIO}?lp1=c&data=many`, prep: (p) => rowInView(p) },
    phone: { url: `${PRIO}?lp1=c`, prep: (p) => rowInView(p) },
  },
  {
    id: 'lp1-d',
    url: `${PRIO}?lp1=d`,
    run: async (p, s) => {
      await panel(p);
      await reveal(p, 'mk-section');
      await s('rest');
      await p.getByRole('button', { name: '+ Link pull requests' }).click();
      await s('open');
      await p.getByRole('dialog', { name: 'Link pull requests' }).getByText('#503').click();
      await p.getByRole('dialog', { name: 'Link pull requests' }).getByText('#502').click();
      await s('mid');
      await p.getByRole('button', { name: 'Link 2' }).click();
      await reveal(p, 'mk-section');
      await s('done', 'Cost: scroll + 4 clicks · today: no way to link one');
    },
    hard: {
      url: `${PRIO}?lp1=d&data=many`,
      prep: async (p) => {
        await panel(p);
        await reveal(p, 'mk-section');
      },
    },
    phone: {
      url: `${PRIO}?lp1=d`,
      prep: async (p) => {
        await panel(p);
        await reveal(p, 'mk-section');
      },
    },
  },
  {
    id: 'lp2-a',
    url: `${PRIO}?lp2=a`,
    run: async (p, s) => {
      await rowInView(p);
      await s('rest');
      await p.getByTestId('mk-row-suggest').first().click();
      await p.getByTestId('mk-suggest').waitFor();
      await s('open');
      await p.getByRole('button', { name: 'About Why Oracle suggests it' }).click();
      await s('mid');
      await p.getByRole('button', { name: 'About Why Oracle suggests it' }).click();
      await p.getByTestId('mk-suggest').getByRole('button', { name: 'Accept' }).click();
      await s('done', 'Cost: 2 clicks · today: open the panel, Change status, pick Done, Save (4 clicks), only if someone notices');
      await p.goto(`${INBOX}?lp2=a`);
      await p.waitForLoadState('networkidle');
      await p.waitForTimeout(600);
      await s('inbox');
    },
    hard: {
      url: `${PRIO}?lp2=a`,
      role: 'commenter',
      prep: async (p) => {
        await p.getByTestId('mk-row-suggest').first().click();
        await p.getByTestId('mk-suggest').waitFor();
      },
    },
    phone: {
      url: `${PRIO}?lp2=a`,
      prep: async (p) => {
        await p.getByTestId('mk-row-suggest').first().click();
        await p.getByTestId('mk-suggest').waitFor();
        await reveal(p, 'mk-suggest');
      },
    },
  },
  {
    id: 'lp2-b',
    url: `${INBOX}?lp2=b&data=many`,
    run: async (p, s) => {
      await s('rest');
      await p.getByRole('button', { name: `About Pull requests on ${DIGEST}` }).click();
      await s('open');
      await p.getByRole('button', { name: `About Pull requests on ${DIGEST}` }).click();
      await p.getByRole('button', { name: 'Accept all 4' }).hover();
      await s('mid');
      await p.getByRole('button', { name: 'Accept all 4' }).click();
      await s('done', 'Cost: 1 click for all 4 · today: 4 clicks per feature, 16');
    },
    hard: { url: `${INBOX}?lp2=b&data=many`, role: 'commenter', prep: async () => {} },
    phone: { url: `${INBOX}?lp2=b&data=many`, prep: async () => {} },
  },
  {
    id: 'lp2-c',
    url: `${PRIO}?lp2=c`,
    run: async (p, s) => {
      await rowInView(p);
      await s('rest');
      await p.getByTestId('mk-row-inline').getByRole('button').first().click();
      await s('open');
      await p.getByRole('button', { name: 'Accept Done' }).hover();
      await s('mid');
      await p.getByRole('button', { name: 'Accept Done' }).click();
      await s('done', 'Cost: 2 clicks, on Priorities only · today: 4 clicks in the panel');
    },
    hard: {
      url: `${PRIO}?lp2=c`,
      role: 'commenter',
      prep: async (p) => {
        await rowInView(p);
        await p.getByTestId('mk-row-inline').getByRole('button').first().click();
      },
    },
    phone: {
      url: `${PRIO}?lp2=c`,
      prep: async (p) => {
        await rowInView(p);
        await p.getByTestId('mk-row-inline').getByRole('button').first().click();
      },
    },
  },
  {
    id: 'lp3-a',
    url: `${PRIO}?lp3=a&link=gone`,
    run: async (p, s) => {
      await rowInView(p);
      await panel(p);
      await s('rest');
      await p.getByRole('button', { name: 'Fix' }).click();
      await s('open');
      await p.getByRole('menuitem', { name: 'Remove the link' }).hover();
      await s('mid');
      await p.getByRole('menuitem', { name: 'Remove the link' }).click();
      await s('done', 'Cost: 2 clicks, where the link shows · today: no links to break');
    },
    hard: { url: `${PRIO}?lp3=a&host=off`, prep: (p) => panel(p) },
    phone: { url: `${PRIO}?lp3=a&link=gone`, prep: (p) => panel(p) },
  },
  {
    id: 'lp3-c',
    url: `${INBOX}?lp3=c&link=gone`,
    run: async (p, s) => {
      await s('rest');
      await p.getByRole('button', { name: 'Relink' }).click();
      await s('open');
      await p.getByLabel('Find a pull request').pressSequentially('unsub', { delay: 40 });
      await s('mid');
      await p.getByRole('button', { name: `Link #503 to ${DIGEST}` }).click();
      await s('done', 'Cost: 2 clicks + 5 keys, from the Inbox · today: no links to break');
    },
    hard: { url: `${INBOX}?lp3=c&host=off`, prep: async () => {} },
    phone: { url: `${INBOX}?lp3=c&link=gone`, prep: async () => {} },
  },
  {
    id: 'lp3-d',
    url: `${PRIO}?lp3=d&link=gone`,
    run: async (p, s) => {
      await s('rest');
      await p.getByTestId('mk-strip').getByRole('button', { name: 'Show' }).click();
      await s('open');
      await p.getByRole('button', { name: 'Remove the link' }).hover();
      await s('mid');
      await p.getByRole('button', { name: 'Remove the link' }).click();
      await s('done', 'Cost: 2 clicks, at the top of Priorities · today: no links to break');
    },
    hard: { url: `${PRIO}?lp3=d&host=off`, role: 'viewer', prep: async () => {} },
    phone: { url: `${PRIO}?lp3=d&link=gone`, prep: async () => {} },
  },
];

const ONLY = process.env.MK_ONLY?.split(',');
for (const st of STORIES.filter((x) => !ONLY || ONLY.includes(x.id))) {
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
