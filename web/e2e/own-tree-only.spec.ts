import fs from 'node:fs';
import path from 'node:path';

import { CONTRACTS, ROOT } from '../lib/ownTreeOnly';
import { expect, test } from './test';

// #1570: a spec reads web/ and the contracts other trees publish, and nothing else of the checkout.
test('a read outside web/ and docs/contracts throws ForeignRead', async () => {
  expect(fs.readFileSync(path.join(__dirname, 'test.ts'), 'utf8')).toContain('ownTreeOnly');
  expect(fs.readdirSync(CONTRACTS)).toContain('api-plan-strip-cases.json');
  const api = path.join(ROOT, 'api', 'pyproject.toml');
  expect(fs.existsSync(api)).toBe(true);
  expect(() => fs.readFileSync(api, 'utf8')).toThrow(/api\/pyproject.toml is outside web\//);
  expect(() => fs.readdirSync(path.join(ROOT, 'docs'))).toThrow(/ForeignRead|outside web\//);
  await expect(fs.promises.readFile(path.join(ROOT, 'README.md'))).rejects.toThrow(
    /README.md is outside web\//,
  );
});
