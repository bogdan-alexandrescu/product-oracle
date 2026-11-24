// The prose guard's pages (e2e/prose-guard.spec.ts): how to reach each, and the route files it
// does not visit, with why (#1724: every route file is one or the other).
import fs from 'node:fs';
import path from 'node:path';

import { BEFORE_DRAFTING } from '../lib/api/mock/intake';
import { MOCK_INTERVIEW_TOKEN } from '../lib/api/mock/interviews';
import { ROADMAP_REVIEW_RUN } from '../lib/api/mock/runs';
import { CHAT_MEETING_ID } from '../lib/api/mock/simple-chat';

import { seedRoadmapReview } from './helpers';

import type { Page } from './test';

/**
 * A page: its route (the ceilings' key) and how to reach it. `go` is a path, or a path then
 * patterns of the links to follow from it (the first link whose path matches, in turn), for a
 * page whose id only the mock knows;
 * `scenario` the mock scenario that has its data, or `seed` adds it after signing in (as
 * e2e/helpers.ts's seeds do for other specs). Not visited: NOT_VISITED, with why.
 */
export type Visit = {
  route: string;
  go: string | string[];
  scenario?: string;
  seed?: (page: Page) => Promise<unknown>;
};

export const SIMPLE: Visit[] = [
  { route: '/simple', go: '/simple' },
  { route: '/simple/decisions', go: '/simple/decisions' },
  { route: '/simple/goals', go: '/simple/goals' },
  { route: '/simple/inbox', go: '/simple/inbox' },
  { route: '/simple/meetings', go: '/simple/meetings' },
  { route: '/simple/meetings/[id]', go: ['/simple/meetings', '/simple/meetings/[^/]+'] },
  { route: '/simple/meetings/[id]/chat', go: `/simple/meetings/${CHAT_MEETING_ID}/chat` },
  { route: '/simple/one-pagers', go: '/simple/one-pagers' },
  { route: '/simple/one-pagers/[doc]', go: '/simple/one-pagers/guided-setup' },
  { route: '/simple/priorities', go: '/simple/priorities' },
  { route: '/simple/roadmap', go: '/simple/roadmap' },
];

export const DETAILED: Visit[] = [
  { route: '/home', go: '/home' },
  { route: '/inbox', go: '/inbox' },
  { route: '/documents', go: '/documents' },
  { route: '/documents/new', go: '/documents/new' },
  { route: '/documents/[doc]', go: '/documents/annual-billing' },
  { route: '/documents/[doc]/composition', go: '/documents/annual-billing/composition' },
  { route: '/documents/[doc]/diff', go: '/documents/annual-billing/diff' },
  { route: '/documents/[doc]/public', go: '/documents/annual-billing/public' },
  { route: '/documents/[doc]/publish', go: '/documents/referral-link/publish' },
  { route: '/documents/[doc]/v/[n]', go: '/documents/annual-billing/v/2' },
  { route: '/documents/[doc]/v/[n]/evidence', go: '/documents/annual-billing/v/2/evidence' },
  { route: '/documents/[doc]/v/[n]/impact', go: '/documents/annual-billing/v/2/impact' },
  { route: '/documents/[doc]/v/[n]/items', go: '/documents/annual-billing/v/2/items' },
  { route: '/documents/[doc]/v/[n]/present', go: '/documents/referral-link/v/2/present' },
  { route: '/documents/[doc]/v/[n]/quality', go: '/documents/referral-link/v/2/quality' },
  { route: '/documents/[doc]/v/[n]/roadmap', go: '/documents/usage-alerts/v/1/roadmap' },
  { route: '/briefs/[id]', go: ['/documents/annual-billing', '/briefs/[^/]+'] },
  // The mock's ids are stable for a scenario (its seed is seeded): Guided setup's entity and R-90's deletion.
  {
    route: '/impact/entities/[id]',
    scenario: 'impact',
    go: '/impact/entities/959a57aa-38ad-4d78-8178-3342688ce78c',
  },
  {
    route: '/impact/changes/[id]',
    scenario: 'impact',
    go: '/impact/changes/b7dce326-2a47-4000-8b74-562e8ac05a9c',
  },
  { route: '/ground-truth', go: '/ground-truth' },
  { route: '/priorities', go: '/priorities' },
  { route: '/plan', go: '/plan' },
  { route: '/plan/dates', go: '/plan/dates' },
  { route: '/plan/documents', go: '/plan/documents' },
  { route: '/plan/outcomes', go: '/plan/outcomes' },
  { route: '/plan/reports', go: '/plan/reports' },
  { route: '/plan/reports/latest', go: '/plan/reports/latest' },
  {
    route: '/plan/reports/[id]',
    scenario: 'alignment-report',
    go: ['/plan/reports', '/plan/reports/(?!latest)[^/]+'],
  },
  { route: '/roadmap/changelog', go: '/roadmap/changelog' },
  { route: '/roadmap/launches', go: '/roadmap/launches' },
  { route: '/requests', go: '/requests' },
  { route: '/requests/themes', go: '/requests/themes' },
  { route: '/requests/to-decide', go: '/requests/to-decide' },
  { route: '/requests/interviews', go: '/requests/interviews' },
  {
    route: '/requests/interviews/[id]',
    go: '/requests/interviews/66952c66-1c80-4e84-84a4-838e1243af88',
  },
  {
    route: '/intakes/[id]',
    scenario: 'before-drafting',
    go: `/intakes/${BEFORE_DRAFTING.intakeId}`,
  },
  { route: '/runs', go: '/runs' },
  { route: '/runs/[id]', go: ['/runs', '/runs/[^/]+'] },
  {
    route: '/runs/[id]/review/[checkpoint]',
    seed: seedRoadmapReview,
    go: `/runs/${ROADMAP_REVIEW_RUN.run.id}/review/${ROADMAP_REVIEW_RUN.run.checkpoints[0].id}`,
  },
  { route: '/sources', go: '/sources' },
  { route: '/company/decisions', go: '/company/decisions' },
  { route: '/company/market', go: '/company/market' },
  { route: '/company/metrics', go: '/company/metrics' },
  { route: '/company/rituals', go: '/company/rituals' },
  // The market scenario's competitive digest (MARKET_DIGEST_ID in lib/api/mock/server.ts).
  {
    route: '/company/rituals/[occurrence]',
    scenario: 'market',
    go: '/company/rituals/6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b',
  },
  { route: '/company/strategy', go: '/company/strategy' },
  { route: '/company/updates', go: '/company/updates' },
  {
    route: '/specs/[id]/design/[versionId]',
    go: '/specs/c3000000-0000-4000-8000-000000000001/design/c3000000-0000-4000-8000-000000000013',
  },
  { route: '/design', go: '/design' },
  { route: '/account', go: '/account' },
  { route: '/i/[token]', go: `/i/${MOCK_INTERVIEW_TOKEN}` },
  { route: '/settings/analytics', go: '/settings/analytics' },
  { route: '/settings/api-tokens', go: '/settings/api-tokens' },
  { route: '/settings/autonomy', go: '/settings/autonomy' },
  { route: '/settings/claude-accounts', go: '/settings/claude-accounts' },
  { route: '/settings/company', go: '/settings/company' },
  { route: '/settings/connections', go: '/settings/connections' },
  { route: '/settings/members', go: '/settings/members' },
  { route: '/settings/notifications', go: '/settings/notifications' },
  { route: '/settings/sources', go: '/settings/sources' },
  { route: '/settings/templates', go: '/settings/templates' },
  { route: '/settings/templates/new', go: '/settings/templates/new' },
  { route: '/settings/templates/[key]', go: '/settings/templates/one-pager' },
  { route: '/settings/themes', go: '/settings/themes' },
  { route: '/settings/themes/new', go: '/settings/themes/new' },
  { route: '/settings/themes/[key]', go: '/settings/themes/clean-document' },
  { route: '/settings/trash', go: '/settings/trash' },
  { route: '/settings/webhooks', go: '/settings/webhooks' },
];

/** Route files the guard does not visit, and why: every other one is in SIMPLE or DETAILED. */
export const NOT_VISITED: Record<string, string> = {
  '/': 'redirects',
  '/company': 'redirects',
  '/settings': 'redirects',
  '/login': 'signed out',
  '/access': 'signed out',
  '/oauth/consent': 'signed out',
  '/s/[token]': 'signed out: a shared link',
};

/** The route of each page.tsx under app/: a `$name` folder is `[name]`, a `_` folder is not a route. */
export function pageRoutes(dir = path.join(__dirname, '..', 'app'), at = ''): string[] {
  const here = fs.existsSync(path.join(dir, 'page.tsx')) ? [at || '/'] : [];
  return [
    ...here,
    ...fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('_'))
      .flatMap((e) =>
        pageRoutes(path.join(dir, e.name), `${at}/${e.name.replace(/^\$(\w+)$/, '[$1]')}`),
      ),
  ];
}
