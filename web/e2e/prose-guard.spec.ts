/**
 * Prose guard (owner's rule, Nov 5: "No excessive prose on any web page when that can be
 * hidden in nice way behind a tooltip or tick"). Visits every page of Simple and Detailed in
 * the mock production build, as the owner and as a viewer, at 1440 wide, counts the visible
 * prose on each, writes the counts to test-results/prose/ and fails when a page's count is
 * above its ceiling in e2e/prose-ceilings.json. Ceilings only go down, and never by hand:
 * `npm run prose:ratchet` reruns this spec and lowers every ceiling to today's count, and the
 * spec fails when a ceiling is above the merge base's (origin/main; PROSE_BASE names another
 * ref). A page the merge base has no ceiling for starts at 0 (#1724): its explanations go behind
 * a tip, or copy that must stay as written is marked [data-owner-copy]. Every route file of app/
 * is visited or named in NOT_VISITED with why.
 *
 * The rule, as counted here:
 * - Text is what the page renders and a person can see: text nodes whose element passes
 *   checkVisibility() (not display:none, visibility:hidden or opacity 0, not inside a closed
 *   <details>), is at least 2 px each way (no screen-reader-only text) and has no
 *   [hidden] or [aria-hidden="true"] ancestor. Text below the fold counts; nothing is clicked.
 * - Not counted: tooltips and (i) popovers ([role="tooltip"], [popover]), titles and
 *   aria-labels (attributes, never text), form fields (input, textarea, select, option,
 *   contenteditable), code (code, pre, kbd), and user content: PRD and one-pager bodies,
 *   chat and meeting messages, and anything else a person wrote, marked in the app with
 *   [data-user-content] (see USER_CONTENT below for the other selectors that mean the same).
 * - The text left is joined per block (a run of inline text up to its nearest non-inline
 *   ancestor), with a space where one element's text meets another's, so "<b>9</b>decisions"
 *   reads as two words (text nodes side by side in one element, as React renders "comment{s}",
 *   join as they are), whitespace squeezed, and split into sentences after ". ", "! " or "? ".
 * - A sentence is prose when it has 8 or more words; a word is a run of non-space characters
 *   with at least one letter (so dates and numbers do not count: "Oct 30, 2026, 2:49 PM"
 *   is two words, "Oct" and "PM").
 * - A page's count is the number of words in its prose sentences. The guard fails when that
 *   is above the page's ceiling for the role; a page with no ceiling yet fails until
 *   `npm run prose:ratchet` records it, at 0. A page that opened "not found" fails, and its count
 *   is written as missing, which the ratchet ignores.
 * - Nothing is clicked here, so text that shows only once opened is held at the source:
 *   guards/jsx-prose.test.ts.
 *
 * A lane that adds prose hides it (an InfoTip, a tick whose tooltip says why, a link) or this
 * spec fails (docs/agents/lane-rules.md).
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { MOCK_SCENARIO_KEY } from '../lib/api/mock/ids';

import { login } from './helpers';
import { DETAILED, NOT_VISITED, pageRoutes, SIMPLE, type Visit } from './prose-routes';
import { expect, test, type Page } from './test';

const MIN_WORDS = 8;
const MISSING =
  /doesn['’]t exist|was not found|could not be found|may have been drafted into a PRD/i;
const OUT = path.join(__dirname, '..', 'test-results', 'prose');
const CEILINGS_FILE = path.join(__dirname, 'prose-ceilings.json');

/** Selectors whose text is never counted (the header's "Not counted"). */
const SKIP = [
  '[role=tooltip]',
  '[popover]',
  '[hidden]',
  '[aria-hidden=true]',
  'input',
  'textarea',
  'select',
  'option',
  '[contenteditable]:not([contenteditable=false])',
  'code',
  'pre',
  'kbd',
  'script',
  'style',
  'noscript',
  'template',
  'svg',
];
/** User content: what a person wrote, shown as written. */
const USER_CONTENT = [
  '[data-user-content]',
  // PRD sections as written (SectionView, EditSection, a ritual's body, the compare view).
  '.doc-body',
  '[data-section-body]',
  '[data-testid=word-diff]',
  // A one-pager's lines and chat or meeting messages.
  '[data-testid=one-pager-line-text]',
  '[data-testid=chat-message-body]',
  // Copy the owner picked word for word to show as visible text (named in the PR that adds it), e.g.
  // the milestone panel's "Work that serves it · tap bars on the chart to add" (owner, Nov 10).
  '[data-owner-copy]',
];

type Role = 'owner' | 'viewer';
const ROLES: Record<Role, string> = { owner: 'admin@example.com', viewer: 'viewer@example.com' };

type Ceilings = Record<Role, Record<string, number>>;
const ceilings: Ceilings = fs.existsSync(CEILINGS_FILE)
  ? JSON.parse(fs.readFileSync(CEILINGS_FILE, 'utf8'))
  : { owner: {}, viewer: {} };

/**
 * The ceilings on the merge base (with origin/main, or PROSE_BASE), or an error saying why
 * they could not be read. A merge base without the file has no ceilings yet. The spec only
 * reads the repository, never fetches: CI's mock shards check out with main's history
 * (.github/workflows/ci.yml), and run locally it uses the ref that is there.
 */
const git = (...args: string[]) =>
  execFileSync('git', args, {
    cwd: __dirname,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
const BASE_REF = process.env.PROSE_BASE || 'origin/main';
let baseSha: string | null = null;
try {
  baseSha = git('merge-base', 'HEAD', BASE_REF);
} catch {
  // No such ref, or a shallow checkout without the history: baseCeilings says what to run.
}

function baseCeilings(): Ceilings | string {
  if (!baseSha)
    return `no merge base with ${BASE_REF}: run git fetch origin main (with --unshallow in a shallow clone), or set PROSE_BASE to the branch the PR goes into`;
  try {
    return JSON.parse(git('show', `${baseSha}:web/e2e/prose-ceilings.json`));
  } catch {
    return { owner: {}, viewer: {} };
  }
}
const base = baseCeilings();

/**
 * #1724: whether the route's page.tsx is new since the merge base. A new page starts at 0; a page
 * that was there but not yet visited starts at its count (it was missed, not added).
 */
function newPage(route: string): boolean {
  const dir = route === '/' ? '' : route.replace(/\[(\w+)\]/g, '$$$1');
  try {
    git('cat-file', '-e', `${baseSha}:web/app${dir}/page.tsx`);
    return false;
  } catch {
    return true;
  }
}

/** Every route the guard visits, for the ratchet to drop the ceilings of routes gone since. */
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(
  path.join(OUT, 'routes.json'),
  JSON.stringify([...SIMPLE, ...DETAILED].map((v) => v.route)),
);
/** Every page the app has: the ratchet keeps a page's ceiling while its route file is there. */
fs.writeFileSync(path.join(OUT, 'pages.json'), JSON.stringify(pageRoutes()));

/** Waits until the page's text stops changing (the mock answers in the browser). */
async function settle(page: Page) {
  await page.waitForLoadState('networkidle').catch(() => undefined);
  let last = -1;
  for (let i = 0; i < 20; i++) {
    const len = await page.evaluate(() => document.body.innerText.length);
    if (len === last) return;
    last = len;
    await page.waitForTimeout(300);
  }
}

/** Follows `go` to the page, returning the path it opened, or null when a link is missing. */
async function open(page: Page, go: string | string[]): Promise<string | null> {
  const hops = typeof go === 'string' ? [go] : go;
  await page.goto(hops[0]);
  await settle(page);
  for (const prefix of hops.slice(1)) {
    const href = await page.evaluate(
      (p) =>
        [...document.querySelectorAll<HTMLAnchorElement>('a[href]')]
          .map((a) => a.getAttribute('href') ?? '')
          .find((h) => new RegExp(`^${p}$`).test(h.split('?')[0])),
      prefix,
    );
    if (!href) return null;
    await page.goto(href);
    await settle(page);
  }
  return new URL(page.url()).pathname;
}

type Count = { words: number; sentences: string[] };

/** The header's rule, in the page. */
function countProse(page: Page): Promise<Count> {
  return page.evaluate(
    ({ skip, minWords }) => {
      const blocks = new Map<Element, string[]>();
      const last = new Map<Element, Node>();
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const text = n.nodeValue ?? '';
        if (!text.trim()) continue;
        const el = n.parentElement;
        if (!el || el.closest(skip)) continue;
        if (!el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) continue;
        let block: Element = el;
        while (block.parentElement && /^(inline|contents)$/.test(getComputedStyle(block).display))
          block = block.parentElement;
        const parts = blocks.get(block) ?? [];
        if (parts.length && last.get(block) === n.previousSibling) parts[parts.length - 1] += text;
        else parts.push(text);
        blocks.set(block, parts);
        last.set(block, n);
      }
      const sentences: string[] = [];
      let words = 0;
      for (const parts of blocks.values()) {
        const text = parts.join(' ').replace(/\s+/g, ' ').trim();
        for (const s of text.split(/(?<=[.!?])\s+/)) {
          const n = s.split(' ').filter((w) => /\p{L}/u.test(w)).length;
          if (n >= minWords) {
            sentences.push(s);
            words += n;
          }
        }
      }
      return { words, sentences };
    },
    { skip: [...SKIP, ...USER_CONTENT].join(','), minWords: MIN_WORDS },
  );
}

const fileName = (role: Role, route: string) =>
  `${role}${route.replace(/[^a-z0-9-]+/gi, '_')}.json`;

/**
 * Pages in groups of CHUNK per sign-in (a page with its own scenario or seed alone), so the
 * guard takes a few minutes; each page is its own step and fails on its own (expect.soft).
 */
const CHUNK = 8;
function groups(pages: Visit[]): Visit[][] {
  const own = pages.filter((v) => v.scenario || v.seed).map((v) => [v]);
  const rest = pages.filter((v) => !v.scenario && !v.seed);
  const out: Visit[][] = [];
  for (let i = 0; i < rest.length; i += CHUNK) out.push(rest.slice(i, i + CHUNK));
  return [...out, ...own];
}

async function check(page: Page, role: Role, mode: string, v: Visit) {
  const opened = await open(page, v.go);
  expect
    .soft(opened, `no link to ${v.route} on the way there (${JSON.stringify(v.go)})`)
    .not.toBeNull();
  if (!opened) return;
  // A stale id would count a "not found" page instead of the real one; the ratchet skips it.
  const body = await page.locator('body').innerText();
  const missing = MISSING.test(body);
  expect.soft(body, `${v.route} opened a missing page (${opened})`).not.toMatch(MISSING);
  const { words, sentences } = await countProse(page);
  const unseen = typeof base !== 'string' && base[role]?.[v.route] === undefined;
  const isNew = unseen && newPage(v.route);
  // Where the ratchet records a page with no ceiling yet.
  const start = isNew ? 0 : words;
  fs.writeFileSync(
    path.join(OUT, fileName(role, v.route)),
    JSON.stringify(
      { role, mode, route: v.route, url: opened, missing, words, start, sentences },
      null,
      2,
    ),
  );
  const ceiling = ceilings[role]?.[v.route];
  expect
    .soft(
      ceiling,
      `${v.route} as ${role} has no ceiling in e2e/prose-ceilings.json: run npm run prose:ratchet`,
    )
    .toBeDefined();
  if (ceiling === undefined) return;
  // #1724: a page new since the merge base starts at 0; one the guard missed, at its count.
  if (isNew)
    expect
      .soft(
        ceiling,
        `${v.route} as ${role} is new since the merge base: its ceiling starts at 0. Hide its explanations behind an InfoTip, a tick or a link; copy the owner picked to stay as written is marked data-owner-copy`,
      )
      .toBe(0);
  else if (unseen && !missing)
    expect
      .soft(
        ceiling,
        `${v.route} as ${role} was not visited at the merge base: its ceiling starts at its count, ${words}, never above it`,
      )
      .toBeLessThanOrEqual(words);
  expect
    .soft(
      words,
      `${v.route} as ${role}: ${words} words of visible prose, ceiling ${ceiling}. Hide the new explanation behind an InfoTip, a tick or a link (docs/agents/lane-rules.md). Prose sentences:\n${sentences.join('\n')}`,
    )
    .toBeLessThanOrEqual(ceiling);
}

test.describe('prose guard', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("no ceiling is above the merge base's (ceilings are never raised by hand)", () => {
    expect(typeof base === 'string' ? base : null, "the merge base's ceilings").toBeNull();
    if (typeof base === 'string') return;
    const raised = (Object.keys(ROLES) as Role[]).flatMap((role) =>
      Object.entries(ceilings[role] ?? {})
        .filter(([route, n]) => base[role]?.[route] !== undefined && n > base[role][route])
        .map(([route, n]) => `${role} ${route}: ${n}, was ${base[role][route]}`),
    );
    expect(
      raised,
      'Ceilings in e2e/prose-ceilings.json only go down (npm run prose:ratchet); hide the new prose instead',
    ).toEqual([]);
    // #1724: a ceiling goes only with its page, so a visit removed and added again keeps it.
    const pages = pageRoutes();
    const dropped = (Object.keys(ROLES) as Role[]).flatMap((role) =>
      Object.keys(base[role] ?? {})
        .filter((route) => pages.includes(route) && ceilings[role]?.[route] === undefined)
        .map((route) => `${role} ${route}`),
    );
    expect(dropped, 'Ceilings dropped while their page is still there').toEqual([]);
  });

  test('a page whose route file is new since the merge base starts at 0', () => {
    expect(baseSha, 'the merge base').not.toBeNull();
    expect(newPage('/simple/inbox')).toBe(false);
    expect(newPage('/documents/[doc]/v/[n]/quality')).toBe(false);
    expect(newPage('/')).toBe(false);
    expect(newPage('/no-such-page/[id]')).toBe(true);
  });

  test('every route file is visited or named in NOT_VISITED', () => {
    const visited = [...SIMPLE, ...DETAILED].map((v) => v.route);
    const named = [...visited, ...Object.keys(NOT_VISITED)];
    const pages = pageRoutes();
    expect(pages.length).toBeGreaterThan(80);
    expect(pages.filter((r) => !named.includes(r)).sort(), 'route files not visited').toEqual([]);
    expect(named.filter((r) => !pages.includes(r)).sort(), 'no such route file').toEqual([]);
    expect(
      visited.filter((r) => r in NOT_VISITED),
      'both visited and not',
    ).toEqual([]);
  });

  for (const [mode, pages] of [
    ['Simple', SIMPLE],
    ['Detailed', DETAILED],
  ] as const) {
    for (const role of Object.keys(ROLES) as Role[]) {
      for (const group of groups(pages)) {
        test(`${mode} as ${role}: ${group.map((v) => v.route).join(', ')}`, async ({ page }) => {
          const [first] = group;
          if (first.scenario)
            await page.addInitScript(([k, s]) => localStorage.setItem(k, s), [
              MOCK_SCENARIO_KEY,
              first.scenario,
            ] as const);
          await login(page, ROLES[role]);
          if (first.seed) await first.seed(page);
          for (const v of group) await test.step(v.route, () => check(page, role, mode, v));
        });
      }
    }
  }
});
