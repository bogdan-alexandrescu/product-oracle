import fs from 'node:fs';
import path from 'node:path';

import { expect, test } from 'vitest';

import { CONTRACTS, ROOT, WEB } from '../lib/ownTreeOnly';

// #1570, #1716: a test reads web/ and the contracts other trees publish, and nothing else of the
// checkout. This file runs in Vitest's logic project, so a read here that does not throw means
// vitest.own-tree.ts did not arm the guard.
test('a read outside web/ and docs/contracts throws ForeignRead', async () => {
  expect(fs.readFileSync(path.join(WEB, 'e2e', 'test.ts'), 'utf8')).toContain('ownTreeOnly()');
  expect(fs.readdirSync(CONTRACTS)).toContain('api-plan-strip-cases.json');
  const api = path.join(ROOT, 'api', 'pyproject.toml');
  expect(fs.existsSync(api)).toBe(true);
  expect(() => fs.readFileSync(api, 'utf8')).toThrow(/api\/pyproject.toml is outside web\//);
  expect(() => fs.readdirSync(path.join(ROOT, 'docs'))).toThrow(/ForeignRead|outside web\//);
  await expect(fs.promises.readFile(path.join(ROOT, 'README.md'))).rejects.toThrow(
    /README.md is outside web\//,
  );
});

// Every Vitest project (logic, timing, render) starts with the guard's setup file.
test('every Vitest project arms the guard', () => {
  const config = fs.readFileSync(path.join(WEB, 'vitest.config.mts'), 'utf8');
  const projects = config.split(/\bname: '/).slice(1);
  expect(projects.map((p) => p.slice(0, p.indexOf("'")))).toEqual(['logic', 'timing', 'render']);
  for (const project of projects) expect(project).toMatch(/setupFiles: \[OWN_TREE\b/);
  expect(config).toContain("const OWN_TREE = './vitest.own-tree.ts';");
  expect(fs.readFileSync(path.join(WEB, 'vitest.own-tree.ts'), 'utf8')).toMatch(/ownTreeOnly\(/);
});
