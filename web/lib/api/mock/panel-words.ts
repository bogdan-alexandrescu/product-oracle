/**
 * panel-2 (#1906, #1907) "panel-words" scenario: the default company with what the UX re-audit
 * found in the feature panel, in invented data: two more owners (so the company's owners decide
 * Weekly alert digest), its title carrying its PRD's name and a priority tag, the note Oracle
 * writes when it makes a roadmap version, and its goal's target ending in milestone shorthand.
 */
import { goalBucketsDb } from './goal-buckets';
import { stableUuid } from './ids';
import { ROADMAPS, roadmapGoal, seedSimpleRoadmap, writeRoadmapGoal } from './simple-roadmap';

import type { Db } from './server';

export const PANEL_WORDS_SCENARIO = 'panel-words';

export function seedPanelWords(db: Db): void {
  for (const [i, [email, name]] of [
    ['robin.hart@example.com', 'Robin Hart'],
    ['sam.ortiz@example.com', 'Sam Ortiz'],
  ].entries())
    db.members.push({
      email,
      name,
      role: 'owner' as const,
      engineering_lead: false,
      created_at: `2026-09-2${i}T09:00:00Z`,
      id: stableUuid(`panel-words/${email}`),
      disabled_at: null,
      disabled_by: null,
      status: 'active' as const,
      open_tokens: 0,
    });
  const rm = (db.simple_roadmap ??= seedSimpleRoadmap());
  const digest = rm.items.find((s) => s.key === 'alert-digest');
  if (digest) {
    digest.title = `${ROADMAPS[digest.roadmap].prd}: ${digest.title} (P0)`;
    digest.note = 'from version 21';
  }
  // The goal store the panel reads (built here so the target written below is the one it reads).
  goalBucketsDb(
    rm,
    db.members.map((m) => ({ id: m.id, name: m.name ?? m.email, email: m.email, role: m.role })),
  );
  const goal = roadmapGoal(rm, 'grow-retention');
  writeRoadmapGoal(rm, 'grow-retention', { ...goal, target: `${goal.target} (M2)` });
}
