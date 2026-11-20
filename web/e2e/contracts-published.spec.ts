import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { codeLeftOut } from '../lib/api/mock/code-left-out';
import { CONTRACTS, contract } from '../lib/ownTreeOnly';
import { expect, test } from './test';

/**
 * #1570: the values the API's tests check against the web are published by the web as JSON
 * in docs/contracts (web-* and mock-*), and the API's tests read only those copies. Each
 * copy here equals what the web has now; CONTRACTS_WRITE=1 rewrites them.
 */
const WEB = path.resolve(__dirname, '..');
const MOCK = path.join(WEB, 'lib', 'api', 'mock');
const read = (...parts: string[]) => fs.readFileSync(path.join(WEB, ...parts), 'utf8');
const json = (file: string) => JSON.parse(read('lib', 'api', 'mock', file));

function pages(dir: string, at = ''): string[] {
  const here = fs.existsSync(path.join(dir, 'page.tsx')) ? [at] : [];
  const subs = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory());
  return [
    ...here,
    ...subs.flatMap((e) => pages(path.join(dir, e.name), at ? `${at}/${e.name}` : e.name)),
  ].sort();
}

function listed(source: string, from: RegExp, item: RegExp): string[] {
  const block = source.match(from);
  if (!block) throw new Error(`${from} is not in the source`);
  return [...block[1].matchAll(item)].map((m) => m[1]);
}

const PUBLISHED: Record<string, () => unknown> = {
  'mock-checkpoint-review': () => json('checkpoint-review.json'),
  'mock-roadmap-items': () => json('roadmap-items.json'),
  'mock-fit-date-plan': () => json('fit-date-plan.json'),
  // The mock's per-document switches (llm-jobs.ts KINDS) the Playwright tests drive.
  'mock-llm-job-settings': () => ({
    kinds: listed(
      read('lib', 'api', 'mock', 'llm-jobs.ts'),
      /const KINDS[^=]*=\s*\[([^\]]*)\]/,
      /["']([a-z_]+)["']/g,
    ),
  }),
  // The mock's codeLeftOut run on every case the API publishes: the API checks it gives the same.
  'mock-code-left-out': () => ({
    href: 'H',
    cases: (contract('api-code-left-out-cases') as string[]).map((body) => ({
      body,
      out: codeLeftOut(body, 'H'),
    })),
  }),
  // Home's Set up checklist (app/home/_setup.tsx STEPS): the steps it has copy for.
  'web-setup-steps': () => ({
    steps: listed(
      read('app', 'home', '_setup.tsx'),
      /const STEPS[^=]*=\s*\{([\s\S]*?)\n\};/,
      /^ {2}(\w+): \{$/gm,
    ),
  }),
  // How long the web's /v1 proxy (next.config.ts proxyTimeout) waits for the API.
  'web-proxy': () => ({
    proxy_timeout_ms: Number(
      listed(read('next.config.ts'), /proxyTimeout:\s*([\d_]+)/, /(\d+)/g).join(''),
    ),
  }),
  // The app's icon, which the API's invite mail carries inline, byte for byte.
  'web-app-icon': () => ({
    sha256: createHash('sha256')
      .update(fs.readFileSync(path.join(WEB, 'app', 'apple-icon.png')))
      .digest('hex'),
  }),
  // Every page the app has (a folder of app/ with a page.tsx), for the API's links.
  'web-pages': () => ({ pages: pages(path.join(WEB, 'app')) }),
};

test("the web's published contracts are what the web has", () => {
  expect(fs.existsSync(MOCK)).toBe(true);
  for (const [name, value] of Object.entries(PUBLISHED)) {
    const file = path.join(CONTRACTS, `${name}.json`);
    if (process.env.CONTRACTS_WRITE === '1')
      fs.writeFileSync(file, `${JSON.stringify(value(), null, 2)}\n`);
    expect(
      contract(name),
      `docs/contracts/${name}.json: run this spec with CONTRACTS_WRITE=1`,
    ).toEqual(value());
  }
});
