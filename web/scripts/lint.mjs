#!/usr/bin/env node
// `npm run lint`: ESLint in two passes over the same files, each in its own process under a
// 4 GB heap (#1585 phase 4). The typed rules need a TypeScript program of the whole tree; with
// every other rule in the same process the heap ran out. eslint.config.mjs picks the rules by
// LINT_PASS: `untyped` is every rule but TYPED_RULES, `typed` is only those.
//
//   npm run lint [-- <eslint arguments>]   e.g. `-- app/inbox`, `-- --suppress-all`
//
// eslint-suppressions.json stays one file. Each pass gets its rules' entries in a copy under
// $TMPDIR, since ESLint fails on entries for rules it did not run; a pass that rewrote its copy
// (--suppress-all, --prune-suppressions) is merged back. The exit code is the worse pass's.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TYPED_RULES } from '../eslint.config.mjs';

const SUPPRESSIONS = 'eslint-suppressions.json';
const ESLINT = join(import.meta.dirname, '../node_modules/eslint/bin/eslint.js');

function sorted(value) {
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sorted(value[key])]),
  );
}

// The same text ESLint writes (json-stable-stringify: sorted keys, two spaces, no newline).
const stringify = (value) => JSON.stringify(sorted(value), null, 2);

function slice(suppressions, typed) {
  const out = {};
  for (const [file, rules] of Object.entries(suppressions)) {
    const kept = Object.entries(rules).filter(([rule]) => rule in TYPED_RULES === typed);
    if (kept.length) out[file] = Object.fromEntries(kept);
  }
  return out;
}

const all = existsSync(SUPPRESSIONS) ? JSON.parse(readFileSync(SUPPRESSIONS, 'utf8')) : {};
const dir = mkdtempSync(join(tmpdir(), 'lint-'));
const passes = ['untyped', 'typed'].map((pass) => {
  const file = join(dir, `${pass}.json`);
  const text = stringify(slice(all, pass === 'typed'));
  writeFileSync(file, text);
  return { pass, file, text };
});

let status = 0;
for (const { pass, file } of passes) {
  const run = spawnSync(
    process.execPath,
    [
      '--max-old-space-size=4096',
      ESLINT,
      '--suppressions-location',
      file,
      ...process.argv.slice(2),
    ],
    { stdio: 'inherit', env: { ...process.env, LINT_PASS: pass } },
  );
  status = Math.max(status, run.status ?? 2);
}

const after = passes.map(({ file }) => readFileSync(file, 'utf8'));
if (after.some((text, i) => text !== passes[i].text)) {
  const merged = {};
  for (const text of after) {
    for (const [file, rules] of Object.entries(JSON.parse(text))) {
      merged[file] = { ...merged[file], ...rules };
    }
  }
  writeFileSync(SUPPRESSIONS, stringify(merged));
}
rmSync(dir, { recursive: true, force: true });
process.exit(status);
